import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(args, cwd) {
  const result = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return result.stdout.trim();
}

function gitInput(args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git ${args[0]} exited with ${code}`));
    });
    child.stdin.end(input ?? '');
  });
}

async function objectFormat(repo) {
  const format = await git(['rev-parse', '--show-object-format'], repo).catch(() => 'sha1');
  return format === 'sha256' ? 'sha256' : 'sha1';
}

async function emptyTree(repo) {
  // The empty-tree id is object-format dependent. Ask git instead of hard-coding
  // the SHA-1 constant so `git init --object-format=sha256` repositories work.
  return gitInput(['hash-object', '-t', 'tree', '--stdin'], repo, '');
}

async function resolveCommit(repo, ref) {
  try {
    return await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo);
  } catch {
    return '';
  }
}

async function repoHasCommits(repo) {
  const count = await git(['rev-list', '--all', '--count'], repo).catch(() => '0');
  return Number(count) > 0;
}

async function assertValidBranchName(repo, name) {
  if (!name || name.startsWith('-')) throw new Error(`invalid worktree base ref: ${name}`);
  try {
    await git(['check-ref-format', `refs/heads/${name}`], repo);
  } catch {
    throw new Error(`invalid worktree base ref: ${name}`);
  }
}

async function createEmptyBaseCommit(repo, base) {
  // An empty commit is deliberate: committing untracked project files would
  // leak local data and can be huge. It gives worktree isolation a valid base
  // without touching the working tree. -c keeps this independent of a
  // machine-global git identity.
  const tree = await emptyTree(repo);
  const commit = await git([
    '-c', 'user.name=Ai-Agent-Teams',
    '-c', 'user.email=ai-agent-teams@local.invalid',
    'commit-tree', tree,
    '-m', `agent-teams: empty baseline for ${base}`,
  ], repo);
  let refName;
  if (base === 'HEAD') {
    const branch = await git(['symbolic-ref', '--short', 'HEAD'], repo).catch(() => '');
    if (!branch) throw new Error('cannot create a baseline: HEAD is detached and no base branch is configured');
    refName = `refs/heads/${branch}`;
  } else {
    refName = `refs/heads/${base}`;
  }
  const created = await createRefIfAbsent({ repo, ref: refName, commit });
  if (created) return { commit, created: true };
  const existing = await resolveCommit(repo, refName);
  return { commit: existing || commit, created: false };
}

/**
 * Create a ref only if it does not exist. Two concurrent dispatchers may both
 * see a missing ref; the all-zero old value makes the second writer fail
 * instead of overwriting the first commit (which would later produce
 * "no merge base"). Returns false when another writer already won.
 * @param {{ repo: string, ref: string, commit: string }} input
 * @returns {Promise<boolean>}
 */
export async function createRefIfAbsent({ repo, ref, commit }) {
  const zero = '0'.repeat((await objectFormat(repo)) === 'sha256' ? 64 : 40);
  try {
    await git(['update-ref', ref, commit, zero], repo);
    return true;
  } catch (error) {
    if (await resolveCommit(repo, ref)) return false;
    // A concurrent writer may still hold the ref lock for a few milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (await resolveCommit(repo, ref)) return false;
    throw error;
  }
}

/**
 * Resolve a worktree base without silently inventing history on a non-empty
 * repository. An empty repository gets an empty baseline ref so dispatch can
 * start; a repository with commits but a missing base fails with an actionable
 * error instead of retrying every task attempt.
 * @param {{ repo: string, base?: string }} input
 * @returns {Promise<{ base: string, ref: string, commit: string, created: boolean }>}
 */
export async function ensureWorktreeBase({ repo, base = 'HEAD' }) {
  const wanted = String(base || 'HEAD').trim();
  if (wanted !== 'HEAD') await assertValidBranchName(repo, wanted);
  const existing = await resolveCommit(repo, wanted);
  if (existing) return { base: wanted, ref: wanted, commit: existing, created: false };
  if (await repoHasCommits(repo)) {
    throw new Error(`worktree base ref not found: ${wanted}; create it or set the team baseBranch`);
  }
  if (wanted === 'HEAD') {
    const branch = await git(['symbolic-ref', '--short', 'HEAD'], repo).catch(() => '');
    if (!branch) throw new Error('cannot create a baseline: HEAD is detached and no base branch is configured');
    await assertValidBranchName(repo, branch);
  }
  const created = await createEmptyBaseCommit(repo, wanted);
  return { base: wanted, ref: wanted, commit: created.commit, created: created.created };
}

/**
 * @param {{ repo: string, path: string, branch: string, base?: string, onBaseCreated?: Function }} input
 * @returns {Promise<string>}
 */
export async function createWorktree({ repo, path, branch, base = 'HEAD', detached = false, onBaseCreated }) {
  const resolved = await ensureWorktreeBase({ repo, base });
  if (resolved.created) onBaseCreated?.(resolved);
  // Use the resolved commit, not the symbolic name: a task branch based on
  // "HEAD" would otherwise diff against itself and report no changed paths.
  await git(detached ? ['worktree', 'add', '--detach', path, resolved.commit]
    : ['worktree', 'add', '-b', branch, path, resolved.commit], repo);
  return path;
}

/**
 * @param {{ repo: string, path: string, force?: boolean }} input
 * @returns {Promise<void>}
 */
export async function removeWorktree({ repo, path, force = true }) {
  await git(['worktree', 'remove', ...(force ? ['--force'] : []), path], repo);
}

/**
 * @param {string} repo
 * @returns {Promise<Array<{ path: string, branch: string, head: string }>>}
 */
export async function listWorktrees(repo) {
  const output = await git(['worktree', 'list', '--porcelain'], repo);
  const entries = [];
  let current = {};
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }
  if (current.path) entries.push(current);
  return entries;
}

/**
 * Copy modified and untracked files from a superseded worktree into a fresh
 * retry worktree. Without this a retry silently starts from the base commit and
 * loses the previous attempt's uncommitted work.
 *
 * @param {{ from: string, to: string, maxBytes?: number }} input
 * @returns {Promise<{ copied: number, deleted: number, skipped: number }>}
 */
export async function copyUncommittedChanges({ from, to, maxBytes = 20 * 1024 * 1024 }) {
  if (!from || !to || from === to || !existsSync(from) || !existsSync(to)) {
    return { copied: 0, deleted: 0, skipped: 0 };
  }
  const ignored = /(^|\/)(\.git|node_modules|dist|build|target|\.venv|coverage|\.cache)(\/|$)/;
  // Do not trim: porcelain -z entries begin with a status column, and trimming
  // the leading space would shift the path by one character for " M" entries.
  let raw = '';
  try {
    const result = await exec('git', ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '-uall'], {
      cwd: from,
      maxBuffer: 32 * 1024 * 1024,
    });
    raw = result.stdout;
  } catch {
    return { copied: 0, deleted: 0, skipped: 0 };
  }
  const entries = raw.split('\0').filter(Boolean);
  let copied = 0;
  let deleted = 0;
  let skipped = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // In -z mode a rename is "XY new\0old\0"; the new path is the one to copy.
    if (code[0] === 'R' || code[0] === 'C') index += 1;
    if (!path || ignored.test(path)) continue;
    const source = join(from, path);
    const target = join(to, path);
    if (code.includes('D')) {
      rmSync(target, { force: true });
      deleted += 1;
      continue;
    }
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      skipped += 1;
      continue;
    }
    if (!stat.isFile() || stat.size > maxBytes) {
      skipped += 1;
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied += 1;
  }
  return { copied, deleted, skipped };
}

/**
 * @param {{ repo: string, path: string, commands: string[] }} input
 * @returns {Promise<Array<any>>}
 */
export async function verifyInWorktree({ repo: _repo, path, commands }) {
  const { runVerify } = await import('../gates/verify.mjs');
  return runVerify({ cwd: path, commands });
}
