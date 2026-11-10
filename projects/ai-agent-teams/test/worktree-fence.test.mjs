import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorktreeFenceProvider } from '../src/git/worktree-fence.mjs';

test('worktree fence binds the owner, detects external changes and is reacquirable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-fence-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'a.txt'), 'member change\n');
    const provider = createWorktreeFenceProvider();
    const input = { worktree: root, base, teamId: 'alpha', taskId: 't1', attemptId: 'a1' };
    const fence = await provider.acquire(input);
    assert.equal(fence.state, 'frozen');
    assert.equal(fence.proof.length, 64);
    assert.equal(await fence.verify(), true);
    writeFileSync(join(root, 'external.txt'), 'external\n');
    assert.equal(await fence.verify(), false);
    await fence.release();
    assert.equal(await fence.verify(), false);
    const again = await provider.acquire(input);
    assert.equal(await again.verify(), true);
    await again.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the fence lock is per physical worktree, not per attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-fence-lock-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'a.txt'), 'member change\n');
    const provider = createWorktreeFenceProvider();
    const first = await provider.acquire({ worktree: root, base, teamId: 'alpha', taskId: 't1', attemptId: 'a1' });
    await assert.rejects(
      () => provider.acquire({ worktree: root, base, teamId: 'alpha', taskId: 't1', attemptId: 'a2' }),
      (error) => error.code === 'E_ARTIFACT_FENCE',
    );
    await first.release();
    const second = await provider.acquire({ worktree: root, base, teamId: 'alpha', taskId: 't2', attemptId: 'a2' });
    await second.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the fence requires the expected commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-fence-commit-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'a.txt'), 'member change\n');
    const provider = createWorktreeFenceProvider();
    const fence = await provider.acquire({ worktree: root, base, teamId: 'alpha', taskId: 't3', attemptId: 'a3' });
    git('add', 'a.txt');
    git('commit', '-m', 'member commit');
    const memberCommit = git('rev-parse', 'HEAD');
    fence.expectCommit(memberCommit);
    assert.equal(await fence.verify(), true);
    // An external commit after the inspected artifact moves HEAD past the
    // expected commit; the clean-tree branch must not accept it.
    writeFileSync(join(root, 'external.txt'), 'external\n');
    git('add', 'external.txt');
    git('commit', '-m', 'external commit');
    assert.equal(await fence.verify(), false, 'HEAD must equal the commit inspected by this attempt');
    await fence.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the fence fingerprint includes untracked file contents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-fence-untracked-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'draft.txt'), 'first content\n');
    const provider = createWorktreeFenceProvider();
    const fence = await provider.acquire({ worktree: root, base, teamId: 'alpha', taskId: 't2', attemptId: 'a2' });
    assert.equal(await fence.verify(), true);
    // Same path and same status (still untracked), different content.
    writeFileSync(join(root, 'draft.txt'), 'replaced content\n');
    assert.equal(await fence.verify(), false, 'untracked content replacement must break the fence');
    await fence.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
