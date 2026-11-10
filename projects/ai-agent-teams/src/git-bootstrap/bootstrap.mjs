// The bootstrap transaction: inspect, plan, preflight, mutate, report.
//
// Every phase before the lock is read-only, so a refusal costs nothing and the
// workspace is untouched. The mutation phase then runs entirely under the lock
// and re-inspects first, because a concurrent bootstrap may have finished while
// this call waited — in that case the correct answer is the "skipped" result,
// not a second commit.
//
// Failure handling is the reason this file is long, and it is deliberately
// explicit:
// - validation failures and inspection blockers return `failureResult` without
//   ever taking the lock or touching the tree;
// - secret findings block before any mutation, so nothing is created and no
//   rollback is needed;
// - a failure inside the transaction rolls back exactly what this call did and
//   reports `rolledBack`, then the lock is released in `finally`;
// - a marker write failure after a successful commit is a warning, never a
//   rollback: the commit is valid and deleting the repository to "clean up" a
//   reporting problem would destroy the user's baseline.
//
// The dry run stops before the lock and before any git command. Its file list is
// therefore explicitly provisional: `.gitignore` filtering and the plan/add
// re-validation only happen during a real bootstrap.

import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  DEFAULT_AUTHOR_EMAIL,
  DEFAULT_AUTHOR_NAME,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_SECRET_SCAN_BYTES,
  DEFAULT_STALE_LOCK_MS,
  GIT_BOOTSTRAP_MARKER,
  GIT_BOOTSTRAP_VERSION,
  MARKER_IGNORED_LIMIT,
} from './contract.mjs';
import { GitBootstrapError, bootstrapErrorCode, errorEntry, failureResult } from './errors.mjs';
import { compareCodePoints, compareIgnored, mergeRisks, relativePosix, resolveWorkspace } from './fs-primitives.mjs';
import { inspectProject } from './inspect.mjs';
import { planBootstrap } from './plan.mjs';
import { readGitignore, upsertGitignoreBlock, writeGitignoreAtomically } from './gitignore.mjs';
import { acquireBootstrapLock, releaseBootstrapLock } from './lock.mjs';
import { readBootstrapMarker, totalSize, writeBootstrapMarker } from './marker.mjs';
import { rollbackBootstrap } from './rollback.mjs';
import { parseGitVersion, runGit } from './git-command.mjs';
import {
  addFiles,
  commitBaseline,
  configureRepository,
  filterGitIgnored,
  initRepository,
  verifyIndexMatches,
} from './repository.mjs';

function normalizeAuthor(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Report the "already a repository" result, shared by the pre-lock and
 * under-lock re-inspection paths so both answer identically.
 */
function skippedResult({ root, marker, inspection, warnings, dryRun }) {
  return {
    ok: true,
    code: null,
    status: 'git',
    repoRoot: root,
    dryRun,
    skipped: true,
    alreadyBootstrapped: marker !== null,
    commit: marker?.commit ?? null,
    tree: marker?.tree ?? null,
    marker: marker ? `.git/${GIT_BOOTSTRAP_MARKER}` : null,
    errors: [],
    warnings,
    risks: inspection.risks,
  };
}

/**
 * Bootstrap a git repository in a workspace that passed inspectProject.
 *
 * The first call creates `.git`, appends a managed block to `.gitignore`, adds
 * only the planned files, commits the baseline and writes
 * `.git/agent-teams-bootstrap.json`. A second call on the same workspace is a
 * no-op: `skipped` is true and the original commit is returned.
 *
 * Concurrency: the mutation phase is guarded by
 * `.ai-agent-teams/git-bootstrap.lock`, acquired with O_EXCL. The lock is
 * released on every path; stale locks are reclaimed after `staleLockMs`.
 *
 * Scope note: secret content detection is a *bounded* scan of the first
 * `secretScanBytes` bytes of each candidate file. It is a safety net, not a
 * full secret scanner; see the design document and ADR-0019.
 *
 * @param {{
 *   cwd?: string,
 *   dryRun?: boolean,
 *   authorName?: string,
 *   authorEmail?: string,
 *   include?: string[],
 *   exclude?: string[],
 *   maxFileBytes?: number,
 *   maxTotalBytes?: number,
 *   maxEntries?: number,
 *   secretScanBytes?: number,
 *   lockTimeoutMs?: number,
 *   staleLockMs?: number,
 *   gitCommand?: string
 * }} [input]
 */
export async function bootstrapGit({
  cwd = process.cwd(),
  dryRun = false,
  authorName = DEFAULT_AUTHOR_NAME,
  authorEmail = DEFAULT_AUTHOR_EMAIL,
  include,
  exclude,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxEntries = DEFAULT_MAX_ENTRIES,
  secretScanBytes = DEFAULT_SECRET_SCAN_BYTES,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  gitCommand = 'git',
} = {}) {
  const isDryRun = Boolean(dryRun);
  const warnings = [];
  const name = normalizeAuthor(authorName);
  const email = normalizeAuthor(authorEmail);
  // The identity reaches a git command line, so a newline would inject another
  // argument and a blank value would make the commit author unusable.
  if (!name || !email || /[\r\n]/u.test(`${name}${email}`)) {
    return failureResult({
      code: 'GIT_BOOTSTRAP_FAILED',
      message: 'authorName and authorEmail must be non-empty single-line strings',
      warnings,
      dryRun: isDryRun,
    });
  }
  const waitLimit = Number(lockTimeoutMs);
  if (!Number.isInteger(waitLimit) || waitLimit <= 0) {
    return failureResult({
      code: 'GIT_BOOTSTRAP_FAILED',
      message: 'lockTimeoutMs must be a positive integer',
      warnings,
      dryRun: isDryRun,
    });
  }
  const staleLimit = Number(staleLockMs);
  if (!Number.isInteger(staleLimit) || staleLimit <= 0) {
    return failureResult({
      code: 'GIT_BOOTSTRAP_FAILED',
      message: 'staleLockMs must be a positive integer',
      warnings,
      dryRun: isDryRun,
    });
  }

  let root;
  try {
    root = resolveWorkspace(cwd);
  } catch (error) {
    return failureResult({
      code: bootstrapErrorCode(error),
      message: error.message,
      warnings,
      dryRun: isDryRun,
    });
  }

  let inspection;
  try {
    inspection = inspectProject({ cwd: root, maxEntries });
  } catch (error) {
    return failureResult({
      code: bootstrapErrorCode(error),
      message: error.message,
      warnings,
      dryRun: isDryRun,
    });
  }
  warnings.push(...inspection.warnings);

  if (inspection.status === 'git') {
    return skippedResult({
      root,
      marker: readBootstrapMarker(root),
      inspection,
      warnings,
      dryRun: isDryRun,
    });
  }
  if (inspection.code) {
    return failureResult({
      code: inspection.code,
      message: inspection.errors[0]?.message ?? `cannot bootstrap ${root}`,
      errors: inspection.errors,
      warnings,
      status: inspection.status,
      repoRoot: inspection.repoRoot,
      parentRepo: inspection.parentRepo,
      risks: inspection.risks,
      dryRun: isDryRun,
    });
  }

  let plan;
  try {
    plan = planBootstrap({ cwd: root, include, exclude, maxFileBytes, maxEntries, secretScanBytes });
  } catch (error) {
    return failureResult({
      code: bootstrapErrorCode(error),
      message: error.message,
      warnings,
      risks: [],
      dryRun: isDryRun,
      repoRoot: root,
    });
  }
  warnings.push(...plan.warnings);
  plan.risks = mergeRisks(inspection.risks, plan.risks);
  if (plan.truncated) {
    warnings.push('the scan was truncated; the baseline does not contain every file in the workspace');
  }
  // Secret findings block the bootstrap before the lock is taken, so the
  // workspace is never mutated and no rollback is required.
  if (plan.contentSecrets.length > 0) {
    const paths = plan.contentSecrets.map((item) => item.path).slice(0, 20);
    return failureResult({
      code: 'GIT_SECRETS_FOUND',
      message: `source files contain secret material: ${paths.join(', ')}`,
      warnings,
      repoRoot: root,
      risks: plan.risks,
      contentSecrets: plan.contentSecrets,
      truncated: plan.truncated,
      dryRun: isDryRun,
    });
  }
  if (plan.requestedSecrets.length > 0) {
    return failureResult({
      code: 'GIT_SECRETS_FOUND',
      message: `refusing to commit explicitly included secret(s): ${plan.requestedSecrets.join(', ')}`,
      warnings,
      repoRoot: root,
      risks: plan.risks,
      truncated: plan.truncated,
      dryRun: isDryRun,
    });
  }
  if (plan.secrets.length > 0) {
    warnings.push(`excluded ${plan.secrets.length} sensitive file(s) from the baseline commit`);
  }
  if (plan.largeFiles.length > 0) {
    warnings.push(`excluded ${plan.largeFiles.length} file(s) larger than ${plan.maxFileBytes} bytes`);
  }
  if (plan.nestedRepos.length > 0) {
    return failureResult({
      code: 'GIT_NESTED_REPO',
      message: `nested git repositories found: ${plan.nestedRepos.join(', ')}`,
      warnings,
      repoRoot: root,
      risks: plan.risks,
      truncated: plan.truncated,
      dryRun: isDryRun,
    });
  }
  const totalLimit = Number(maxTotalBytes);
  if (!Number.isFinite(totalLimit) || totalLimit <= 0) {
    return failureResult({
      code: 'GIT_BOOTSTRAP_FAILED',
      message: 'maxTotalBytes must be a positive number',
      warnings,
      repoRoot: root,
      risks: plan.risks,
      dryRun: isDryRun,
    });
  }
  if (plan.totalBytes > totalLimit) {
    return failureResult({
      code: 'GIT_TOO_LARGE',
      message: `planned baseline is ${plan.totalBytes} bytes, above the ${totalLimit} byte limit`,
      warnings,
      repoRoot: root,
      risks: plan.risks,
      truncated: plan.truncated,
      dryRun: isDryRun,
    });
  }

  if (isDryRun) {
    warnings.push('dryRun file list is provisional: .gitignore filtering and file re-validation happen during bootstrap');
    return {
      ok: true,
      code: null,
      status: 'would-bootstrap',
      repoRoot: root,
      dryRun: true,
      provisional: true,
      branch: 'main',
      files: plan.files,
      fileCount: plan.fileCount,
      ignored: plan.ignored,
      ignoredCount: plan.ignored.length,
      secrets: plan.secrets,
      largeFiles: plan.largeFiles,
      totalBytes: plan.totalBytes,
      codeLines: plan.codeLines,
      codeLinesApproximate: plan.codeLinesApproximate,
      truncated: plan.truncated,
      risks: plan.risks,
      marker: `.git/${GIT_BOOTSTRAP_MARKER}`,
      warnings,
    };
  }

  let gitVersionText;
  let gitVersion;
  try {
    const versionResult = await runGit(['--version'], root, { gitCommand });
    gitVersionText = versionResult.stdout.trim();
    gitVersion = parseGitVersion(gitVersionText);
  } catch (error) {
    return failureResult({
      code: error.code === 'GIT_REQUIRED' ? 'GIT_REQUIRED' : 'GIT_BOOTSTRAP_FAILED',
      message: error.message,
      warnings,
      repoRoot: root,
      risks: plan.risks,
      dryRun: false,
    });
  }

  let originalGitignore;
  let lock = null;
  let gitCreated = false;
  let gitignoreWritten = false;
  try {
    lock = await acquireBootstrapLock(root, {
      waitMs: waitLimit,
      staleMs: staleLimit,
      warnings,
    });

    // Re-inspect under the lock: a concurrent bootstrap may have finished while
    // this call waited.
    const second = inspectProject({ cwd: root, maxEntries });
    if (second.status === 'git') {
      return skippedResult({
        root,
        marker: readBootstrapMarker(root),
        inspection: second,
        warnings,
        dryRun: false,
      });
    }
    if (second.code) {
      return failureResult({
        code: second.code,
        message: second.errors[0]?.message ?? `cannot bootstrap ${root}`,
        errors: second.errors,
        warnings,
        status: second.status,
        repoRoot: second.repoRoot,
        parentRepo: second.parentRepo,
        risks: second.risks,
        dryRun: false,
      });
    }

    // Read `.gitignore` under the lock so a concurrent writer cannot make this
    // call roll back to content it never observed.
    try {
      originalGitignore = readGitignore(root);
    } catch (error) {
      return failureResult({
        code: bootstrapErrorCode(error),
        message: error.message,
        warnings,
        repoRoot: root,
        risks: plan.risks,
        dryRun: false,
      });
    }

    const initialized = await initRepository(root, gitCommand, gitVersion);
    gitCreated = initialized.created === true;
    await configureRepository(root, name, email, gitCommand);

    const nextGitignore = upsertGitignoreBlock(originalGitignore.content);
    if (!originalGitignore.exists || nextGitignore !== originalGitignore.content) {
      writeGitignoreAtomically(root, nextGitignore, originalGitignore.mode ?? 0o644);
      gitignoreWritten = true;
    }

    const ignored = [...plan.ignored];
    // `.gitignore` is added explicitly: it is the one file this module writes
    // rather than one it planned, and it is always part of the baseline.
    const planned = plan.files.filter((path) => path !== '.gitignore');
    planned.push('.gitignore');
    planned.sort(compareCodePoints);
    const filtered = await filterGitIgnored(root, planned, gitCommand);
    const kept = [...filtered.kept].sort(compareCodePoints);
    const ignoredByGit = filtered.ignored.map((path) => ({ path, reason: 'gitignore' }));
    if (ignoredByGit.length > 0) {
      warnings.push(`${ignoredByGit.length} planned file(s) are excluded by .gitignore`);
    }
    ignored.push(...ignoredByGit);
    ignored.sort(compareIgnored);

    // Re-capture `.gitignore`'s identity after the atomic rewrite, so the
    // plan/add re-validation compares against the file that actually exists.
    const entryByPath = new Map(plan.entries.map((entry) => [entry.path, entry]));
    const gitignoreStat = lstatSync(join(root, '.gitignore'));
    entryByPath.set('.gitignore', {
      path: '.gitignore',
      size: gitignoreStat.size,
      dev: gitignoreStat.dev,
      ino: gitignoreStat.ino,
      mtimeMs: gitignoreStat.mtimeMs,
    });
    const addEntries = kept.map((path) => {
      const entry = entryByPath.get(path);
      if (!entry) {
        throw new GitBootstrapError(
          'GIT_BOOTSTRAP_FAILED',
          `no planned identity for ${path}; refusing to add a file that was not inspected`,
        );
      }
      return entry;
    });

    await addFiles(root, addEntries, gitCommand, warnings);
    await verifyIndexMatches(root, kept, gitCommand);

    const { commit, tree } = await commitBaseline(root, { authorName: name, authorEmail: email, gitCommand });
    const gitDir = (await runGit(['rev-parse', '--absolute-git-dir'], root, { gitCommand })).stdout.trim();
    const filesSha256 = createHash('sha256').update(kept.join('\n')).digest('hex');
    const committedBytes = totalSize(root, kept);
    const markerPayload = {
      version: GIT_BOOTSTRAP_VERSION,
      createdAt: new Date().toISOString(),
      branch: 'main',
      commit,
      tree,
      author: { name, email },
      fileCount: kept.length,
      totalBytes: committedBytes,
      codeLines: plan.codeLines,
      codeLinesApproximate: plan.codeLinesApproximate,
      ignoredCount: ignored.length,
      ignored: ignored.slice(0, MARKER_IGNORED_LIMIT),
      ignoredTruncated: ignored.length > MARKER_IGNORED_LIMIT,
      secretCount: plan.secrets.length,
      secrets: plan.secrets,
      contentSecretCount: plan.contentSecrets.length,
      largeFileCount: plan.largeFiles.length,
      largeFiles: plan.largeFiles,
      nestedRepos: plan.nestedRepos,
      risks: plan.risks,
      truncated: plan.truncated,
      filesSha256,
      gitVersion: gitVersionText,
      nodeVersion: process.version,
    };
    let markerWritten = true;
    let markerPath = null;
    try {
      markerPath = writeBootstrapMarker(gitDir, markerPayload);
    } catch (error) {
      markerWritten = false;
      warnings.push(`could not write bootstrap marker: ${error.message}`);
    }
    // `git rev-parse` can expand Windows 8.3 temp paths to their long form, so
    // only trust the relative form when it stays inside the workspace.
    const relativeMarker = markerPath ? relativePosix(root, markerPath) : '';
    const marker = relativeMarker && !relativeMarker.startsWith('../') && !isAbsolute(relativeMarker)
      ? relativeMarker
      : `.git/${GIT_BOOTSTRAP_MARKER}`;

    return {
      ok: true,
      code: null,
      status: 'bootstrapped',
      repoRoot: root,
      branch: 'main',
      commit,
      tree,
      dryRun: false,
      skipped: false,
      files: kept,
      fileCount: kept.length,
      ignored,
      ignoredCount: ignored.length,
      secrets: plan.secrets,
      contentSecrets: plan.contentSecrets,
      largeFiles: plan.largeFiles,
      risks: plan.risks,
      totalBytes: committedBytes,
      codeLines: plan.codeLines,
      codeLinesApproximate: plan.codeLinesApproximate,
      truncated: plan.truncated,
      marker,
      markerWritten,
      markerVersion: GIT_BOOTSTRAP_VERSION,
      warnings,
    };
  } catch (error) {
    const code = bootstrapErrorCode(error);
    const rolledBack = rollbackBootstrap({
      root,
      // Only the value returned by initRepository may authorize deletion.
      gitCreated,
      gitignoreWritten,
      originalGitignore,
    });
    return failureResult({
      code,
      message: error.message,
      errors: [errorEntry(code, error.message, error.stderr ? { stderr: error.stderr } : {})],
      warnings,
      repoRoot: root,
      risks: plan.risks,
      dryRun: false,
      rolledBack,
    });
  } finally {
    releaseBootstrapLock(lock);
  }
}
