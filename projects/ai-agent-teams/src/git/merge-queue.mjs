import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lstatSync, realpathSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Best-effort synchronous ancestry probe used when writing the delivery
 * receipt. Returns null when the question cannot be answered (no repo or an
 * invalid object id), so callers can distinguish "not an ancestor" from
 * "cannot check".
 */
export function isAncestorCommit(repo, ancestor, descendant) {
  if (typeof repo !== 'string' || !repo || typeof ancestor !== 'string' || typeof descendant !== 'string'
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(ancestor) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(descendant)) {
    return null;
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch (error) {
    return error?.status === 1 ? false : null;
  }
}

/**
 * Whether `repo` is an actual git work tree: true, false for a directory git
 * explicitly rejects, or null when git itself could not answer (missing
 * binary, permission/IO error). Callers must not treat null as "no git".
 */
export function isGitRepository(repo) {
  if (typeof repo !== 'string' || !repo) return false;
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    const stderr = String(error?.stderr ?? '');
    if (/not a git repository|not a git work tree/i.test(stderr)) return false;
    return null;
  }
}

async function isAncestorRef(repo, ancestor, descendant) {
  try {
    await git(['merge-base', '--is-ancestor', ancestor, descendant], repo);
    return true;
  } catch (error) {
    return error?.code === 1 || error?.status === 1 ? false : null;
  }
}

async function git(args, cwd) {
  const result = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return result.stdout.trim();
}

async function gitBytes(args, cwd) {
  const result = await exec('git', args, { cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  return result.stdout;
}

function applyPatch(worktree, patch) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['apply', '--index', '--3way', '-'], { cwd: worktree, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-65536); });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `git apply exited ${code}`)));
    child.stdin.end(patch);
  });
}

async function isCommit(repo, commit) {
  if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return false;
  try {
    return (await git(['rev-parse', '--verify', `${commit}^{commit}`], repo)) === commit;
  } catch {
    return false;
  }
}

/**
 * Apply the complete artifact range to a private worktree based on a fixed target commit.
 * The caller owns persistence/publication and must not infer success from the source tip.
 * This helper does not authenticate artifact.digest or provide durable recovery.
 * @param {{ repo: string, artifact: { base: string, tip: string, digest?: string }, branch: string, targetBase: string }} input
 */
export async function integrateDeliveryArtifact({ repo, artifact, branch, targetBase }) {
  let worktree;
  let stage = 'validation';
  try {
    if (typeof branch !== 'string' || !branch || branch.startsWith('-')) {
      return { ok: false, blocked: true, reason: 'invalid_branch' };
    }
    try {
      await git(['check-ref-format', '--branch', branch], repo);
    } catch {
      return { ok: false, blocked: true, reason: 'invalid_branch' };
    }
    if (!artifact || !await isCommit(repo, artifact.base) || !await isCommit(repo, artifact.tip)
      || !await isCommit(repo, targetBase)) {
      return { ok: false, blocked: true, reason: 'artifact_base_missing' };
    }
    try {
      await git(['merge-base', '--is-ancestor', artifact.base, artifact.tip], repo);
      await git(['merge-base', '--is-ancestor', artifact.base, targetBase], repo);
    } catch {
      return { ok: false, blocked: true, reason: 'artifact_fork' };
    }
    const patch = await gitBytes(['diff', '--no-ext-diff', '--binary', '--full-index', '--no-renames', artifact.base, artifact.tip, '--'], repo);
    if (!patch.length) return { ok: false, blocked: true, reason: 'empty_artifact_requires_captain' };
    const safeName = String(branch ?? 'artifact').replace(/[^A-Za-z0-9._-]/g, '_');
    worktree = join(tmpdir(), `ai-agent-teams-artifact-${safeName}-${randomUUID()}`);
    stage = 'worktree';
    await git(['worktree', 'add', '-b', branch, worktree, targetBase], repo);
    stage = 'apply';
    await applyPatch(worktree, patch);
    stage = 'commit';
    await git(['-c', 'user.name=AI Agent Teams', '-c', 'user.email=ai-agent-teams@localhost',
      'commit', '-m', `Integrate delivery artifact ${artifact.base.slice(0, 12)}..${artifact.tip.slice(0, 12)}`], worktree);
    const commit = await git(['rev-parse', 'HEAD'], worktree);
    const ownershipEvidence = {
      token: randomUUID(), branch, worktree: realpathSync.native(worktree),
      refOid: await git(['rev-parse', `refs/heads/${branch}`], repo),
    };
    return { ok: true, commit, sourceCommit: artifact.tip, branch, worktree, targetBase, artifactDigest: artifact.digest, ownershipEvidence };
  } catch (error) {
    // Keep the private worktree available for diagnosis; never reset or resolve a conflict automatically.
    let conflict = false;
    if (stage === 'apply' && worktree) {
      try {
        conflict = Boolean(await git(['ls-files', '--unmerged'], worktree));
      } catch {
        // Preserve the original apply failure; inability to inspect is not proof of a conflict.
      }
    }
    return { ok: false, conflict, stage, error: error instanceof Error ? error.message : String(error), worktree };
  }
}

/**
 * Commit all changes in a task worktree. Returns no-commit when the tree is clean.
 * @param {{ worktree: string, message: string }} input
 */
export async function commitWorktree({ worktree, message }) {
  const status = await git(['status', '--porcelain'], worktree);
  if (!status) return { ok: false, reason: 'no changes' };
  await git(['add', '-A'], worktree);
  await git(['commit', '-m', message], worktree);
  const commit = await git(['rev-parse', 'HEAD'], worktree);
  return { ok: true, commit };
}

/** Return the current HEAD of a worktree without modifying it. */
export async function headCommit(worktree) {
  return git(['rev-parse', 'HEAD'], worktree);
}

/** Tip of a local branch, or null when the branch does not exist. */
export async function integrationBranchTip(repo, branch) {
  if (typeof branch !== 'string' || !branch) return null;
  try {
    return await git(['rev-parse', '--verify', `refs/heads/${branch}`], repo);
  } catch (error) {
    const stderr = String(error?.stderr ?? '');
    // Only a ref that git explicitly says does not exist may be reported as
    // null. A missing binary, permission error or IO failure must stay
    // distinguishable from "the branch was never created".
    if (/unknown revision|not a valid object name|needed a single revision|bad revision|not a git repository/i.test(stderr)) {
      return null;
    }
    throw error;
  }
}

/** HEAD of an existing worktree, or null when it is gone/unreadable. */
export async function integrationWorktreeHead(worktree) {
  if (typeof worktree !== 'string' || !worktree) return null;
  try {
    return await git(['rev-parse', 'HEAD'], worktree);
  } catch {
    return null;
  }
}

/** Merge base of two commits, or null when it cannot be resolved. */
export async function mergeBaseCommit(repo, left, right) {
  if (!repo || !left || !right) return null;
  try {
    return await git(['merge-base', left, right], repo);
  } catch {
    return null;
  }
}

/**
 * Normalized diff digest for a commit range. Used to prove that a recovered
 * integration branch contains exactly the reviewed artifact, rather than an
 * empty branch created before the patch was applied.
 */
export async function rangeDiffDigest(repo, from, to) {
  if (!repo || !from || !to) return null;
  try {
    const bytes = await gitBytes(['diff', '--no-ext-diff', '--binary', '--full-index', '--no-renames', from, to, '--'], repo);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

/** True when the worktree has uncommitted changes. */
export async function worktreeDirty(worktree) {
  return Boolean(await git(['status', '--porcelain'], worktree));
}

/**
 * Cherry-pick one commit into the integration checkout. Conflicts are aborted,
 * never force-resolved.
 * @param {{ repo: string, commit: string }} input
 */
export async function mergeCommit({ repo, commit, base, branch }) {
  if (base !== undefined) {
    try {
      if (!await isCommit(repo, base) || !await isCommit(repo, commit)) {
        return { ok: false, error: 'artifact base or tip is missing' };
      }
      if (branch !== undefined) {
        const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
        if (current !== branch) return { ok: false, error: `repository is on ${current}, not ${branch}` };
      }
      await git(['merge-base', '--is-ancestor', base, commit], repo);
      const paths = (await git(['diff', '--name-only', '--no-renames', '-z', base, commit], repo))
        .split('\0').filter(Boolean);
      const patch = await gitBytes(['diff', '--no-ext-diff', '--binary', '--full-index', '--no-renames', base, commit, '--'], repo);
      if (patch.length) await applyPatch(repo, patch);
      const staged = await git(['diff', '--cached', '--name-only'], repo);
      if (staged) {
        // Commit only the paths from this artifact. Pre-staged unrelated files
        // in the operator's checkout must not enter the delivery commit.
        await git(['-c', 'user.name=AI Agent Teams', '-c', 'user.email=ai-agent-teams@localhost',
          'commit', '-m', `Integrate delivery artifact ${base.slice(0, 12)}..${commit.slice(0, 12)}`, '--', ...paths], repo);
      }
      return { ok: true, commit: await git(['rev-parse', 'HEAD'], repo), sourceCommit: commit };
    } catch (error) {
      try {
        await git(['reset', '--merge'], repo);
      } catch {
        // best effort: never force-resolve or discard a conflict
      }
      return { ok: false, conflict: true, error: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    await git(['cherry-pick', commit], repo);
    return { ok: true, commit };
  } catch (error) {
    try {
      await git(['cherry-pick', '--abort'], repo);
    } catch {
      // best effort
    }
    return { ok: false, conflict: true, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param {{ repo: string, worktree: string, message: string }} input
 */
export async function mergeWorktree({ repo, worktree, message }) {
  const committed = await commitWorktree({ worktree, message });
  if (!committed.ok) return committed;
  return mergeCommit({ repo, commit: committed.commit });
}

/**
 * Revert a merge commit. Used by post-merge review rejection.
 * @param {{ repo: string, commit: string }} input
 */
export async function revertCommit({ repo, commit }) {
  try {
    await git(['revert', '--no-edit', commit], repo);
    return { ok: true, commit };
  } catch (error) {
    try {
      await git(['revert', '--abort'], repo);
    } catch {
      // best effort
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve a revert receipt and prove what it actually reverts.
 *
 * A receipt is usable only when exactly one commit on the target branch
 * carries the operation trailer, that commit's message names `appliedCommit`
 * as the reverted object, and the receipt is an ancestor of the target. Any
 * ambiguity is reported instead of guessed.
 */
export async function resolveRevertReceipt({ repo, key, target = 'HEAD', appliedCommit } = {}) {
  if (typeof key !== 'string' || !key.trim()) return { status: 'none' };
  try {
    const found = await git(['log', target, '--fixed-strings', '--format=%H',
      '--grep', `Negative-Merge-Key: ${key}`, '--'], repo);
    const hits = found.split(/\r?\n/).filter(Boolean);
    if (hits.length === 0) return { status: 'none' };
    if (hits.length > 1) return { status: 'ambiguous', commits: hits };
    const commit = hits[0];
    const body = await git(['show', '-s', '--format=%B', commit], repo);
    const lines = body.split(/\r?\n/);
    if (!lines.includes(`Negative-Merge-Key: ${key}`)) return { status: 'mismatch', commit };
    if (appliedCommit) {
      const reverted = body.match(/^This reverts commit ([0-9a-f]{40}(?:[0-9a-f]{24})?)\.?$/m);
      if (!reverted || reverted[1] !== appliedCommit) {
        return { status: 'object_mismatch', commit, expected: appliedCommit, actual: reverted?.[1] };
      }
    }
    const onTarget = await isAncestorRef(repo, commit, target);
    if (onTarget !== true) return { status: 'not_on_target', commit };
    return { status: 'found', commit };
  } catch (error) {
    // A lookup error is not "no receipt". Treating it as none would replay a
    // side effect whose proof is temporarily unreadable.
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Backwards-compatible helper: return the receipt commit only when it is
 * unambiguous and proves the requested object. Callers that need the reason
 * use resolveRevertReceipt.
 */
export async function findRevertReceipt({ repo, key, target, appliedCommit } = {}) {
  const resolved = await resolveRevertReceipt({ repo, key, target, appliedCommit });
  if (resolved.status === 'found') return resolved.commit;
  if (resolved.status === 'none') return null;
  // Ambiguous, mismatched or unreadable receipts are not "no receipt".
  throw Object.assign(
    new Error(`cannot prove the existing revert receipt (${resolved.status}); manual reconciliation required`),
    { code: 'E_REVERT_RECEIPT', receiptStatus: resolved.status, commits: resolved.commits },
  );
}

async function cleanupFailedRevert(repo) {
  try {
    await git(['revert', '--abort'], repo);
  } catch {
    // --no-commit does not always create a sequencer to abort.
  }
  let unmerged = '';
  try {
    unmerged = await git(['diff', '--name-only', '--diff-filter=U'], repo);
  } catch {
    return false;
  }
  if (unmerged) {
    try {
      await git(['reset', '--merge', 'HEAD'], repo);
    } catch {
      return false;
    }
    try {
      unmerged = await git(['diff', '--name-only', '--diff-filter=U'], repo);
    } catch {
      return false;
    }
  }
  return unmerged === '';
}

/**
 * Idempotent rollback keyed by the negative intent operation id. Retrying the
 * same operation returns the original revert commit instead of creating a
 * second one; a crash after the Git step is recoverable by trailer lookup.
 */
export async function revertCommitOnce({ repo, commit, key, target = 'HEAD' }) {
  const existing = await resolveRevertReceipt({ repo, key, target, appliedCommit: commit });
  if (existing.status === 'found') return { ok: true, commit: existing.commit, alreadyReverted: true };
  if (existing.status !== 'none') {
    return { ok: false, code: 'E_REVERT_RECEIPT', receiptStatus: existing.status,
      error: `cannot prove the existing revert receipt (${existing.status}); manual reconciliation required` };
  }
  try {
    // `git revert --no-commit` stages its changes; a later plain `git commit`
    // would also include anything the operator had already staged. Refuse to
    // create a receipt from a dirty index.
    const staged = await git(['diff', '--cached', '--name-only'], repo);
    if (staged) {
      return { ok: false, code: 'E_REPO_DIRTY',
        error: 'the repository index has staged changes; refusing to mix them into a revert receipt' };
    }
    const parents = (await git(['rev-list', '--parents', '-n', '1', commit], repo)).split(/\s+/).filter(Boolean);
    if (parents.length > 2) {
      return { ok: false, code: 'E_REVERT_MERGE_COMMIT',
        error: 'reverting a merge commit requires an explicit mainline and is not automated' };
    }
    const subject = await git(['show', '-s', '--format=%s', commit], repo);
    await git(['revert', '--no-commit', commit], repo);
    await git(['-c', 'user.name=AI Agent Teams', '-c', 'user.email=ai-agent-teams@localhost',
      'commit', '-m', `Revert "${subject}"\n\nThis reverts commit ${commit}.\n\nNegative-Merge-Key: ${key}`], repo);
    const head = await git(['rev-parse', 'HEAD'], repo);
    return { ok: true, commit: head, alreadyReverted: false };
  } catch (error) {
    const clean = await cleanupFailedRevert(repo);
    return { ok: false, error: error instanceof Error ? error.message : String(error),
      retryable: clean, workingTreeClean: clean };
  }
}

async function branchExists(repo, branch) {
  try {
    await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

/**
 * Cherry-pick a commit into an integration branch using a temporary worktree.
 * The target branch is never main; main is only fast-forwarded after review.
 * @param {{ repo: string, commit: string, branch: string, base?: string }} input
 */
export function integrationWorktreePath(branch, operationId) {
  if (typeof branch !== 'string' || typeof operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(operationId)) {
    throw new Error('invalid integration operation identity');
  }
  const safeName = branch.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(tmpdir(), `ai-agent-teams-${safeName}-${operationId}`);
}

export async function mergeCommitToBranch({ repo, commit, branch, base = 'HEAD', operationId = randomUUID(), artifactBase }) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) {
    return { ok: false, blocked: true, needsCaptain: true, error: 'invalid integration branch' };
  }
  let worktree;
  let created = false;
  let branchHasArtifact = false;
  try {
    worktree = integrationWorktreePath(branch, operationId);
    try { await git(['check-ref-format', '--branch', branch], repo); } catch {
      return { ok: false, blocked: true, needsCaptain: true, error: 'invalid integration branch' };
    }
    if (await branchExists(repo, branch)) {
      return { ok: false, blocked: true, needsCaptain: true, error: 'integration branch already exists; ownership requires reconciliation' };
    }
    if (artifactBase !== undefined) {
      // A repair commit's parent is the previous delivery commit, not the
      // target branch. Cherry-picking it would publish only the repair delta
      // and silently drop the rest of the reviewed delivery.
      if (!await isCommit(repo, artifactBase) || !await isCommit(repo, commit)) {
        return { ok: false, blocked: true, needsCaptain: true, error: 'artifact base or tip is missing' };
      }
      try {
        await git(['merge-base', '--is-ancestor', artifactBase, commit], repo);
        await git(['merge-base', '--is-ancestor', artifactBase, base], repo);
      } catch {
        return { ok: false, blocked: true, needsCaptain: true, error: 'artifact range is not a descendant of the target base' };
      }
    }
    await git(['worktree', 'add', '-b', branch, worktree, base], repo);
    created = true;
    if (artifactBase !== undefined) {
      const patch = await gitBytes(['diff', '--no-ext-diff', '--binary', '--full-index', '--no-renames', artifactBase, commit, '--'], repo);
      if (patch.length) await applyPatch(worktree, patch);
      const staged = await git(['diff', '--cached', '--name-only'], worktree);
      if (staged) {
        await git(['-c', 'user.name=AI Agent Teams', '-c', 'user.email=ai-agent-teams@localhost',
          'commit', '-m', `Integrate delivery artifact ${artifactBase.slice(0, 12)}..${commit.slice(0, 12)}`], worktree);
      }
    } else {
      await git(['cherry-pick', commit], worktree);
    }
    const integratedCommit = await git(['rev-parse', 'HEAD'], worktree);
    branchHasArtifact = true;
    const ownershipEvidence = {
      token: operationId, operationId, canonicalRepo: realpathSync.native(repo), branch, worktree: realpathSync.native(worktree),
      refOid: await git(['rev-parse', `refs/heads/${branch}`], repo),
    };
    return { ok: true, commit: integratedCommit, sourceCommit: commit, branch, worktree, ownershipEvidence,
      alreadyIntegrated: integratedCommit === base && artifactBase !== undefined };
  } catch (error) {
    if (created) {
      try {
        await git(['cherry-pick', '--abort'], worktree);
      } catch {
        // best effort
      }
      try {
        await git(['worktree', 'remove', '--force', worktree], repo);
      } catch {
        // best effort
      }
      if (!branchHasArtifact) {
        // A failed apply/cherry-pick created a deterministic branch name; it
        // must not block the next retry after the worktree is gone.
        try {
          await git(['update-ref', '-d', `refs/heads/${branch}`], repo);
        } catch {
          // best effort
        }
      }
    }
    return { ok: false, conflict: true, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Fast-forward the current target branch to an integration branch.
 * @param {{ repo: string, branch: string, target?: string }} input
 */
export async function fastForwardBranch({ repo, branch, target = 'main', expectedCommit }) {
  try {
    const targetRef = `refs/heads/${target}`;
    const currentRef = await git(['symbolic-ref', '-q', 'HEAD'], repo).catch(() => '');
    if (currentRef !== targetRef) {
      const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
      return { ok: false, error: `repository is on ${current}, not ${target}` };
    }
    if (expectedCommit !== undefined) {
      if (typeof expectedCommit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedCommit)) {
        return { ok: false, error: 'expectedCommit must be a full commit object ID' };
      }
      const resolved = await git(['rev-parse', '--verify', `${expectedCommit}^{commit}`], repo);
      if (resolved !== expectedCommit) {
        return { ok: false, error: 'expectedCommit must be a full commit object ID' };
      }
      const ancestor = await git(['merge-base', '--is-ancestor', expectedCommit, branch], repo).then(() => true).catch(() => false);
      if (!ancestor) return { ok: false, error: `branch ${branch} does not contain ${expectedCommit}` };
    }
    const newTarget = expectedCommit ?? await git(['rev-parse', '--verify', `${branch}^{commit}`], repo);
    const oldTarget = await git(['rev-parse', '--verify', targetRef], repo);
    const canFastForward = await git(['merge-base', '--is-ancestor', oldTarget, newTarget], repo)
      .then(() => true, () => false);
    if (!canFastForward) return { ok: false, error: `target ${target} is not an ancestor of the published commit` };
    // reset --hard is part of the checked-out sync; never discard local work.
    const dirty = await git(['status', '--porcelain', '--untracked-files=no'], repo);
    if (dirty) return { ok: false, error: 'target repository has uncommitted changes' };
    // Compare-and-swap the explicit target ref. `git merge` acts on whatever
    // branch is current after the awaits, so an external checkout could push
    // another branch and still return success.
    try {
      await git(['update-ref', targetRef, newTarget, oldTarget], repo);
    } catch (error) {
      return { ok: false, error: `target ${target} changed concurrently or could not be updated: ${error instanceof Error ? error.message : String(error)}` };
    }
    // A checked-out branch also needs its worktree/index moved. The publication
    // itself already succeeded at the ref level; a sync failure is reported but
    // must not be retried as a new fast-forward.
    let worktreeSynced = false;
    try {
      const stillTarget = await git(['symbolic-ref', '-q', 'HEAD'], repo).catch(() => '');
      if (stillTarget === targetRef) {
        // The ref moved but the checkout still sits at the old commit, so a
        // post-CAS `git status` is dirty by construction. The tracked-dirty
        // check above is the only loss guard; a writer that appears in this
        // narrow window can still be overwritten by the reset.
        await git(['reset', '--hard', newTarget], repo);
        worktreeSynced = true;
      }
    } catch {
      worktreeSynced = false;
    }
    return { ok: true, branch, target, commit: newTarget, worktreeSynced };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Discard a captain-confirmed-not-applied integration artifact. This is only
 * called after an explicit `applied:false` decision; it removes the registered
 * worktree and deletes the branch at its current tip.
 */
export async function discardIntegrationArtifact({ repo, branch, worktree }) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) {
    return { ok: false, error: 'valid branch name is required' };
  }
  try {
    let pathStat;
    try { pathStat = worktree ? lstatSync(worktree) : undefined; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (pathStat) {
      if (pathStat.isSymbolicLink()) throw new Error(`refusing to remove symbolic link: ${worktree}`);
      const requestedPath = realpathSync.native(worktree);
      const listed = (await git(['worktree', 'list', '--porcelain'], repo)).split(/\r?\n\r?\n/);
      const registered = listed.find((entry) => {
        const path = entry.split(/\r?\n/).find((line) => line.startsWith('worktree '))?.slice(9);
        try { return path && realpathSync.native(path) === requestedPath; } catch { return false; }
      });
      if (!registered || !registered.split(/\r?\n/).includes(`branch refs/heads/${branch}`)) {
        throw new Error('worktree is not registered for this integration branch');
      }
      await git(['worktree', 'remove', '--force', requestedPath], repo);
    }
    // Deleting a ref that another registered worktree still has checked out
    // orphans that checkout. Refuse and let the caller discard that worktree
    // explicitly instead.
    const holders = (await git(['worktree', 'list', '--porcelain'], repo))
      .split(/\r?\n\r?\n/)
      .filter((entry) => entry.split(/\r?\n/).includes(`branch refs/heads/${branch}`));
    if (holders.length > 0) {
      throw new Error('integration branch is still checked out in a registered worktree');
    }
    try {
      const refOid = await git(['rev-parse', '--verify', `refs/heads/${branch}`], repo);
      await git(['update-ref', '-d', `refs/heads/${branch}`, refOid], repo);
    } catch (error) {
      // Only an actually missing ref is idempotent success. Lock/permission/
      // IO/OID races must preserve ownership so the caller can retry.
      const missing = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo)
        .then(() => false, (lookup) => lookup?.code === 1);
      if (!missing) throw error;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove the temporary integration worktree and optionally delete the branch.
 * @param {{ repo: string, worktree: string, branch: string, keepBranch?: boolean }} input
 */
export async function cleanupIntegration({ repo, worktree, branch, keepBranch = false, ownershipEvidence }) {
  try {
    if (typeof worktree !== 'string' || !worktree) throw new Error('worktree path is required');
    if (typeof branch !== 'string' || !branch || branch.startsWith('-')) throw new Error('valid branch name is required');
    if (!ownershipEvidence || typeof ownershipEvidence.token !== 'string' || !ownershipEvidence.token
      || ownershipEvidence.branch !== branch || typeof ownershipEvidence.worktree !== 'string'
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ownershipEvidence.refOid ?? '')) {
      throw new Error('integration ownership evidence is missing or invalid; preserving worktree and branch');
    }
    if (ownershipEvidence.canonicalRepo && realpathSync.native(repo) !== ownershipEvidence.canonicalRepo) {
      throw new Error('integration ownership repository does not match; preserving worktree and branch');
    }
    let pathStat;
    try { pathStat = lstatSync(worktree); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pathStat) {
      if (pathStat.isSymbolicLink()) throw new Error(`refusing to remove symbolic link: ${worktree}`);
      const requestedPath = realpathSync.native(worktree);
      const listed = (await git(['worktree', 'list', '--porcelain'], repo)).split(/\r?\n\r?\n/);
      const registered = listed.find((entry) => {
        const path = entry.split(/\r?\n/).find((line) => line.startsWith('worktree '))?.slice(9);
        try { return path && realpathSync.native(path) === requestedPath; } catch { return false; }
      });
      if (!registered) throw new Error(`refusing to remove path that is not a worktree of this repository: ${worktree}`);
      if (!registered.split(/\r?\n/).includes(`branch refs/heads/${branch}`)
        || realpathSync.native(worktree) !== realpathSync.native(ownershipEvidence.worktree)) {
        throw new Error('integration worktree branch does not match the requested branch');
      }
      const refOid = await git(['rev-parse', '--verify', `refs/heads/${branch}`], repo);
      if (refOid !== ownershipEvidence.refOid) throw new Error('integration branch ref changed; preserving worktree and branch');
      await git(['worktree', 'remove', '--force', requestedPath], repo);
    }
    if (!keepBranch) {
      const exists = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo).then(() => true, (error) => {
        if (error.code === 1) return false;
        throw error;
      });
      if (exists && !pathStat) {
        throw new Error(`cannot delete branch without its registered integration worktree: ${branch}`);
      }
      if (exists) {
        const refOid = await git(['rev-parse', '--verify', `refs/heads/${branch}`], repo);
        if (refOid !== ownershipEvidence.refOid) throw new Error('integration branch ref changed; preserving branch');
        await git(['update-ref', '-d', `refs/heads/${branch}`, ownershipEvidence.refOid], repo);
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
