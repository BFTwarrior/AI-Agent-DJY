import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  browserCandidates,
  checkPanel,
  openPanel,
  PACKAGE_VERSION,
  panelInfo,
  panelInstructions,
  panelUrl,
} from '../src/panel.mjs';

// Discovery records carry the live daemon's version. Using the package version
// keeps these fixtures valid across release bumps instead of pinning a literal
// that fails every time the version changes.
const FIXTURE_VERSION = PACKAGE_VERSION;

const discovery = {
  port: 43123,
  token: 'secret',
  version: FIXTURE_VERSION,
  workspace: 'C:\\work\\alpha',
  pid: 123,
  instanceId: 'instance-1',
};

test('panel URL is loopback-only and validates the port', () => {
  assert.equal(panelUrl(43123), 'http://127.0.0.1:43123/ui#tasks');
  assert.equal(panelUrl(43123, 'local-key'), 'http://127.0.0.1:43123/ui?key=local-key#tasks');
  assert.equal(panelUrl(43123, 'a b'), 'http://127.0.0.1:43123/ui?key=a%20b#tasks');
  assert.throws(() => panelUrl(0), /invalid panel port/);
  assert.throws(() => panelUrl('abc'), /invalid panel port/);
});

test('panel info uses discovery and flags a workspace mismatch', () => {
  const match = panelInfo({ discovery, workspace: 'C:\\work\\alpha' });
  assert.equal(match.url, 'http://127.0.0.1:43123/ui#tasks');
  assert.equal(match.discovered, true);
  assert.equal(match.running, false);
  assert.equal(match.workspaceMatch, true);
  const keyed = panelInfo({
    discovery: { ...discovery, uiKey: 'local-key' },
    workspace: 'C:\\work\\alpha',
  });
  assert.equal(keyed.url, 'http://127.0.0.1:43123/ui?key=local-key#tasks');
  const explicitKey = panelInfo({ discovery: null, baseUrl: 'http://127.0.0.1:43123', uiKey: 'explicit-key' });
  assert.equal(explicitKey.url, 'http://127.0.0.1:43123/ui?key=explicit-key#tasks');
  const mismatch = panelInfo({ discovery, workspace: 'C:\\work\\beta' });
  assert.equal(mismatch.workspaceMatch, false);
  assert.match(panelInstructions(mismatch), /另一个工作区/);
});

test('panel info without discovery is unknown, not another workspace', () => {
  const info = panelInfo({ discovery: null, workspace: 'C:\\work\\alpha', defaultPort: 8779 });
  assert.equal(info.discovered, false);
  assert.equal(info.running, false);
  assert.equal(info.workspaceMatch, false);
  assert.equal(info.url, 'http://127.0.0.1:8779/ui#tasks');
  assert.match(panelInstructions(info), /未找到 daemon discovery/);
  const invalid = panelInfo({ discovery: null, defaultPort: 'nope' });
  assert.equal(invalid.port, 8779);
});

test('model-facing panel instructions are English while the CLI default stays localizable', () => {
  const missing = panelInfo({ discovery: null, workspace: 'C:\\work\\alpha', defaultPort: 8779 });
  const english = panelInstructions(missing, { language: 'en' });
  assert.match(english, /Team panel: http:\/\/127\.0\.0\.1:8779\/ui#tasks/);
  assert.match(english, /No daemon discovery file/);
  assert.doesNotMatch(english, /[\u3400-\u9fff]/u);
  assert.match(panelInstructions(missing), /团队面板/);

  const mismatch = panelInfo({ discovery, workspace: 'C:\\work\\beta' });
  assert.match(panelInstructions(mismatch, { language: 'en' }), /belongs to another workspace/);
  assert.doesNotMatch(panelInstructions(mismatch, { includeAccessKey: false, language: 'en' }), /local-key/);
});

test('panel health check requires version, workspace and live HTTP', async () => {
  const info = panelInfo({ discovery, workspace: 'C:\\work\\alpha' });
  const live = (data = { status: 'ok', version: FIXTURE_VERSION, workspace: 'C:\\work\\alpha' }) => ({
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, data }) }),
  });
  const ok = await checkPanel(info, live());
  assert.equal(ok.healthy, true);
  assert.equal(ok.running, true);
  const wrongVersion = await checkPanel(info, live({ status: 'ok', version: '0.1.3', workspace: 'C:\\work\\alpha' }));
  assert.equal(wrongVersion.healthy, false);
  assert.equal(wrongVersion.running, false);
  const wrongWorkspace = await checkPanel(info, live({ status: 'ok', version: FIXTURE_VERSION, workspace: 'C:\\work\\beta' }));
  assert.equal(wrongWorkspace.healthy, false);
  const dead = await checkPanel(info, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(dead.healthy, false);
  assert.equal(dead.running, false);
});

test('browser preference is Edge, then Chrome, then the OS default', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'D:\\Profiles\\me\\AppData\\Local',
  };
  const candidates = browserCandidates('win32', env);
  assert.equal(candidates[0].browser, 'edge');
  assert.match(candidates[0].command, /Microsoft\\Edge\\Application\\msedge\.exe$/);
  assert.ok(candidates.some((item) => item.browser === 'chrome'));
  const linux = browserCandidates('linux', {});
  assert.equal(linux[0].command, '/usr/bin/microsoft-edge');
  assert.ok(linux.every((item) => item.command.startsWith('/')));
});

test('openPanel prefers Edge and passes the URL', async () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const result = await openPanel('http://127.0.0.1:8779/ui#tasks', {
    platform: 'win32',
    env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    exists: (path) => path === edge,
    spawnImpl,
  });
  assert.equal(result.opened, true);
  assert.equal(result.browser, 'edge');
  assert.equal(calls[0].command, edge);
  assert.deepEqual(calls[0].args, ['http://127.0.0.1:8779/ui#tasks']);
});

test('openPanel window mode uses a chromeless app window', async () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const result = await openPanel('http://127.0.0.1:8779/ui?key=k#tasks', {
    platform: 'win32',
    env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    exists: (path) => path === edge,
    spawnImpl,
    mode: 'window',
  });
  assert.equal(result.opened, true);
  assert.equal(result.mode, 'window');
  assert.equal(calls[0].args[0], '--app=http://127.0.0.1:8779/ui?key=k#tasks');
  assert.match(calls[0].args[1], /^--window-size=/);
});

test('window mode reports a tab when only the default handler exists', async () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const result = await openPanel('http://127.0.0.1:8779/ui#tasks', {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    exists: (path) => /cmd\.exe$/i.test(path),
    spawnImpl,
    mode: 'window',
  });
  assert.equal(result.opened, true);
  assert.equal(result.mode, 'tab');
  assert.equal(result.appWindow, false);
  assert.equal(calls[0].args.includes('--app=http://127.0.0.1:8779/ui#tasks'), false);
});

test('openPanel reports a missing browser and rejects non-loopback URLs', async () => {
  const spawnImpl = () => { throw new Error('should not spawn'); };
  const missing = await openPanel('http://127.0.0.1:8779/ui#tasks', {
    platform: 'linux',
    exists: () => false,
    spawnImpl,
  });
  assert.equal(missing.opened, false);
  assert.match(missing.error, /no browser/);
  const remote = await openPanel('http://example.com/ui', { platform: 'linux', exists: () => true, spawnImpl });
  assert.equal(remote.opened, false);
  assert.match(remote.error, /non-loopback/);
});

test('openPanel does not claim success when spawn is never confirmed', async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const result = await openPanel('http://127.0.0.1:8779/ui#tasks', {
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files' },
    exists: () => true,
    spawnImpl: () => child,
    spawnTimeoutMs: 20,
  });
  assert.equal(result.opened, false);
  assert.match(result.error, /did not confirm spawn/);
});

test('panel info prefers a live legacy mirror over a stale per-workspace record', async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { discoveryPathForWorkspace } = await import('../src/discovery.mjs');
  const base = mkdtempSync(join(tmpdir(), 'zat-panel-discovery-'));
  const workspace = mkdtempSync(join(tmpdir(), 'zat-panel-workspace-'));
  const previous = process.env.AGENT_TEAMS_DISCOVERY_BASE;
  process.env.AGENT_TEAMS_DISCOVERY_BASE = base;
  try {
    const specific = discoveryPathForWorkspace(workspace);
    mkdirSync(join(specific, '..'), { recursive: true });
    writeFileSync(specific, JSON.stringify({
      port: 8779, token: 'stale', pid: 999999, workspace: resolve(workspace), version: FIXTURE_VERSION,
    }), 'utf8');
    writeFileSync(join(base, 'runtime.json'), JSON.stringify({
      port: 8780, token: 'live', pid: process.pid, workspace: resolve(workspace), version: FIXTURE_VERSION,
    }), 'utf8');
    const info = panelInfo({ workspace });
    assert.equal(info.port, 8780);
    assert.equal(info.discovered, true);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEAMS_DISCOVERY_BASE;
    else process.env.AGENT_TEAMS_DISCOVERY_BASE = previous;
  }
});
