import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preflightArtifactBeforeReview, deriveChangedPaths, parsePorcelain, commitArtifactBeforeReview } from '../src/domain/changes.mjs';

test('porcelain parsing handles renames and nested paths', () => {
  const paths = parsePorcelain(' M src/a.js\nR  src/old.js -> src/new.js\n?? docs/x.md\n');
  assert.deepEqual(paths, ['docs/x.md', 'src/a.js', 'src/new.js']);
});

test('changed paths come from git, not self-report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-changes-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'two', 'utf8');
    writeFileSync(join(root, 'b.txt'), 'new', 'utf8');
    const paths = await deriveChangedPaths({ worktree: root, baseRef: 'HEAD' });
    assert.deepEqual(paths, ['a.txt', 'b.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('changed paths keep non-ASCII names instead of git octal escapes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-changes-unicode-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    const dir = join(root, '文档');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '说明.md'), '内容', 'utf8');
    const paths = await deriveChangedPaths({ worktree: root, baseRef: 'HEAD' });
    assert.ok(paths.includes('文档/说明.md'), JSON.stringify(paths));
    assert.ok(!paths.some((path) => path.includes('/346/')), JSON.stringify(paths));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact commit fails closed without an exclusive worktree fence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-artifact-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'local@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Local'], { cwd: root });
    writeFileSync(join(root, 'src.txt'), 'base');
    execFileSync('git', ['add', 'src.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(join(root, 'src.txt'), 'artifact');
    const input = { worktree: root, base, inScope: ['src.txt'], teamId: 'alpha', taskId: 'task-1', attemptId: 'attempt-1' };
    await assert.rejects(preflightArtifactBeforeReview({ ...input, exclusive: true }), /exclusive_worktree_fence_unavailable/);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), base);
    execFileSync('git', ['add', 'src.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'unrelated'], { cwd: root });
    const unrelated = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['replace', unrelated, base], { cwd: root });
    await assert.rejects(preflightArtifactBeforeReview(input), /provenance_mismatch/);
    execFileSync('git', ['replace', '-d', unrelated], { cwd: root });
    execFileSync('git', ['commit', '--amend', '-m', `artifact\n\nAgent-Teams-Task: alpha/task-1\nAgent-Teams-Attempt: attempt-1\nAgent-Teams-Base: ${base}`], { cwd: root });
    await assert.rejects(preflightArtifactBeforeReview(input), /exclusive_worktree_fence_unavailable/);
    await assert.rejects(preflightArtifactBeforeReview({ ...input, attemptId: 'other' }), /provenance_mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact inspection rejects a symlink replacing a parent directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-parent-link-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'local@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Local'], { cwd: root });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.txt'), 'base');
    execFileSync('git', ['add', 'src/a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    rmSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'target'));
    symlinkSync(join(root, 'target'), join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(preflightArtifactBeforeReview({ worktree: root, base, inScope: ['src/', 'target/'], teamId: 'a', taskId: 'b', attemptId: 'c' }), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('artifact inspection ignores inherited Git configuration injection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-git-env-'));
  const saved = process.env.GIT_CONFIG_COUNT;
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_SYSTEM;
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'local@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Local'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'base');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    process.env.GIT_CONFIG_COUNT = 'invalid';
    const badConfig = join(root, '.git', 'bad-config');
    writeFileSync(badConfig, '[broken');
    process.env.GIT_CONFIG_GLOBAL = badConfig;
    process.env.GIT_CONFIG_SYSTEM = badConfig;
    await assert.rejects(preflightArtifactBeforeReview({ worktree: root, base, inScope: ['a.txt'], teamId: 'a', taskId: 'b', attemptId: 'c' }), /no_changes/);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = saved;
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = savedSystem;
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact commit rejects out-of-scope and empty changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-artifact-reject-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'local@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Local'], { cwd: root });
    writeFileSync(join(root, 'src.txt'), 'base');
    execFileSync('git', ['add', 'src.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    await assert.rejects(preflightArtifactBeforeReview({ worktree: root, base, inScope: ['src/'], teamId: 'a', taskId: 'b', attemptId: 'c' }), /no_changes/);
    writeFileSync(join(root, 'outside.txt'), 'outside');
    await assert.rejects(preflightArtifactBeforeReview({ worktree: root, base, inScope: ['src/'], teamId: 'a', taskId: 'b', attemptId: 'c' }), /illegal_or_out_of_scope_path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed fence verification still releases the fence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-fence-release-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(join(root, 'a.txt'), 'two', 'utf8');
    let released = 0;
    const fence = {
      state: 'frozen', proof: 'test-fence-proof-0123456789', worktree: root,
      teamId: 'alpha', taskId: 't1', attemptId: 'a1',
      verify: async () => false,
      release: async () => { released += 1; },
    };
    await assert.rejects(commitArtifactBeforeReview({
      worktree: root, base, inScope: ['a.txt'], teamId: 'alpha', taskId: 't1', attemptId: 'a1', fence,
    }), /exclusive_worktree_fence_lost/);
    assert.equal(released, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diffHash is stable under different core.abbrev settings', async () => {
  const run = async (abbrev) => {
    const root = mkdtempSync(join(tmpdir(), `ai-agent-teams-abbrev-${abbrev}-`));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
      execFileSync('git', ['config', 'core.abbrev', String(abbrev)], { cwd: root });
      writeFileSync(join(root, 'a.txt'), 'one', 'utf8');
      execFileSync('git', ['add', 'a.txt'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      writeFileSync(join(root, 'a.txt'), 'two', 'utf8');
      const fence = {
        state: 'frozen', proof: 'test-fence-proof-0123456789', worktree: root,
        teamId: 'alpha', taskId: 't1', attemptId: 'a1',
        verify: async () => true, release: async () => {},
      };
      const artifact = await commitArtifactBeforeReview({
        worktree: root, base, inScope: ['a.txt'], teamId: 'alpha', taskId: 't1', attemptId: 'a1',
        fence, requireProvenance: false,
      });
      return artifact.diffHash;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const short = await run(4);
  const long = await run(12);
  assert.equal(short, long, 'raw diff object ids must not depend on core.abbrev');
});
