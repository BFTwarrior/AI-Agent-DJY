import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRotatingLog,
  reclaimDiscoveryDirectories,
  workspaceKey,
  discoveryPathForWorkspace,
  normalizeDiscovery,
  readDiscovery,
  removeDiscovery,
  writeDiscovery,
} from '../src/discovery.mjs';
import { sameWorkspace } from '../src/domain/workspace.mjs';

test('discovery normalization rejects records without identity fields', () => {
  assert.equal(normalizeDiscovery(null), undefined);
  assert.equal(normalizeDiscovery({ port: 8779, token: 't', version: '0.1.4' }), undefined);
  const parsed = normalizeDiscovery({
    port: '8779', token: 't', version: '0.1.4', workspace: 'C:\\work\\alpha', pid: '42', instanceId: 'i',
  });
  assert.equal(parsed.port, 8779);
  assert.equal(parsed.pid, 42);
});

test('workspace discovery paths are deterministic and separate', () => {
  const a = discoveryPathForWorkspace('C:\\work\\alpha');
  const b = discoveryPathForWorkspace('C:\\work\\beta');
  assert.equal(a, discoveryPathForWorkspace('C:\\work\\alpha'));
  assert.notEqual(a, b);
  assert.match(a, /workspaces[\\/][0-9a-f]{16}[\\/]runtime\.json$/);
});

test('write/read/remove discovery keeps token private and identity-bound', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-discovery-'));
  const path = join(dir, 'runtime.json');
  try {
    const returned = writeDiscovery({
      port: 43123,
      token: 'secret-token',
      version: '0.1.4',
      workspace: dir,
      pid: process.pid,
      instanceId: 'instance-1',
      uiKey: 'local-ui-key',
    }, { path, legacy: false });
    assert.equal(returned, path);
    const parsed = readDiscovery(path);
    assert.equal(parsed.port, 43123);
    assert.equal(parsed.instanceId, 'instance-1');
    assert.equal(parsed.uiKey, 'local-ui-key');
    assert.match(readFileSync(path, 'utf8'), /"token": "secret-token"/);
    assert.equal(removeDiscovery({ path, pid: process.pid + 1, instanceId: 'instance-1' }), false);
    assert.equal(removeDiscovery({ path, pid: process.pid, instanceId: 'different' }), false);
    assert.equal(removeDiscovery({ path, pid: process.pid, instanceId: 'instance-1' }), true);
    assert.equal(readDiscovery(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy discovery with another workspace is not accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-discovery-legacy-'));
  try {
    const path = join(dir, 'runtime.json');
    writeFileSync(path, JSON.stringify({
      port: 8779, token: 't', version: '0.1.4', workspace: 'C:\\work\\other', pid: 1,
    }));
    const parsed = readDiscovery(path);
    assert.equal(parsed.workspace, 'C:\\work\\other');
    assert.equal(sameWorkspace(parsed.workspace, dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery reclaim only removes old empty hashes and protects the active hint', () => {
  const root = mkdtempSync(join(tmpdir(), 'discovery-reclaim-'));
  try {
    const workspace = join(root, 'deleted-workspace');
    const active = workspaceKey(workspace);
    const names = ['1111111111111111', '2222222222222222', '3333333333333333', '4444444444444444', '5555555555555555', active, 'unknown'];
    for (const name of names) mkdirSync(join(root, 'workspaces', name), { recursive: true });
    writeFileSync(join(root, 'active-workspace.json'), JSON.stringify({ workspace }));
    writeFileSync(join(root, 'workspaces', names[1], 'runtime.json'), JSON.stringify({ pid: process.pid }));
    writeFileSync(join(root, 'workspaces', names[2], 'runtime.json.lock'), '{}');
    writeFileSync(join(root, 'workspaces', names[3], 'evidence'), 'keep');
    const old = new Date(Date.now() - 8 * 86400000);
    for (const name of names) utimesSync(join(root, 'workspaces', name), old, old);
    utimesSync(join(root, 'workspaces', names[4]), new Date(), new Date());
    const report = reclaimDiscoveryDirectories({ baseDir: root });
    assert.deepEqual(report.removed, [join(root, 'workspaces', names[0])]);
    assert.equal(existsSync(join(root, 'workspaces', names[0])), false);
    for (const name of names.slice(1)) assert.equal(existsSync(join(root, 'workspaces', name)), true);
    writeFileSync(join(root, 'active-workspace.json'), 'invalid');
    assert.equal(reclaimDiscoveryDirectories({ baseDir: root }).errors.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('supervisor log rotates with one backup and retains current messages', () => {
  const root = mkdtempSync(join(tmpdir(), 'rotating-log-'));
  try {
    const log = join(root, 'supervisor.log');
    appendRotatingLog(log, '12345678', 10);
    appendRotatingLog(log, 'abc', 10);
    assert.equal(readFileSync(`${log}.1`, 'utf8'), '12345678');
    assert.equal(readFileSync(log, 'utf8'), 'abc');
    appendRotatingLog(log, 'def', 10);
    assert.equal(readFileSync(log, 'utf8'), 'abcdef');
    appendRotatingLog(log, '12345', 10);
    assert.equal(readFileSync(`${log}.1`, 'utf8'), 'abcdef');
    assert.equal(readFileSync(log, 'utf8'), '12345');
    assert.equal(existsSync(`${log}.2`), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
