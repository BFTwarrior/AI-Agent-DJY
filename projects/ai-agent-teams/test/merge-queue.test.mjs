import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorktree } from '../src/git/worktree.mjs';
import { cleanupIntegration, discardIntegrationArtifact, fastForwardBranch, findRevertReceipt, integrateDeliveryArtifact, integrationBranchTip, isGitRepository, mergeCommit, mergeCommitToBranch, mergeWorktree, resolveRevertReceipt, revertCommitOnce } from '../src/git/merge-queue.mjs';

test('merge queue commits a worktree and cherry-picks it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-merge-'));
  try {
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    const worktree = join(root, 'wt');
    await createWorktree({ repo: root, path: worktree, branch: 'agent/test', base: 'HEAD' });
    writeFileSync(join(worktree, 'a.txt'), 'two', 'utf8');
    const result = await mergeWorktree({ repo: root, worktree, message: 'task change' });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'two');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration branch receives the cherry-pick before main fast-forwards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-integration-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    const worktree = join(root, 'wt');
    await createWorktree({ repo: root, path: worktree, branch: 'agent/test', base: 'HEAD' });
    writeFileSync(join(worktree, 'a.txt'), 'two', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: worktree });
    execFileSync('git', ['commit', '-m', 'task change'], { cwd: worktree });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    const integrated = await mergeCommitToBranch({ repo: root, commit, branch: 'integration', base: 'HEAD' });
    assert.equal(integrated.ok, true);
    assert.equal(readFileSync(join(integrated.worktree, 'a.txt'), 'utf8'), 'two');
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one');
    const ff = await fastForwardBranch({ repo: root, branch: 'integration', target: 'main' });
    assert.equal(ff.ok, true, ff.error);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'two');
    await cleanupIntegration({ repo: root, worktree: integrated.worktree, branch: 'integration', ownershipEvidence: integrated.ownershipEvidence });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing integration branch is held instead of being reused or changed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-existing-integration-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'base.txt'), 'base');
    git('add', '.');
    git('commit', '-m', 'base');
    git('branch', 'integration');
    const before = git('rev-parse', 'refs/heads/integration');
    for (const branch of [undefined, '-bad', 'bad..name']) {
      const invalid = await mergeCommitToBranch({ repo: root, commit: before, branch, base: 'HEAD' });
      assert.equal(invalid.ok, false);
      assert.equal(invalid.needsCaptain, true);
      assert.match(invalid.error, /invalid integration branch/);
    }
    const result = await mergeCommitToBranch({ repo: root, commit: before, branch: 'integration', base: 'HEAD' });
    assert.equal(result.ok, false);
    assert.equal(result.needsCaptain, true);
    assert.equal(git('rev-parse', 'refs/heads/integration'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup integration is successful and idempotent for an already removed worktree and branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-cleanup-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'base.txt'), 'base');
    git('add', '.');
    git('commit', '-m', 'base');
    git('branch', 'integration');
    const worktree = join(root, 'integration-worktree');
    git('worktree', 'add', worktree, 'integration');
    const integrationEvidence = { token: 'test-owned', branch: 'integration', worktree: worktree, refOid: git('rev-parse', 'refs/heads/integration') };
    assert.deepEqual(await cleanupIntegration({ repo: root, worktree, branch: 'integration', ownershipEvidence: integrationEvidence }), { ok: true });
    assert.equal(existsSync(worktree), false);
    assert.throws(() => git('show-ref', '--verify', '--quiet', 'refs/heads/integration'));
    assert.deepEqual(await cleanupIntegration({ repo: root, worktree, branch: 'integration', ownershipEvidence: integrationEvidence }), { ok: true });

    git('branch', 'retained');
    git('worktree', 'add', worktree, 'retained');
    const retainedEvidence = { token: 'test-owned-retained', branch: 'retained', worktree, refOid: git('rev-parse', 'refs/heads/retained') };
    assert.deepEqual(await cleanupIntegration({ repo: root, worktree, branch: 'retained', keepBranch: true, ownershipEvidence: retainedEvidence }), { ok: true });
    assert.equal(existsSync(worktree), false);
    git('show-ref', '--verify', '--quiet', 'refs/heads/retained');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup refuses a worktree symlink and stops on a locked worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-cleanup-locked-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'base.txt'), 'base');
    git('add', '.');
    git('commit', '-m', 'base');
    git('branch', 'integration');
    git('branch', 'preserve');
    const worktree = join(root, 'worktree');
    const link = join(root, 'link');
    git('worktree', 'add', worktree, 'integration');
    const integrationEvidence = { token: 'owned', branch: 'integration', worktree, refOid: git('rev-parse', 'refs/heads/integration') };
    symlinkSync(worktree, link, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await cleanupIntegration({ repo: root, worktree: link, branch: 'integration', ownershipEvidence: integrationEvidence });
    assert.equal(linked.ok, false);
    assert.equal(readFileSync(join(worktree, 'base.txt'), 'utf8'), 'base');
    git('show-ref', '--verify', '--quiet', 'refs/heads/preserve');

    git('worktree', 'lock', worktree);
    const mismatched = await cleanupIntegration({ repo: root, worktree, branch: 'preserve', ownershipEvidence: { ...integrationEvidence, branch: 'preserve' } });
    assert.equal(mismatched.ok, false);
    assert.match(mismatched.error, /branch does not match/);
    assert.equal(existsSync(worktree), true);
    git('show-ref', '--verify', '--quiet', 'refs/heads/preserve');
    const locked = await cleanupIntegration({ repo: root, worktree, branch: 'integration', ownershipEvidence: integrationEvidence });
    assert.equal(locked.ok, false);
    assert.match(locked.error, /locked/i);
    assert.equal(existsSync(worktree), true);
    git('show-ref', '--verify', '--quiet', 'refs/heads/preserve');
    git('worktree', 'unlock', worktree);
    git('worktree', 'remove', worktree);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup preserves an owned worktree when ownership proof is absent or its branch ref was replaced', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-cleanup-ref-race-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'base.txt'), 'base');
    git('add', '.');
    git('commit', '-m', 'base');
    git('branch', 'integration');
    const worktree = join(root, 'integration-worktree');
    git('worktree', 'add', worktree, 'integration');
    const missing = await cleanupIntegration({ repo: root, worktree, branch: 'integration' });
    assert.equal(missing.ok, false);
    assert.equal(existsSync(worktree), true);
    const evidence = { token: 'owned', branch: 'integration', worktree, refOid: git('rev-parse', 'refs/heads/integration') };
    git('commit', '--allow-empty', '-m', 'replacement');
    git('update-ref', 'refs/heads/integration', 'HEAD');
    const replaced = await cleanupIntegration({ repo: root, worktree, branch: 'integration', ownershipEvidence: evidence });
    assert.equal(replaced.ok, false);
    assert.match(replaced.error, /ref changed/);
    assert.equal(existsSync(worktree), true);
    assert.equal(git('rev-parse', 'refs/heads/integration') !== evidence.refOid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup reports show-ref errors other than a missing branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-cleanup-nonrepo-'));
  try {
    const worktree = join(root, 'absent');
    const result = await cleanupIntegration({ repo: root, worktree, branch: 'integration',
      ownershipEvidence: { token: 'owned', branch: 'integration', worktree, refOid: 'a'.repeat(40) } });
    assert.equal(result.ok, false);
    assert.match(result.error, /not a git repository/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup integration fails closed for unregistered physical paths and checked out branches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-cleanup-fail-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'base.txt'), 'base');
    git('add', '.');
    git('commit', '-m', 'base');
    git('switch', '-c', 'checked-out');
    const externalPath = join(root, 'ordinary-directory');
    mkdirSync(externalPath);
    writeFileSync(join(externalPath, 'keep.txt'), 'keep');

    const evidence = { token: 'not-authority', branch: 'checked-out', worktree: externalPath, refOid: git('rev-parse', 'refs/heads/checked-out') };
    const unregistered = await cleanupIntegration({ repo: root, worktree: externalPath, branch: 'checked-out', ownershipEvidence: evidence });
    assert.equal(unregistered.ok, false);
    assert.match(unregistered.error, /not a worktree/);
    assert.equal(readFileSync(join(externalPath, 'keep.txt'), 'utf8'), 'keep');
    const externalLink = join(root, 'external-link');
    symlinkSync(externalPath, externalLink, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await cleanupIntegration({ repo: root, worktree: externalLink, branch: 'checked-out', ownershipEvidence: evidence });
    assert.equal(linked.ok, false);
    assert.match(linked.error, /symbolic link/);
    assert.equal(readFileSync(join(externalPath, 'keep.txt'), 'utf8'), 'keep');

    const checkedOut = await cleanupIntegration({ repo: root, worktree: join(root, 'absent-worktree'), branch: 'checked-out', ownershipEvidence: { ...evidence, worktree: join(root, 'absent-worktree') } });
    assert.equal(checkedOut.ok, false);
    assert.match(checkedOut.error, /cannot delete branch without its registered integration worktree/);
    assert.equal(git('branch', '--show-current'), 'checked-out');
    git('branch', 'user-branch');
    const unrelated = await cleanupIntegration({ repo: root, worktree: join(root, 'absent-worktree'), branch: 'user-branch', ownershipEvidence: { ...evidence, branch: 'user-branch', refOid: git('rev-parse', 'refs/heads/user-branch'), worktree: join(root, 'absent-worktree') } });
    assert.equal(unrelated.ok, false);
    assert.match(unrelated.error, /without its registered integration worktree/);
    git('show-ref', '--verify', '--quiet', 'refs/heads/user-branch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fast-forward publishes only the reviewed commit when the branch advances', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-reviewed-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'base.txt'), 'base');
    git('add', 'base.txt');
    git('commit', '-m', 'base');
    git('switch', '-c', 'integration');
    writeFileSync(join(root, 'reviewed.txt'), 'reviewed');
    git('add', 'reviewed.txt');
    git('commit', '-m', 'reviewed');
    const reviewed = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'unreviewed.txt'), 'unreviewed');
    git('add', 'unreviewed.txt');
    git('commit', '-m', 'unreviewed');
    git('switch', 'main');
    const result = await fastForwardBranch({ repo: root, branch: 'integration', target: 'main', expectedCommit: reviewed });
    assert.equal(result.ok, true);
    assert.equal(git('rev-parse', 'HEAD'), reviewed);
    assert.equal(git('ls-tree', '--name-only', 'HEAD').includes('unreviewed.txt'), false);
    git('merge', '--ff-only', 'integration');
    const ahead = await fastForwardBranch({ repo: root, branch: 'integration', target: 'main', expectedCommit: reviewed });
    assert.equal(ahead.ok, false);
    const short = await fastForwardBranch({ repo: root, branch: 'integration', target: 'main', expectedCommit: reviewed.slice(0, 8) });
    assert.equal(short.ok, false);
    const empty = await fastForwardBranch({ repo: root, branch: 'integration', target: 'main', expectedCommit: '' });
    assert.equal(empty.ok, false);
    const nullCommit = await fastForwardBranch({ repo: root, branch: 'integration', target: 'main', expectedCommit: null });
    assert.equal(nullCommit.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delivery artifact integrates the cumulative base-to-tip patch on the fixed target base', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-artifact-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let integrationWorktree;
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'shared.txt'), 'original\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const artifactBase = git('rev-parse', 'HEAD');
    git('switch', '-c', 'implementation');
    writeFileSync(join(root, 'implementation.txt'), 'implementation\n');
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 255, 1, 2, 0, 254]));
    git('add', '.');
    git('commit', '-m', 'implementation');
    writeFileSync(join(root, 'repair.txt'), 'repair\n');
    git('add', '.');
    git('commit', '-m', 'repair');
    const artifactTip = git('rev-parse', 'HEAD');
    git('switch', 'main');
    writeFileSync(join(root, 'unrelated.txt'), 'keep me\n');
    git('add', '.');
    git('commit', '-m', 'unrelated target change');
    const targetBase = git('rev-parse', 'HEAD');
    git('config', 'diff.external', 'false');
    const invalidBranch = await integrateDeliveryArtifact({
      repo: root, artifact: { base: artifactBase, tip: artifactTip }, branch: '-unsafe', targetBase,
    });
    assert.equal(invalidBranch.reason, 'invalid_branch');
    const invalidCommit = await integrateDeliveryArtifact({
      repo: root, artifact: { base: 'bad', tip: artifactTip }, branch: 'invalid-commit', targetBase,
    });
    assert.equal(invalidCommit.reason, 'artifact_base_missing');
    const empty = await integrateDeliveryArtifact({
      repo: root, artifact: { base: artifactBase, tip: artifactBase }, branch: 'empty', targetBase,
    });
    assert.equal(empty.reason, 'empty_artifact_requires_captain');
    const duplicate = await integrateDeliveryArtifact({
      repo: root, artifact: { base: artifactBase, tip: artifactTip }, branch: 'implementation', targetBase,
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.stage, 'worktree');
    assert.equal(duplicate.conflict, false);

    const result = await integrateDeliveryArtifact({
      repo: root, artifact: { base: artifactBase, tip: artifactTip }, branch: 'integration', targetBase,
    });
    integrationWorktree = result.worktree;
    assert.equal(result.ok, true, result.error);
    assert.equal(git('rev-parse', 'HEAD'), targetBase, 'integration must not move the target branch');
    assert.equal(execFileSync('git', ['show', `${result.commit}:implementation.txt`], { cwd: root, encoding: 'utf8' }), 'implementation\n');
    assert.equal(execFileSync('git', ['show', `${result.commit}:repair.txt`], { cwd: root, encoding: 'utf8' }), 'repair\n');
    assert.equal(execFileSync('git', ['show', `${result.commit}:unrelated.txt`], { cwd: root, encoding: 'utf8' }), 'keep me\n');
    assert.deepEqual(execFileSync('git', ['show', `${result.commit}:binary.dat`], { cwd: root }), Buffer.from([0, 255, 1, 2, 0, 254]));
    assert.equal(git('rev-parse', `${result.commit}^`), targetBase, 'the integrated commit must use the frozen target base');
  } finally {
    if (integrationWorktree) {
      try { execFileSync('git', ['worktree', 'remove', '--force', integrationWorktree], { cwd: root, stdio: 'ignore' }); } catch { /* test cleanup only */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('delivery artifact fails closed on a three-way content conflict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-artifact-conflict-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let integrationWorktree;
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'shared.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('switch', '-c', 'artifact');
    writeFileSync(join(root, 'shared.txt'), 'artifact change\n');
    git('commit', '-am', 'artifact change');
    const tip = git('rev-parse', 'HEAD');
    git('switch', 'main');
    writeFileSync(join(root, 'shared.txt'), 'target change\n');
    git('commit', '-am', 'target change');
    const targetBase = git('rev-parse', 'HEAD');

    const result = await integrateDeliveryArtifact({ repo: root, artifact: { base, tip }, branch: 'integration', targetBase });
    integrationWorktree = result.worktree;
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.equal(result.stage, 'apply');
    assert.notEqual(execFileSync('git', ['ls-files', '--unmerged'], { cwd: integrationWorktree, encoding: 'utf8' }), '');
    assert.equal(git('rev-parse', 'HEAD'), targetBase, 'a conflict must not change the target branch');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
  } finally {
    if (integrationWorktree) {
      try { execFileSync('git', ['worktree', 'remove', '--force', integrationWorktree], { cwd: root, stdio: 'ignore' }); } catch { /* test cleanup only */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration applies the reviewed base..tip range instead of only the repair delta', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-range-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let worktree;
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('switch', '-c', 'delivery');
    writeFileSync(join(root, 'implementation.txt'), 'implementation\n');
    git('add', '.');
    git('commit', '-m', 'implementation');
    writeFileSync(join(root, 'repair.txt'), 'repair\n');
    git('add', '.');
    git('commit', '-m', 'repair');
    const tip = git('rev-parse', 'HEAD');
    git('switch', 'main');
    writeFileSync(join(root, 'target.txt'), 'target\n');
    git('add', '.');
    git('commit', '-m', 'target move');
    const result = await mergeCommitToBranch({
      repo: root, commit: tip, branch: 'integration/range', base: 'main', artifactBase: base,
    });
    worktree = result.worktree;
    assert.equal(result.ok, true, result.error);
    assert.equal(execFileSync('git', ['show', `${result.commit}:implementation.txt`], { cwd: root, encoding: 'utf8' }), 'implementation\n');
    assert.equal(execFileSync('git', ['show', `${result.commit}:repair.txt`], { cwd: root, encoding: 'utf8' }), 'repair\n');
    assert.equal(execFileSync('git', ['show', `${result.commit}:target.txt`], { cwd: root, encoding: 'utf8' }), 'target\n');
    assert.equal(git('rev-parse', `${result.commit}^`), git('rev-parse', 'main'));
  } finally {
    if (worktree) {
      try { execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root, stdio: 'ignore' }); } catch { /* cleanup */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct delivery commit leaves unrelated pre-staged files out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-staged-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('switch', '-c', 'artifact');
    writeFileSync(join(root, 'delivery.txt'), 'delivery\n');
    git('add', 'delivery.txt');
    git('commit', '-m', 'delivery');
    const tip = git('rev-parse', 'HEAD');
    git('switch', 'main');
    writeFileSync(join(root, 'operator.txt'), 'unrelated staged\n');
    git('add', 'operator.txt');
    const result = await mergeCommit({ repo: root, commit: tip, base, branch: 'main' });
    assert.equal(result.ok, true, result.error);
    const committed = git('show', '--name-only', '--format=', result.commit).split('\n').filter(Boolean);
    assert.deepEqual(committed, ['delivery.txt']);
    assert.match(git('status', '--porcelain'), /^A  operator\.txt$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed integration removes its deterministic branch so a retry is possible', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-branch-cleanup-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'shared.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('switch', '-c', 'artifact');
    writeFileSync(join(root, 'shared.txt'), 'artifact\n');
    git('commit', '-am', 'artifact');
    const tip = git('rev-parse', 'HEAD');
    git('switch', 'main');
    writeFileSync(join(root, 'shared.txt'), 'main\n');
    git('commit', '-am', 'main');
    const operationId = '11111111-1111-4111-8111-111111111111';
    const first = await mergeCommitToBranch({ repo: root, commit: tip, branch: 'integration/retry',
      base: 'main', operationId, artifactBase: base });
    assert.equal(first.ok, false);
    assert.throws(() => git('show-ref', '--verify', 'refs/heads/integration/retry'));
    const second = await mergeCommitToBranch({ repo: root, commit: tip, branch: 'integration/retry',
      base: 'main', operationId: '22222222-2222-4222-8222-222222222222', artifactBase: base });
    assert.equal(second.ok, false);
    assert.doesNotMatch(second.error, /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revertCommitOnce refuses a receipt that proves a different reverted object', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-revert-receipt-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'a1', 'utf8');
    writeFileSync(join(root, 'b.txt'), 'b1', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'a2', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'change a'], { cwd: root });
    const firstTarget = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(join(root, 'b.txt'), 'b2', 'utf8');
    execFileSync('git', ['add', 'b.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'change b'], { cwd: root });
    const secondTarget = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const first = await revertCommitOnce({ repo: root, commit: firstTarget, key: 'negative-shared-op' });
    assert.equal(first.ok, true, first.error);
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const wrong = await revertCommitOnce({ repo: root, commit: secondTarget, key: 'negative-shared-op' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'E_REVERT_RECEIPT');
    assert.equal(wrong.receiptStatus, 'object_mismatch');
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore, 'an unproven receipt must not trigger another revert');
    execFileSync('git', ['commit', '--allow-empty', '-m',
      'spoof\n\nNegative-Merge-Key: negative-shared-op'], { cwd: root });
    const ambiguous = await revertCommitOnce({ repo: root, commit: firstTarget, key: 'negative-shared-op' });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.receiptStatus, 'ambiguous');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revertCommitOnce clears a conflicted revert so the operation can be retried or held', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-revert-conflict-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'two', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'target'], { cwd: root });
    const target = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(join(root, 'a.txt'), 'three', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'later'], { cwd: root });
    const conflicted = await revertCommitOnce({ repo: root, commit: target, key: 'negative-conflict-op' });
    assert.equal(conflicted.ok, false);
    assert.equal(conflicted.workingTreeClean, true, conflicted.error);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(status, '', 'a failed revert must not leave conflict markers behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revertCommitOnce is idempotent and leaves a receipt trailer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-revert-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'two', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'change'], { cwd: root });
    const target = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const first = await revertCommitOnce({ repo: root, commit: target, key: 'negative-op-1' });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.alreadyReverted, false);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one');
    const body = execFileSync('git', ['show', '-s', '--format=%B', first.commit], { cwd: root, encoding: 'utf8' });
    assert.match(body, /Negative-Merge-Key: negative-op-1/);
    const second = await revertCommitOnce({ repo: root, commit: target, key: 'negative-op-1' });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyReverted, true);
    assert.equal(second.commit, first.commit, 'a retry must not create a second revert commit');
    const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(count, '3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fastForwardBranch updates only the explicit target ref and refuses a switched worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-ff-target-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'base', 'utf8');
    git('add', 'a.txt');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'integration');
    writeFileSync(join(root, 'integrated.txt'), 'integrated', 'utf8');
    git('add', 'integrated.txt');
    git('commit', '-m', 'integrated');
    const tip = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'other');
    const refused = await fastForwardBranch({ repo: root, branch: 'integration', target: 'main', expectedCommit: tip });
    assert.equal(refused.ok, false);
    assert.equal(git('rev-parse', 'refs/heads/main'), base, 'a switched worktree must not move main');
    assert.equal(git('rev-parse', 'refs/heads/other'), tip);
    git('checkout', 'main');
    const published = await fastForwardBranch({ repo: root, branch: 'integration', target: 'main', expectedCommit: tip });
    assert.equal(published.ok, true, published.error);
    assert.equal(git('rev-parse', 'refs/heads/main'), tip);
    assert.equal(readFileSync(join(root, 'integrated.txt'), 'utf8'), 'integrated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discardIntegrationArtifact does not report success when the branch cannot be deleted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-discard-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'base', 'utf8');
    git('add', 'a.txt');
    git('commit', '-m', 'base');
    git('branch', 'discard-fail');
    mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(root, '.git', 'refs', 'heads', 'discard-fail.lock'), 'locked', 'utf8');
    const failed = await discardIntegrationArtifact({ repo: root, branch: 'discard-fail', worktree: '' });
    assert.equal(failed.ok, false, 'a ref lock failure is not an already-missing branch');
    rmSync(join(root, '.git', 'refs', 'heads', 'discard-fail.lock'), { force: true });
    const removed = await discardIntegrationArtifact({ repo: root, branch: 'discard-fail', worktree: '' });
    assert.equal(removed.ok, true, removed.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discardIntegrationArtifact never deletes a branch a worktree still checks out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-discard-checked-out-'));
  const worktree = join(root, 'wt');
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'base', 'utf8');
    git('add', 'a.txt');
    git('commit', '-m', 'base');
    git('branch', 'still-checked-out');
    git('worktree', 'add', worktree, 'still-checked-out');
    const refused = await discardIntegrationArtifact({ repo: root, branch: 'still-checked-out', worktree: '' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /still checked out/);
    assert.equal(git('rev-parse', '--verify', 'refs/heads/still-checked-out').length > 0, true,
      'the branch must survive so the checkout is not orphaned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRevertReceipt reports a lookup failure instead of treating it as no receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-revert-lookup-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'base', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const lookup = await resolveRevertReceipt({ repo: root, key: 'missing-target-op', target: 'missing-branch', appliedCommit: head });
    assert.equal(lookup.status, 'error');
    await assert.rejects(
      () => findRevertReceipt({ repo: root, key: 'missing-target-op', target: 'missing-branch', appliedCommit: head }),
      (error) => error.code === 'E_REVERT_RECEIPT' && error.receiptStatus === 'error',
      'the commit-only helper must not map a lookup error to "no receipt"',
    );
    const reverted = await revertCommitOnce({ repo: root, commit: head, key: 'missing-target-op', target: 'missing-branch' });
    assert.equal(reverted.ok, false);
    assert.equal(reverted.code, 'E_REVERT_RECEIPT');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head,
      'an unreadable receipt must not trigger a revert');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository probes distinguish "not a repository" from "git could not answer"', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'ai-agent-teams-not-a-repo-'));
  const missing = join(plain, 'does-not-exist');
  try {
    assert.equal(isGitRepository(plain), false, 'git explicitly rejects a plain directory');
    assert.equal(await integrationBranchTip(plain, 'main'), null,
      'a plain directory has no branch; this is not a read failure');
    assert.equal(isGitRepository(missing), null,
      'a missing cwd is an unreadable probe, not "not a repository"');
    await assert.rejects(
      () => integrationBranchTip(missing, 'main'),
      'an unreadable repository must not be reported as a missing branch',
    );
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
