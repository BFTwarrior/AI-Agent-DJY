import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRefIfAbsent, createWorktree, copyUncommittedChanges, ensureWorktreeBase, listWorktrees, removeWorktree } from '../src/git/worktree.mjs';

test('worktree create, list and remove', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-git-'));
  try {
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });

    const path = join(root, 'worktree');
    await createWorktree({ repo: root, path, branch: 'agent/test', base: 'HEAD' });
    assert.equal(existsSync(join(path, 'a.txt')), true);
    const entries = await listWorktrees(root);
    assert.ok(entries.length >= 2);
    await removeWorktree({ repo: root, path });
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detached review worktree stays at the requested source commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-review-worktree-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'reviewed');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'reviewed'], { cwd: root });
    const reviewed = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(join(root, 'a.txt'), 'newer');
    execFileSync('git', ['commit', '-am', 'newer'], { cwd: root });
    const path = join(root, 'review');
    await createWorktree({ repo: root, path, base: reviewed, detached: true });
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim(), reviewed);
    assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim(), 'HEAD');
    assert.equal(readFileSync(join(path, 'a.txt'), 'utf8'), 'reviewed');
    await removeWorktree({ repo: root, path });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retry worktree receives the previous attempt uncommitted changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-git-preserve-'));
  try {
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    writeFileSync(join(root, 'gone.txt'), 'bye', 'utf8');
    execFileSync('git', ['add', 'a.txt', 'gone.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });

    const from = join(root, 'attempt-1');
    const to = join(root, 'attempt-2');
    await createWorktree({ repo: root, path: from, branch: 'agent/retry/1', base: 'HEAD' });
    await createWorktree({ repo: root, path: to, branch: 'agent/retry/2', base: 'HEAD' });

    writeFileSync(join(from, 'a.txt'), 'changed', 'utf8');
    mkdirSync(join(from, 'nested'), { recursive: true });
    writeFileSync(join(from, 'nested', 'new.txt'), 'new', 'utf8');
    rmSync(join(from, 'gone.txt'));
    mkdirSync(join(from, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(from, 'node_modules', 'pkg', 'index.js'), 'ignored', 'utf8');

    const result = await copyUncommittedChanges({ from, to });
    assert.equal(result.copied, 2);
    assert.equal(result.deleted, 1);
    assert.equal(readFileSync(join(to, 'a.txt'), 'utf8'), 'changed');
    assert.equal(readFileSync(join(to, 'nested', 'new.txt'), 'utf8'), 'new');
    assert.equal(existsSync(join(to, 'gone.txt')), false);
    assert.equal(existsSync(join(to, 'node_modules')), false);
    await removeWorktree({ repo: root, path: from });
    await removeWorktree({ repo: root, path: to });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty repository gets an empty baseline ref for the configured base', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-git-empty-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: root });
    const path = join(root, 'worktree');
    let created;
    await createWorktree({
      repo: root,
      path,
      branch: 'agent/empty',
      base: 'main',
      onBaseCreated: (info) => { created = info; },
    });
    assert.equal(created?.created, true);
    assert.equal(created?.base, 'main');
    assert.equal(existsSync(path), true);
    const head = execFileSync('git', ['rev-parse', '--verify', 'main'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(head, created?.commit);
    await removeWorktree({ repo: root, path });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HEAD resolves to a commit so the worktree base is not symbolic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-git-head-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const resolved = await ensureWorktreeBase({ repo: root, base: 'HEAD' });
    assert.equal(resolved.created, false);
    assert.equal(resolved.commit, head);
    const path = join(root, 'worktree');
    await createWorktree({ repo: root, path, branch: 'agent/head', base: 'HEAD' });
    assert.equal(existsSync(join(path, 'a.txt')), true);
    await removeWorktree({ repo: root, path });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a second baseline writer cannot overwrite an existing ref', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-git-race-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'one'], { cwd: root });
    const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['commit', '--allow-empty', '-m', 'two'], { cwd: root });
    const second = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.notEqual(first, second);

    // This is the exact primitive the baseline uses. The old plain
    // `git update-ref <ref> <sha>` returned true here and silently replaced the
    // first commit, which later produced `no merge base`.
    assert.equal(await createRefIfAbsent({ repo: root, ref: 'refs/heads/main', commit: first }), true);
    assert.equal(await createRefIfAbsent({ repo: root, ref: 'refs/heads/main', commit: second }), false);
    const ref = execFileSync('git', ['rev-parse', '--verify', 'main'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(ref, first);
    // Both callers still end up on the winning commit.
    const resolved = await ensureWorktreeBase({ repo: root, base: 'main' });
    assert.equal(resolved.commit, first);
    assert.equal(resolved.created, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the empty baseline never commits staged or untracked project files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-git-secret-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: root });
    writeFileSync(join(root, 'secret.txt'), 'token', 'utf8');
    execFileSync('git', ['add', 'secret.txt'], { cwd: root });
    const resolved = await ensureWorktreeBase({ repo: root, base: 'main' });
    const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', resolved.commit], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(tree, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repository with commits on another branch is not treated as empty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-git-orphan-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    execFileSync('git', ['checkout', '--orphan', 'other'], { cwd: root });
    await assert.rejects(
      ensureWorktreeBase({ repo: root, base: 'HEAD' }),
      /worktree base ref not found: HEAD/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid base ref is rejected before git is asked to create it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-git-invalid-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: root });
    await assert.rejects(
      ensureWorktreeBase({ repo: root, base: '--upload-pack=x' }),
      /invalid worktree base ref/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a SHA-256 repository gets an object-format-correct empty baseline', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-git-sha256-'));
  try {
    try {
      execFileSync('git', ['init', '--object-format=sha256', '-b', 'master'], { cwd: root, stdio: 'ignore' });
    } catch {
      t.skip('git does not support --object-format=sha256');
      return;
    }
    const resolved = await ensureWorktreeBase({ repo: root, base: 'main' });
    assert.equal(resolved.commit.length, 64);
    const path = join(root, 'worktree');
    await createWorktree({ repo: root, path, branch: 'agent/sha256', base: 'main' });
    assert.equal(existsSync(path), true);
    await removeWorktree({ repo: root, path });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a non-empty repository with a missing base fails before dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-git-nobase-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    await assert.rejects(
      ensureWorktreeBase({ repo: root, base: 'main' }),
      /worktree base ref not found: main/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
