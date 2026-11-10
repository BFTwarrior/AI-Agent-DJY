// The mutating git steps: init, local config, staging, verification, commit.
//
// Three invariants drive the shape of this module.
//
// 1. Only a repository this call created may be removed later, so
//    `initRepository` re-checks that `.git` was absent immediately before init
//    and present immediately after, and returns `created: true` only then.
//    Rollback reads that value and never probes the filesystem, because a
//    concurrent process could have created `.git` in between.
//
// 2. Staging is explicit and verified. Every path handed to `git add` is
//    re-`lstat`ed and its size/dev/ino compared against the identity captured at
//    planning time, so a file replaced by a symlink or rewritten in the
//    meantime is refused instead of committed. After adding, `git ls-files -s`
//    must list exactly the planned paths at stage 0 with mode 100644/100755 —
//    that is what excludes symlinks, submodules and conflicted entries. A second
//    check on the whole index catches anything staged from outside this batch.
//
// 3. The first commit is reproducible. Identity, `commit.gpgsign=false`,
//    `--no-verify` (no user hook may change the baseline) and `--allow-empty`
//    are passed on the command line, so a repository-local or global config
//    cannot alter the result.

import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import { ADD_BATCH_BYTES, ADD_BATCH_FILES, COMMIT_MESSAGE } from './contract.mjs';
import { GitBootstrapError } from './errors.mjs';
import { compareCodePoints, hasGitEntry, isWin32 } from './fs-primitives.mjs';
import { runGit, supportsInitialBranch } from './git-command.mjs';

export async function initRepository(root, gitCommand, version) {
  if (hasGitEntry(root)) {
    throw new GitBootstrapError(
      'GIT_BOOTSTRAP_FAILED',
      'a .git entry appeared before init; refusing to initialize over a repository this process did not create',
    );
  }
  if (supportsInitialBranch(version)) {
    await runGit(['init', '-b', 'main'], root, { gitCommand });
  } else {
    // Git < 2.28 has no `-b`; set the branch explicitly instead of matching
    // localized stderr text.
    await runGit(['init'], root, { gitCommand });
    await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], root, { gitCommand });
  }
  if (!hasGitEntry(root)) {
    throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', 'git init did not create a .git entry');
  }
  // The caller may only roll back a repository created by this call.
  return { created: true };
}

/**
 * Write the repository-local settings the baseline depends on.
 *
 * `core.autocrlf=false` keeps bytes identical across platforms,
 * `core.longpaths` lets a deep workspace be added on Windows, and
 * `core.ignorecase` mirrors the filesystem so git does not merge `.js`/`.JS`.
 * An existing local identity is preserved; the default is written only when the
 * repository has none.
 */
export async function configureRepository(root, authorName, authorEmail, gitCommand) {
  await runGit(['config', '--local', 'core.autocrlf', 'false'], root, { gitCommand });
  await runGit(['config', '--local', 'core.longpaths', 'true'], root, { gitCommand });
  await runGit(['config', '--local', 'core.ignorecase', isWin32() ? 'true' : 'false'], root, { gitCommand });
  const name = await runGit(['config', '--local', '--get', 'user.name'], root, { gitCommand, allowedExitCodes: [0, 1] });
  if (!name.stdout.trim()) await runGit(['config', '--local', 'user.name', authorName], root, { gitCommand });
  const email = await runGit(['config', '--local', '--get', 'user.email'], root, { gitCommand, allowedExitCodes: [0, 1] });
  if (!email.stdout.trim()) await runGit(['config', '--local', 'user.email', authorEmail], root, { gitCommand });
}

/**
 * Drop planned paths that the resulting `.gitignore` now excludes.
 *
 * This runs after the managed block is written, so a planned file can be
 * excluded by rules the bootstrap itself just added. Removing it here keeps the
 * index check from failing on a file that was never supposed to be committed.
 */
export async function filterGitIgnored(root, paths, gitCommand) {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return { kept: [], ignored: [] };
  const input = unique.map((path) => `${path}\0`).join('');
  // Exit code 1 means "nothing is ignored", not an error.
  const result = await runGit(['check-ignore', '-z', '--stdin'], root, {
    input,
    allowedExitCodes: [0, 1],
    gitCommand,
  });
  const ignored = new Set(result.stdout.split('\0').filter(Boolean));
  return {
    kept: unique.filter((path) => !ignored.has(path)),
    ignored: unique.filter((path) => ignored.has(path)),
  };
}

function lstatEntry(root, entry) {
  let stat;
  try {
    stat = lstatSync(join(root, entry.path));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { missing: true };
    throw new GitBootstrapError(
      error.code === 'EACCES' || error.code === 'EPERM' ? 'GIT_PERMISSION' : 'GIT_BOOTSTRAP_FAILED',
      `cannot inspect ${entry.path} before add: ${error.message}`,
    );
  }
  return { stat };
}

/**
 * Compare a planned entry with the file on disk right before it is added.
 *
 * Size, device and inode must all match: size alone misses a same-size
 * replacement, and the two ids together detect a file swapped behind the same
 * path. A vanished file degrades to a warning — the baseline simply does not
 * contain a file that no longer exists — while a type or identity change is a
 * hard failure.
 *
 * @returns {boolean} whether the entry may still be added
 */
export function assertEntryUnchanged(root, entry, warnings) {
  const current = lstatEntry(root, entry);
  if (current.missing) {
    warnings.push(`file disappeared before add: ${entry.path}`);
    return false;
  }
  const { stat } = current;
  if (stat.isSymbolicLink()) {
    throw new GitBootstrapError(
      'GIT_BOOTSTRAP_FAILED',
      `refusing to add ${entry.path}: it became a symbolic link after planning`,
    );
  }
  if (!stat.isFile()) {
    throw new GitBootstrapError(
      'GIT_BOOTSTRAP_FAILED',
      `refusing to add ${entry.path}: it is no longer a regular file`,
    );
  }
  if (entry.size !== undefined && stat.size !== entry.size) {
    throw new GitBootstrapError(
      'GIT_BOOTSTRAP_FAILED',
      `refusing to add ${entry.path}: size changed from ${entry.size} to ${stat.size} bytes after planning`,
    );
  }
  if (entry.dev !== undefined && stat.dev !== entry.dev) {
    throw new GitBootstrapError(
      'GIT_BOOTSTRAP_FAILED',
      `refusing to add ${entry.path}: the file was replaced (device changed) after planning`,
    );
  }
  if (entry.ino !== undefined && stat.ino !== entry.ino) {
    throw new GitBootstrapError(
      'GIT_BOOTSTRAP_FAILED',
      `refusing to add ${entry.path}: the file was replaced (inode changed) after planning`,
    );
  }
  return true;
}

export function parseLsFiles(output) {
  const records = output.split('\0').filter(Boolean);
  const staged = [];
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab === -1) {
      throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', 'cannot parse `git ls-files -s` output');
    }
    const header = record.slice(0, tab);
    const path = record.slice(tab + 1);
    const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d)$/u.exec(header);
    if (!match) {
      throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', `unexpected \`git ls-files -s\` header: ${header}`);
    }
    staged.push({ mode: match[1], object: match[2], stage: Number(match[3]), path });
  }
  return staged;
}

/**
 * Prove that the index contains exactly `expectedPaths`, all at stage 0.
 *
 * Modes other than 100644/100755 are refused: 120000 is a symlink and 160000 a
 * submodule, and neither may enter a baseline this module creates.
 */
export async function verifyStagedEntries(root, expectedPaths, gitCommand) {
  const result = await runGit(['ls-files', '-s', '-z', '--', ...expectedPaths], root, { gitCommand });
  const staged = parseLsFiles(result.stdout);
  const stagedPaths = staged.map((entry) => entry.path).sort(compareCodePoints);
  const expected = [...expectedPaths].sort(compareCodePoints);
  if (stagedPaths.length !== expected.length
    || stagedPaths.some((path, index) => path !== expected[index])) {
    throw new GitBootstrapError(
      'GIT_BOOTSTRAP_FAILED',
      'the staged file list differs from the planned list; refusing to commit',
      { expected, staged: stagedPaths },
    );
  }
  for (const entry of staged) {
    if (entry.stage !== 0) {
      throw new GitBootstrapError(
        'GIT_BOOTSTRAP_FAILED',
        `refusing to commit ${entry.path}: it is staged at index stage ${entry.stage}`,
      );
    }
    if (entry.mode !== '100644' && entry.mode !== '100755') {
      throw new GitBootstrapError(
        'GIT_BOOTSTRAP_FAILED',
        `refusing to commit ${entry.path}: unexpected file mode ${entry.mode} (symlinks and submodules are not allowed)`,
      );
    }
  }
  return staged;
}

/**
 * Add the planned entries in small batches and verify each batch.
 *
 * Batching keeps the command line well below the platform limit on Windows,
 * where 200 paths of moderate length already approach it. Verification happens
 * per batch so a rejected entry names the batch that contained it, and nothing
 * is added after the first failure.
 *
 * @returns {Promise<string[]>} the paths actually added
 */
export async function addFiles(root, entries, gitCommand, warnings) {
  let batch = [];
  let bytes = 0;
  const added = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const verified = batch.filter((entry) => assertEntryUnchanged(root, entry, warnings));
    if (verified.length > 0) {
      await runGit(['add', '--', ...verified.map((entry) => entry.path)], root, { gitCommand });
      await verifyStagedEntries(root, verified.map((entry) => entry.path), gitCommand);
      added.push(...verified.map((entry) => entry.path));
    }
    batch = [];
    bytes = 0;
  };
  for (const entry of entries) {
    const size = Buffer.byteLength(entry.path) + 1;
    if (batch.length > 0 && (batch.length >= ADD_BATCH_FILES || bytes + size > ADD_BATCH_BYTES)) {
      await flush();
    }
    batch.push(entry);
    bytes += size;
  }
  await flush();
  return added;
}

/**
 * Prove the whole index matches the plan before committing.
 *
 * The per-batch check only covers the paths this call added. This one catches
 * anything staged by another process or by a hook, which is the difference
 * between "we added the right files" and "the commit contains only them".
 */
export async function verifyIndexMatches(root, expectedPaths, gitCommand) {
  const result = await runGit(['ls-files', '-z'], root, { gitCommand });
  const staged = result.stdout.split('\0').filter(Boolean).sort(compareCodePoints);
  const expected = [...expectedPaths].sort(compareCodePoints);
  if (staged.length !== expected.length || staged.some((path, index) => path !== expected[index])) {
    throw new GitBootstrapError(
      'GIT_BOOTSTRAP_FAILED',
      'the index contains files outside the planned baseline; refusing to commit',
      { expected, staged },
    );
  }
}

/**
 * Create the baseline commit and report its identity.
 *
 * `HEAD^{tree}` is read back so the marker can bind the tree, not just the
 * commit id: a later amend that kept the message would change the commit but
 * not the tree, and the marker must describe what was actually committed.
 */
export async function commitBaseline(root, { authorName, authorEmail, gitCommand }) {
  await runGit([
    '-c', `user.name=${authorName}`,
    '-c', `user.email=${authorEmail}`,
    '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '--no-verify', '-m', COMMIT_MESSAGE,
  ], root, { gitCommand });
  const head = await runGit(['rev-parse', 'HEAD'], root, { gitCommand });
  const tree = await runGit(['rev-parse', 'HEAD^{tree}'], root, { gitCommand });
  return { commit: head.stdout.trim(), tree: tree.stdout.trim() };
}
