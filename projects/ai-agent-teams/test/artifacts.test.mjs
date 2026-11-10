import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectDrift, digestFile, snapshotScope } from '../src/domain/artifacts.mjs';

test('digest detects content changes and drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-'));
  try {
    const file = join(root, 'a.ts');
    writeFileSync(file, 'one', 'utf8');
    const before = digestFile(root, 'a.ts');
    assert.equal(before.present, true);
    assert.match(before.sha256, /^[0-9a-f]{64}$/);
    writeFileSync(file, 'two', 'utf8');
    const after = digestFile(root, 'a.ts');
    assert.notEqual(before.sha256, after.sha256);
    assert.deepEqual(detectDrift([before], [after]), ['a.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing and escaping paths are reported safely', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-'));
  try {
    const missing = digestFile(root, 'missing.ts');
    assert.equal(missing.present, false);
    assert.equal(missing.unreadable, undefined);
    const escaping = digestFile(root, '../outside.ts');
    assert.equal(escaping.unreadable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a symlink escaping the workspace is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-'));
  const outside = mkdtempSync(join(tmpdir(), 'ai-agent-teams-outside-'));
  try {
    const target = join(outside, 'secret.txt');
    writeFileSync(target, 'secret', 'utf8');
    let relativePath;
    if (process.platform === 'win32') {
      symlinkSync(outside, join(root, 'link-dir'), 'junction');
      relativePath = join('link-dir', 'secret.txt');
    } else {
      symlinkSync(target, join(root, 'link.txt'));
      relativePath = 'link.txt';
    }
    const digest = digestFile(root, relativePath);
    assert.equal(digest.unreadable, true);
    assert.equal(digest.sha256, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});


test('snapshotScope hashes only files matching the scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-scope-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'one', 'utf8');
    writeFileSync(join(root, 'README.md'), 'doc', 'utf8');
    const snapshot = snapshotScope(root, ['src/']);
    assert.equal(snapshot.artifacts.length, 1);
    assert.equal(snapshot.artifacts[0].path, 'src/a.ts');
    writeFileSync(join(root, 'src', 'a.ts'), 'two', 'utf8');
    assert.deepEqual(detectDrift(snapshot.artifacts, snapshotScope(root, ['src/']).artifacts), ['src/a.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
