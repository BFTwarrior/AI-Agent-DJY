import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { realpath as realpathAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFINITIONS } from '../src/mcp/handler.mjs';
import { ShellProtocol } from '../src/mcp/shell/protocol.mjs';
import { createMcpShell } from '../src/mcp/shell.mjs';

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const shellEntry = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url));

// Keep every runtime isolated from the developer/CI environment: a member
// token in the host environment would change the tool catalog and hide tools.
const isolatedEnv = {
  AGENT_TEAMS_AUTOSTART: '0',
  AGENT_TEAMS_URL: '',
  AGENT_TEAMS_TOKEN: '',
  AGENT_TEAMS_MEMBER: '',
  AGENT_TEAMS_TEAM: '',
  AGENT_TEAMS_WORKSPACE: '',
};

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(check, label = 'condition', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'zat-shell-root-'));
  const workspace = mkdtempSync(join(tmpdir(), 'zat-shell-work-'));
  const pointerPath = join(root, 'runtime', 'current.json');
  mkdirSync(dirname(pointerPath), { recursive: true });
  return { root, workspace, pointerPath };
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeRuntimeAt(file, options = {}) {
  const {
    version = 'v1',
    failInit = false,
    exitLog = null,
    initDelayMs = 0,
    floodNotifications = 0,
    capabilities = { tools: {} },
    askHost = false,
    hostRequestId = null,
    stdoutProbe = null,
  } = options;
  mkdirSync(dirname(file), { recursive: true });
  const source = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const VERSION = ${JSON.stringify(version)};
const FAIL_INIT = ${failInit ? 'true' : 'false'};
const EXIT_LOG = ${JSON.stringify(exitLog)};
const INIT_DELAY_MS = ${Number(initDelayMs) || 0};
const FLOOD = ${Number(floodNotifications) || 0};
const CAPABILITIES = ${JSON.stringify(capabilities)};
const ASK_HOST = ${askHost ? 'true' : 'false'};
const HOST_REQUEST_ID = ${JSON.stringify(hostRequestId)};
const STDOUT_PROBE = ${stdoutProbe === null ? 'null' : JSON.stringify(stdoutProbe)};
const WORKSPACE = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
let initializedCount = 0;
let calls = 0;
let cancellations = 0;
let serverRequestSeq = 0;
const timers = new Map();
const serverWaiters = new Map();
if (EXIT_LOG) {
  process.on('exit', () => { try { appendFileSync(EXIT_LOG, VERSION + '\\n'); } catch {} });
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function writeStdoutProbe(onComplete) {
  if (!STDOUT_PROBE) {
    onComplete();
    return;
  }
  const line = (value) => JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: value } });
  const exact = line('x'.repeat(STDOUT_PROBE.exactPayloadLength));
  const exactCrLf = line('c'.repeat(STDOUT_PROBE.exactPayloadLength));
  const oversizedLf = line('y'.repeat(STDOUT_PROBE.oversizedPayloadLength));
  const oversizedCrLf = line('z'.repeat(STDOUT_PROBE.oversizedPayloadLength));
  const chunks = [
    exact.slice(0, 1024), exact.slice(1024, -1), exact.slice(-1) + '\\n',
    exactCrLf.slice(0, 2048), exactCrLf.slice(2048) + '\\r\\n',
    oversizedLf.slice(0, 4096), oversizedLf.slice(4096) + '\\n',
    oversizedCrLf.slice(0, 2048), oversizedCrLf.slice(2048) + '\\r\\n',
    line('after-lf') + '\\n' + line('after-crlf') + '\\r\\n',
  ];
  let index = 0;
  const writeNext = () => {
    if (index >= chunks.length) {
      onComplete();
      return;
    }
    process.stdout.write(chunks[index], writeNext);
    index += 1;
  };
  writeNext();
}
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  const method = message.method;
  // A response from the host to a request this runtime made.
  if (method === undefined && message.id !== undefined) {
    const key = String(message.id);
    const waiter = serverWaiters.get(key);
    if (waiter) { serverWaiters.delete(key); waiter(message); }
    return;
  }
  if (method === 'notifications/initialized') { initializedCount += 1; return; }
  if (method === 'notifications/cancelled') {
    cancellations += 1;
    const requestId = message.params && message.params.requestId;
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'cancelled:' + String(requestId) } });
    const timer = timers.get(String(requestId));
    if (timer) { clearTimeout(timer); timers.delete(String(requestId)); }
    if (requestId !== undefined) send({ jsonrpc: '2.0', id: requestId, error: { code: -32800, message: 'request cancelled' } });
    return;
  }
  if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { resources: [{ uri: 'ui://fake/panel.html', name: 'fake-panel', mimeType: 'text/html' }] } });
    return;
  }
  if (method === 'initialize') {
    if (FAIL_INIT) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'initialize exploded' } }); return; }
    const reply = () => {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: (message.params && message.params.protocolVersion) || '2024-11-05', capabilities: CAPABILITIES, serverInfo: { name: 'fake-runtime', version: VERSION }, instructions: 'workspace=' + WORKSPACE } });
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello-' + VERSION } });
      for (let index = 0; index < FLOOD; index += 1) {
        send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'flood-' + index } });
      }
    };
    if (INIT_DELAY_MS > 0) setTimeout(reply, INIT_DELAY_MS);
    else reply();
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo_' + VERSION, description: 'echo ' + VERSION, inputSchema: { type: 'object', additionalProperties: true } }] } });
    return;
  }
  if (method === 'tools/call') {
    calls += 1;
    const args = (message.params && message.params.arguments) || {};
    if (message.params && message.params.name === 'crash') { process.exit(7); }
    if (ASK_HOST && message.params && message.params.name === 'ask-host') {
      serverRequestSeq += 1;
      const requestId = HOST_REQUEST_ID ?? 'rt-' + serverRequestSeq;
      const answer = new Promise((resolveAnswer) => serverWaiters.set(requestId, resolveAnswer));
      send({ jsonrpc: '2.0', id: requestId, method: 'roots/list', params: {} });
      answer.then((response) => {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ serverResponse: response }) }], isError: false } });
      });
      return;
    }
    const delayMs = Number(args.delayMs || 0);
    const respond = () => {
      timers.delete(String(message.id));
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ version: VERSION, workspace: WORKSPACE, pid: process.pid, initialized: initializedCount, cancellations, calls, args }) }], isError: false } });
    };
    if (STDOUT_PROBE && message.params && message.params.name === 'stdout-probe') {
      writeStdoutProbe(respond);
    } else if (delayMs > 0) timers.set(String(message.id), setTimeout(respond, delayMs));
    else respond();
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } });
});
`;
  writeFileSync(file, source);
  return file;
}

function writeRuntime(root, name, options = {}) {
  return writeRuntimeAt(join(root, `${name}.mjs`), options);
}

function writePointer(pointerPath, entryFile, version) {
  const sha256 = sha256Of(entryFile);
  const temp = `${pointerPath}.tmp`;
  writeFileSync(temp, JSON.stringify({ version, entry: basename(entryFile), apiVersion: 1, sha256 }, null, 2));
  renameSync(temp, pointerPath);
}

function initRequest(id = 1, protocolVersion = '2025-06-18') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'shell-test', version: '1.0.0' } },
  };
}

function callRequest(id, name, args = {}) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function payloadOf(response) {
  assert.equal(response.result?.isError, false, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}

function startShell(fixture, overrides = {}) {
  const notifications = [];
  const logs = [];
  const shell = createMcpShell({
    pluginRoot: fixture.root,
    pointerPath: fixture.pointerPath,
    workspace: fixture.workspace,
    watch: false,
    healthTimeoutMs: 3000,
    drainTimeoutMs: 3000,
    killGraceMs: 500,
    restartDelayMs: 20,
    env: isolatedEnv,
    onNotification: (message) => notifications.push(message),
    onLog: (message) => logs.push(message),
    ...overrides,
  });
  return { shell, notifications, logs };
}

function makeHostRequestProtocol(hostRequestTimeoutMs) {
  const hostRequests = [];
  const notifications = [];
  const records = [1, 2].map((generation) => {
    const record = { generation, exited: false, stopping: false, messages: [] };
    record.child = { stdin: { write: (line) => record.messages.push(JSON.parse(line)) } };
    return record;
  });
  const protocol = new ShellProtocol({
    routing: {
      current: () => records[0],
      isRetiring: (record) => record === records[1],
      isClosing: () => false,
    },
    onNotification: (message) => notifications.push(message),
    onHostRequest: (message) => hostRequests.push(message),
    log: () => {},
    hostRequestTimeoutMs,
    healthTimeoutMs: 100,
    packageVersion,
  });
  return { protocol, records, hostRequests, notifications };
}

function hostRequest(id = 'shared-wire-id') {
  return { jsonrpc: '2.0', id, method: 'roots/list', params: {} };
}

test('shell forwards initialize, tools/list, resources, tools/call and both notification directions', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1' });
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell, notifications } = startShell(fixture);
  try {
    const init = await shell.handleMessage(initRequest());
    assert.equal(init.result.serverInfo.name, 'fake-runtime');
    assert.equal(init.result.serverInfo.version, 'v1');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.capabilities.tools.listChanged, true);
    assert.match(init.result.instructions, /workspace=/);

    // Host -> runtime notifications are forwarded too; the fake counts them.
    assert.equal(await shell.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

    const list = await shell.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['echo_v1']);

    const resources = await shell.handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    assert.equal(resources.result.resources[0].uri, 'ui://fake/panel.html');

    const call = await shell.handleMessage(callRequest(4, 'echo_v1', { hello: 'world' }));
    const payload = payloadOf(call);
    assert.equal(payload.version, 'v1');
    assert.deepEqual(payload.args, { hello: 'world' });
    // The cold-start warm-up initializes the runtime before the host
    // handshake, so the fake has seen at least one initialized notification.
    assert.ok(payload.initialized >= 1);
    assert.equal(payload.workspace, fixture.workspace);

    await waitFor(
      () => notifications.some((message) => message.method === 'notifications/message' && message.params?.data === 'hello-v1'),
      'runtime -> host notification',
    );
  } finally {
    await shell.close();
  }
});

test('pointer change swaps the runtime, sends list_changed and drains old in-flight calls', async () => {
  const fixture = makeFixture();
  const exitLog = join(fixture.root, 'exits.log');
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1', exitLog });
  const v2 = writeRuntime(fixture.root, 'v2', { version: 'v2', exitLog });
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell, notifications } = startShell(fixture, { watch: true, watchIntervalMs: 20, drainTimeoutMs: 8000 });
  try {
    const init = await shell.handleMessage(initRequest());
    assert.equal(init.result.serverInfo.version, 'v1');
    const firstPid = shell.status().current.pid;

    const inFlight = shell.handleMessage(callRequest(10, 'echo_v1', { delayMs: 2000 }));
    await waitFor(() => shell.status().current?.pending === 1, 'old in-flight request');

    writePointer(fixture.pointerPath, v2, 'v2');
    await waitFor(
      () => notifications.some((message) => message.method === 'notifications/tools/list_changed'),
      'notifications/tools/list_changed',
      8000,
    );

    // New calls route to v2 while the old runtime still owns its in-flight call.
    assert.equal(shell.status().current.version, 'v2');
    assert.ok(
      shell.status().retiring.some((record) => record.pending === 1),
      'old runtime should still be draining its in-flight request',
    );
    const fresh = payloadOf(await shell.handleMessage(callRequest(11, 'echo_v2')));
    assert.equal(fresh.version, 'v2');
    // The shell initializes every new runtime, so the warm-up is observable.
    assert.ok(fresh.initialized >= 1);

    const old = payloadOf(await inFlight);
    assert.equal(old.version, 'v1');
    assert.equal(old.pid, firstPid);

    await shell.whenIdle();
    assert.equal(shell.status().current.version, 'v2');
    assert.equal(shell.status().retiring.length, 0);
    assert.match(readFileSync(exitLog, 'utf8'), /v1/);
  } finally {
    await shell.close();
  }
});

test('a failing candidate keeps the previous runtime serving and never reports a switch', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1' });
  const broken = writeRuntime(fixture.root, 'v2-broken', { version: 'v2-broken', failInit: true });
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell, notifications } = startShell(fixture);
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');

    writePointer(fixture.pointerPath, broken, 'v2-broken');
    const failed = await shell.reload();
    assert.equal(failed.switched, false);
    assert.match(failed.error, /initialize failed/);
    assert.equal(shell.status().current.version, 'v1');
    assert.ok(shell.status().lastSwitchError);
    assert.equal(notifications.some((message) => message.method === 'notifications/tools/list_changed'), false);
    assert.equal(payloadOf(await shell.handleMessage(callRequest(20, 'echo_v1'))).version, 'v1');

    // A pointer that names a missing entry is rejected before spawning.
    writeFileSync(fixture.pointerPath, JSON.stringify({ version: 'v3', entry: 'missing.mjs', apiVersion: 1, sha256: sha256Of(v1) }));
    const missing = await shell.reload();
    assert.equal(missing.switched, false);
    assert.match(missing.error, /does not exist/);
    assert.equal(payloadOf(await shell.handleMessage(callRequest(21, 'echo_v1'))).version, 'v1');

    // An entry outside the plugin directory is rejected.
    writeFileSync(fixture.pointerPath, JSON.stringify({ version: 'v4', entry: '../outside.mjs', apiVersion: 1, sha256: sha256Of(v1) }));
    const escaped = await shell.reload();
    assert.equal(escaped.switched, false);
    assert.match(escaped.error, /escapes the plugin directory/);
    assert.equal(payloadOf(await shell.handleMessage(callRequest(22, 'echo_v1'))).version, 'v1');

    // Integrity checking is mandatory: a pointer without sha256 is rejected.
    writeFileSync(fixture.pointerPath, JSON.stringify({ version: 'v5', entry: basename(v1), apiVersion: 1 }));
    const unsigned = await shell.reload();
    assert.equal(unsigned.switched, false);
    assert.match(unsigned.error, /sha256/);
    assert.equal(payloadOf(await shell.handleMessage(callRequest(23, 'echo_v1'))).version, 'v1');

    writeFileSync(fixture.pointerPath, JSON.stringify({ version: 'v6', entry: basename(v1), apiVersion: 2, sha256: sha256Of(v1) }));
    const unsupported = await shell.reload();
    assert.equal(unsupported.switched, false);
    assert.match(unsupported.error, /apiVersion/);
    assert.equal(payloadOf(await shell.handleMessage(callRequest(24, 'echo_v1'))).version, 'v1');

    writeFileSync(fixture.pointerPath, JSON.stringify({ version: 'v7', entry: basename(v1), apiVersion: 1, sha256: '0'.repeat(64) }));
    const tampered = await shell.reload();
    assert.equal(tampered.switched, false);
    assert.match(tampered.error, /sha256 mismatch/);
    assert.equal(payloadOf(await shell.handleMessage(callRequest(25, 'echo_v1'))).version, 'v1');
  } finally {
    await shell.close();
  }
});

test('an unusable pointer on cold start falls back to the packaged runtime', async () => {
  const fixture = makeFixture();
  writeFileSync(fixture.pointerPath, '{ not json');
  // Fall back to the real src/mcp/runtime-entry.mjs in this repository.
  const { shell } = startShell(fixture, { pluginRoot: undefined });
  try {
    const init = await shell.handleMessage(initRequest());
    assert.equal(init.result.serverInfo.name, 'ai-agent-teams');
    assert.match(shell.status().lastSwitchError?.message ?? '', /not valid JSON/);
    const list = await shell.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(list.result.tools.length, TOOL_DEFINITIONS.length);
  } finally {
    await shell.close();
  }
});

test('a pointer runtime that fails its cold-start warm-up falls back to the packaged entry', async () => {
  const fixture = makeFixture();
  const broken = writeRuntime(fixture.root, 'broken', { version: 'broken', failInit: true });
  // The fallback target is <pluginRoot>/src/mcp/runtime-entry.mjs; give the
  // fixture its own working fallback runtime so the test does not depend on
  // the repository checkout.
  writeRuntimeAt(join(fixture.root, 'src', 'mcp', 'runtime-entry.mjs'), { version: 'fallback' });
  writePointer(fixture.pointerPath, broken, 'broken');

  const { shell } = startShell(fixture);
  try {
    const init = await shell.handleMessage(initRequest());
    assert.equal(init.result.serverInfo.version, 'fallback');
    const status = shell.status();
    assert.equal(status.current.source, 'fallback');
    assert.match(status.lastSwitchError?.message ?? '', /warm-up failed/);
    assert.match(status.lastSwitchError?.message ?? '', /initialize failed/);
    assert.equal(payloadOf(await shell.handleMessage(callRequest(5, 'echo_fallback'))).version, 'fallback');
  } finally {
    await shell.close();
  }
});

test('repeated crashes fall back to the packaged runtime and then stop restarting', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1' });
  writeRuntimeAt(join(fixture.root, 'src', 'mcp', 'runtime-entry.mjs'), { version: 'fallback' });
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell, logs } = startShell(fixture, {
    maxConsecutiveCrashes: 2,
    stableAfterMs: 60000,
    restartDelayMs: 10,
    killGraceMs: 100,
  });
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');

    // First crash: restart the pointer runtime, the counter is not exhausted.
    const first = await shell.handleMessage(callRequest(80, 'crash'));
    assert.match(first.error?.message ?? '', /runtime exited/);
    await waitFor(() => shell.status().current?.version === 'v1', 'pointer runtime restart');
    assert.equal(shell.status().forceFallback, false);

    // Second crash: the pointer runtime is pinned to the fallback runtime.
    const second = await shell.handleMessage(callRequest(81, 'crash'));
    assert.match(second.error?.message ?? '', /runtime exited/);
    await waitFor(() => shell.status().current?.source === 'fallback', 'fallback runtime');
    assert.equal(shell.status().forceFallback, true);
    assert.match(shell.status().lastSwitchError?.message ?? '', /crashed 2 time\(s\) in a row/);

    // The fallback runtime crashes twice as well: automatic restarts stop and
    // the failure is reported instead of silently retrying forever.
    const third = await shell.handleMessage(callRequest(82, 'crash'));
    assert.match(third.error?.message ?? '', /runtime exited/);
    await waitFor(() => shell.status().current?.source === 'fallback', 'fallback runtime restart');
    const fourth = await shell.handleMessage(callRequest(83, 'crash'));
    assert.match(fourth.error?.message ?? '', /runtime exited/);
    await waitFor(() => shell.status().restartStopped === true, 'restart stop');

    const blocked = await shell.handleMessage(callRequest(84, 'echo_fallback'));
    assert.equal(blocked.result?.isError, true);
    assert.match(blocked.result.content[0].text, /stopped after 2 consecutive crashes/);
    assert.equal(shell.status().lastRuntimeError !== null, true);
    assert.ok(logs.some((line) => /automatic restarts are stopped/.test(line)));
  } finally {
    await shell.close();
  }
});

test('consecutive crashes back off exponentially and reset after a stable run', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1' });
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell, logs } = startShell(fixture, {
    maxConsecutiveCrashes: 10,
    stableAfterMs: 600,
    restartDelayMs: 10,
    maxRestartDelayMs: 1000,
    killGraceMs: 100,
  });
  const restartDelays = () => logs
    .map((line) => /restarting runtime in (\d+)ms/.exec(line))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');

    // Each crash lands well inside the stability window, so the consecutive
    // count keeps growing: 10ms, 20ms, 40ms instead of a fixed delay.
    for (const id of [70, 71, 72]) {
      const crashed = await shell.handleMessage(callRequest(id, 'crash'));
      assert.match(crashed.error?.message ?? '', /runtime exited/);
      await waitFor(() => shell.status().current?.version === 'v1', `restart after crash ${id}`);
    }
    assert.deepEqual(restartDelays(), [10, 20, 40]);

    // Surviving the stability window proves the deployment is healthy again:
    // the counters clear and the next crash starts from the base delay.
    await waitFor(() => Object.keys(shell.status().crashCounts).length === 0, 'crash counters reset');
    const afterStable = await shell.handleMessage(callRequest(73, 'crash'));
    assert.match(afterStable.error?.message ?? '', /runtime exited/);
    await waitFor(() => shell.status().current?.version === 'v1', 'restart after stable run');
    assert.deepEqual(restartDelays().slice(-1), [10]);
  } finally {
    await shell.close();
  }
});

test('a cancellation is routed to the runtime that owns the in-flight request', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1' });
  const v2 = writeRuntime(fixture.root, 'v2', { version: 'v2' });
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell, notifications } = startShell(fixture, { drainTimeoutMs: 3000 });
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');
    const inFlight = shell.handleMessage(callRequest(60, 'echo_v1', { delayMs: 5000 }));
    await waitFor(() => shell.status().current?.pending === 1, 'old in-flight request');

    writePointer(fixture.pointerPath, v2, 'v2');
    const switched = await shell.reload();
    assert.equal(switched.switched, true);
    assert.ok(shell.status().retiring.some((record) => record.pending === 1));

    assert.equal(
      await shell.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 60 } }),
      null,
    );
    const cancelled = await inFlight;
    assert.equal(cancelled.error?.code, -32800);
    assert.match(cancelled.error.message, /cancelled/);

    // The cancel must not leak to the newly current runtime.
    const fresh = payloadOf(await shell.handleMessage(callRequest(61, 'echo_v2')));
    assert.equal(fresh.cancellations, 0);
    await waitFor(
      () => notifications.some((message) => message.method === 'notifications/message' && message.params?.data === 'cancelled:60'),
      'cancel notification from the old runtime',
    );
  } finally {
    await shell.close();
  }
});

test('a drain timeout fails the old request with an explicit drain timeout error', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1' });
  const v2 = writeRuntime(fixture.root, 'v2', { version: 'v2' });
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell } = startShell(fixture, { drainTimeoutMs: 100, killGraceMs: 50 });
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');
    const inFlight = shell.handleMessage(callRequest(70, 'echo_v1', { delayMs: 10000 }));
    await waitFor(() => shell.status().current?.pending === 1, 'old in-flight request');

    writePointer(fixture.pointerPath, v2, 'v2');
    const switched = await shell.reload();
    assert.equal(switched.switched, true);

    const response = await inFlight;
    assert.equal(response.error?.code, -32603);
    assert.match(response.error.message, /drain timeout/);
    await shell.whenIdle();
    assert.equal(shell.status().retiring.length, 0);
    assert.equal(shell.status().current.version, 'v2');
  } finally {
    await shell.close();
  }
});

test('a crashed runtime fails in-flight requests and is restarted automatically', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1' });
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell } = startShell(fixture);
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');
    const generation = shell.status().current.generation;

    const crashed = await shell.handleMessage(callRequest(30, 'crash'));
    assert.equal(crashed.result, undefined);
    assert.equal(crashed.error?.code, -32603);
    assert.match(crashed.error.message, /runtime exited/);

    await waitFor(
      () => shell.status().current && shell.status().current.generation > generation,
      'automatic runtime restart',
    );
    const reinitialized = await shell.handleMessage(initRequest(31));
    assert.equal(reinitialized.result.serverInfo.version, 'v1');
    assert.equal(payloadOf(await shell.handleMessage(callRequest(32, 'echo_v1'))).version, 'v1');
  } finally {
    await shell.close();
  }
});

test('workspace is resolved again for every runtime spawn', async () => {
  const fixture = makeFixture();
  const workspaceB = mkdtempSync(join(tmpdir(), 'zat-shell-work-b-'));
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1' });
  writePointer(fixture.pointerPath, v1, 'v1');
  let workspace = fixture.workspace;
  const { shell } = startShell(fixture, { resolveWorkspace: () => workspace });
  try {
    const init = await shell.handleMessage(initRequest());
    assert.match(init.result.instructions, new RegExp(`workspace=${workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(payloadOf(await shell.handleMessage(callRequest(40, 'echo_v1'))).workspace, fixture.workspace);

    workspace = workspaceB;
    const reloaded = await shell.reload({ force: true });
    assert.equal(reloaded.switched, true);
    assert.equal(payloadOf(await shell.handleMessage(callRequest(41, 'echo_v1'))).workspace, workspaceB);
    const reinit = await shell.handleMessage(initRequest(42));
    assert.match(reinit.result.instructions, new RegExp(`workspace=${workspaceB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    await shell.close();
  }
});

test('a missing pointer falls back to the packaged runtime entry', async () => {
  const fixture = makeFixture();
  const { shell } = startShell(fixture, { pluginRoot: undefined });
  try {
    const init = await shell.handleMessage(initRequest());
    assert.equal(init.result.serverInfo.name, 'ai-agent-teams');
    assert.equal(init.result.serverInfo.version, packageVersion);
    const list = await shell.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(list.result.tools.length, TOOL_DEFINITIONS.length);
    assert.ok(list.result.tools.some((tool) => tool.name === 'agent_teams_claim_task'));
    assert.ok(list.result.tools.some((tool) => tool.name === 'agent_teams_workspace'));
  } finally {
    await shell.close();
  }
});

test('the runtime is spawned from a content-addressed copy of the verified entry', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1' });
  const sha256 = sha256Of(v1);
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell, logs } = startShell(fixture);
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');
    const status = shell.status();
    assert.deepEqual(
      [await realpathAsync(status.current.originalEntry), basename(status.current.entry), sha256Of(status.current.entry)],
      [await realpathAsync(v1), `.runtime-${sha256}.mjs`, sha256],
    );
    assert.notEqual(await realpathAsync(status.current.entry), await realpathAsync(v1));
    assert.ok(logs.some((line) => /materialized runtime/.test(line)));

    // Changing the original after validation cannot change what is running,
    // and a later reload refuses the tampered file instead of spawning it.
    writeFileSync(v1, '// tampered after validation\n');
    const tampered = await shell.reload();
    assert.equal(tampered.switched, false);
    assert.match(tampered.error, /sha256 mismatch/);
    assert.equal(payloadOf(await shell.handleMessage(callRequest(90, 'echo_v1'))).version, 'v1');
  } finally {
    await shell.close();
  }
});

test('capabilities.tools is only injected when the runtime declares it', async () => {
  const fixture = makeFixture();
  const bare = writeRuntime(fixture.root, 'bare', { version: 'bare', capabilities: {} });
  writePointer(fixture.pointerPath, bare, 'bare');
  const { shell, logs } = startShell(fixture);
  try {
    const init = await shell.handleMessage(initRequest());
    assert.equal(init.result.capabilities.tools, undefined);
    assert.equal(shell.status().current.declaresTools, false);
    assert.ok(logs.some((line) => /does not declare capabilities\.tools/.test(line)));
  } finally {
    await shell.close();
  }
});

test('notifications dropped from a candidate buffer are counted and logged', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1' });
  const v2 = writeRuntime(fixture.root, 'v2', { version: 'v2', floodNotifications: 150 });
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell, logs } = startShell(fixture);
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');
    writePointer(fixture.pointerPath, v2, 'v2');
    const switched = await shell.reload();
    assert.equal(switched.switched, true);
    assert.ok(shell.status().droppedNotifications >= 50, JSON.stringify(shell.status()));
    assert.ok(logs.some((line) => /dropped .*notification/.test(line)));
  } finally {
    await shell.close();
  }
});

test('runtime -> host requests receive independent acceptance deadlines', async () => {
  const { protocol, records, hostRequests, notifications } = makeHostRequestProtocol(30);
  try {
    protocol.handleRuntimeRequest(records[0], hostRequest());
    protocol.handleRuntimeRequest(records[1], hostRequest());
    assert.equal(hostRequests.length, 2, 'unique host wire IDs allow the same runtime ID to be forwarded concurrently');
    assert.notEqual(hostRequests[0].id, hostRequests[1].id);
    await waitFor(() => records.every((record) => record.messages.some((message) => message.error)), 'independent host request timeouts');
    assert.deepEqual(records[0].messages[0], {
      jsonrpc: '2.0',
      id: 'shared-wire-id',
      error: { code: -32603, message: 'host did not answer within 30ms' },
    });
    assert.deepEqual(records[1].messages[0], records[0].messages[0]);
    assert.deepEqual(notifications.map((message) => message.params.requestId), [hostRequests[0].id, hostRequests[1].id]);
    assert.equal(protocol.hostRequests.size, 0);
    assert.equal(protocol.hostRequestResponses.size, 0);
  } finally {
    protocol.closeRequests();
  }
});

test('runtime -> host wire ids avoid host -> runtime pending ids', async () => {
  const { protocol, records, hostRequests } = makeHostRequestProtocol(1000);
  try {
    const hostWireId = 'shell:host:1';
    const pending = protocol.sendRequest(records[0], {
      jsonrpc: '2.0', id: hostWireId, method: 'tools/list',
    });
    protocol.handleRuntimeRequest(records[0], hostRequest());
    assert.equal(hostRequests.length, 1);
    assert.notEqual(hostRequests[0].id, hostWireId);
    protocol.handleRuntimeLine(records[0], JSON.stringify({
      jsonrpc: '2.0', id: hostWireId, result: { ok: true },
    }));
    assert.deepEqual(await pending, { jsonrpc: '2.0', id: hostWireId, result: { ok: true } });

    protocol.handleRuntimeRequest(records[0], hostRequest('second-runtime-request'));
    const generatedWireId = hostRequests[1].id;
    assert.notEqual(generatedWireId, hostWireId);
    const conflicting = protocol.sendRequest(records[0], {
      jsonrpc: '2.0', id: generatedWireId, method: 'tools/list',
    });
    assert.equal((await conflicting).error?.message, 'request id conflicts with an in-flight host request');
    assert.equal(records[0].messages.length, 1, 'conflicting request id is not sent to the runtime');
  } finally {
    protocol.closeRequests();
  }
});

test('runtime request ids reject in-flight duplicates and non-current generations', () => {
  const { protocol, records, hostRequests } = makeHostRequestProtocol(1000);
  try {
    protocol.handleRuntimeRequest(records[0], hostRequest('duplicate-id'));
    protocol.handleRuntimeRequest(records[0], hostRequest('duplicate-id'));
    assert.equal(hostRequests.length, 1);
    assert.deepEqual(records[0].messages[0], {
      jsonrpc: '2.0',
      id: 'duplicate-id',
      error: { code: -32600, message: 'duplicate in-flight server-to-client request id' },
    });

    protocol.routing.isRetiring = () => false;
    protocol.handleRuntimeRequest(records[1], hostRequest('stale-generation-id'));
    assert.equal(hostRequests.length, 1);
    assert.deepEqual(records[1].messages[0], {
      jsonrpc: '2.0',
      id: 'stale-generation-id',
      error: { code: -32601, message: 'runtime is not current; server-to-client requests are not forwarded' },
    });
  } finally {
    protocol.closeRequests();
  }
});

test('runtime cancellation notifications use the unique host wire id', () => {
  const notifications = [];
  const { protocol, records, hostRequests } = makeHostRequestProtocol(1000);
  protocol.onNotification = (message) => notifications.push(message);
  try {
    protocol.handleRuntimeRequest(records[0], hostRequest());
    const wireId = hostRequests[0].id;
    protocol.handleRuntimeLine(records[0], JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'shared-wire-id', reason: 'cancelled locally' },
    }));
    assert.deepEqual(notifications[0], {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: wireId, reason: 'cancelled locally' },
    });
    assert.equal(protocol.hostRequests.size, 0);
    assert.equal(protocol.hostRequestResponses.size, 0);

    protocol.routeHostResponse({ jsonrpc: '2.0', id: wireId, result: { late: true } });
    assert.equal(records[0].messages.length, 0, 'a late host response after cancellation is ignored');

    protocol.handleRuntimeLine(records[0], JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'shared-wire-id', reason: 'late cancellation' },
    }));
    assert.equal(notifications.length, 1, 'an unmatched runtime cancellation is not leaked to the host');
  } finally {
    protocol.closeRequests();
  }
});

test('host cancellation maps the wire id back to the owning runtime request', () => {
  const { protocol, records, hostRequests, notifications } = makeHostRequestProtocol(1000);
  try {
    protocol.handleRuntimeRequest(records[1], hostRequest('runtime-request'));
    const wireId = hostRequests[0].id;
    protocol.handleRuntimeLine(records[0], JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'runtime-request', reason: 'forged from another generation' },
    }));
    assert.equal(hostRequests.length, 1, 'another generation cannot cancel this request by original id');
    protocol.handleRuntimeLine(records[0], JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: wireId, reason: 'forged wire id from another generation' },
    }));
    assert.equal(hostRequests.length, 1, 'a guessed host wire id cannot cancel another generation request');
    protocol.forwardHostNotification({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: wireId, reason: 'cancelled by host' },
    });
    assert.deepEqual(records[1].messages[0], {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'runtime-request', reason: 'cancelled by host' },
    });
    assert.equal(protocol.hostRequests.size, 0);
    assert.equal(protocol.hostRequestResponses.size, 0);
    protocol.routeHostResponse({ jsonrpc: '2.0', id: wireId, result: { late: true } });
    assert.equal(records[1].messages.length, 1, 'a late response after host cancellation is ignored');
    protocol.forwardHostNotification({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: wireId, reason: 'duplicate cancellation' },
    });
    assert.equal(records[0].messages.length, 0, 'an unmatched host cancellation is not leaked to the current runtime');
    assert.equal(notifications.length, 0);
  } finally {
    protocol.closeRequests();
  }
});

test('a late host response cannot satisfy a retry that reuses the runtime request id', async () => {
  const { protocol, records, hostRequests } = makeHostRequestProtocol(30);
  try {
    protocol.handleRuntimeRequest(records[0], hostRequest());
    await waitFor(() => records[0].messages.some((message) => message.error), 'first host request timeout');
    const lateWireId = hostRequests[0].id;

    protocol.handleRuntimeRequest(records[0], hostRequest());
    assert.equal(hostRequests.length, 2, 'the timed-out runtime request ID can be reused immediately');
    const retryWireId = hostRequests[1].id;
    assert.notEqual(retryWireId, lateWireId);

    protocol.routeHostResponse({ jsonrpc: '2.0', id: lateWireId, result: { owner: 'late' } });
    assert.equal(records[0].messages.some((message) => message.result?.owner === 'late'), false);
    assert.equal(protocol.hostRequests.size, 1, 'a late response does not remove the retry');

    protocol.routeHostResponse({ jsonrpc: '2.0', id: retryWireId, result: { owner: 'retry' } });
    assert.deepEqual(records[0].messages.at(-1), {
      jsonrpc: '2.0',
      id: 'shared-wire-id',
      result: { owner: 'retry' },
    });
    assert.equal(protocol.hostRequests.size, 0);
    assert.equal(protocol.hostRequestResponses.size, 0);
  } finally {
    protocol.closeRequests();
  }
});

test('shell close cancels outstanding host requests even after closing begins', () => {
  const notifications = [];
  const { protocol, records, hostRequests } = makeHostRequestProtocol(5000);
  protocol.onNotification = (message) => notifications.push(message);
  protocol.handleRuntimeRequest(records[0], hostRequest('close-me'));
  const wireId = hostRequests[0].id;
  protocol.routing.isClosing = () => true;
  protocol.closeRequests();
  assert.deepEqual(notifications, [{
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: wireId, reason: 'agent-teams shell closed' },
  }]);
  assert.equal(protocol.hostRequests.size, 0);
  assert.equal(protocol.hostRequestResponses.size, 0);
  protocol.routeHostResponse({ jsonrpc: '2.0', id: wireId, result: { late: true } });
  assert.equal(records[0].messages.length, 0);
});

test('runtime exit releases exposed runtime -> host request mappings', () => {
  const { protocol, records, hostRequests } = makeHostRequestProtocol(5000);
  protocol.handleRuntimeRequest(records[0], hostRequest());
  assert.equal(hostRequests.length, 1);
  const wireId = hostRequests[0].id;
  protocol.failHostRequests(records[0], 'runtime exited');
  assert.equal(protocol.hostRequests.size, 0);
  assert.equal(protocol.hostRequestResponses.size, 0);
  protocol.routeHostResponse({ jsonrpc: '2.0', id: wireId, result: { late: true } });
  assert.equal(records[0].messages.some((message) => message.result?.late), false);
  protocol.closeRequests();
});

test('runtime -> host request tracking has a fixed capacity', () => {
  const { protocol, records, hostRequests } = makeHostRequestProtocol(5000);
  try {
    for (let index = 0; index < 1001; index += 1) {
      protocol.handleRuntimeRequest(records[0], hostRequest(`request-${index}`));
    }
    assert.equal(protocol.hostRequests.size, 1000);
    assert.equal(protocol.hostRequestResponses.size, 1000);
    assert.equal(hostRequests.length, 1000);
    assert.deepEqual(records[0].messages.at(-1), {
      jsonrpc: '2.0',
      id: 'request-1000',
      error: { code: -32603, message: 'host request capacity is full' },
    });
  } finally {
    protocol.closeRequests();
  }
  assert.equal(protocol.hostRequests.size, 0);
  assert.equal(protocol.hostRequestResponses.size, 0);
});

test('runtime -> host request ids must be strings or finite numbers', () => {
  const { protocol, records, hostRequests } = makeHostRequestProtocol(1000);
  try {
    for (const id of [true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      protocol.handleRuntimeRequest(records[0], hostRequest(id));
    }
    assert.equal(hostRequests.length, 0);
    assert.equal(protocol.hostRequests.size, 0);
    assert.equal(records[0].messages.length, 5);
    assert.ok(records[0].messages.every((message) => message.error.code === -32600));
  } finally {
    protocol.closeRequests();
  }
});

test('an asynchronously rejected host sink clears and fails only its own request', async () => {
  const hostRequests = [];
  const records = [1, 2].map((generation) => {
    const record = { generation, exited: false, stopping: false, messages: [] };
    record.child = { stdin: { write: (line) => record.messages.push(JSON.parse(line)) } };
    return record;
  });
  const protocol = new ShellProtocol({
    routing: { current: () => records[0], isRetiring: (record) => record === records[1], isClosing: () => false },
    onNotification: () => {},
    onHostRequest: (message) => {
      hostRequests.push(message);
      return message.method === 'reject' ? Promise.reject(new Error('sink rejected')) : undefined;
    },
    log: () => {}, hostRequestTimeoutMs: 1000, healthTimeoutMs: 100, packageVersion,
  });
  try {
    protocol.handleRuntimeRequest(records[0], { ...hostRequest(), method: 'reject' });
    protocol.handleRuntimeRequest(records[1], hostRequest('other-id'));
    await waitFor(() => records[0].messages.some((message) => message.error), 'async host sink error');
    assert.equal(records[0].messages[0].error.message, 'failed to forward the request to the host');
    assert.equal(protocol.hostRequests.size, 1);
    assert.equal(protocol.hostRequestResponses.size, 1);
    protocol.routeHostResponse({ jsonrpc: '2.0', id: hostRequests[1].id, result: { ok: true } });
    assert.deepEqual(records[1].messages[0], { jsonrpc: '2.0', id: 'other-id', result: { ok: true } });
  } finally {
    protocol.closeRequests();
  }
});

test('runtime -> host requests are forwarded and their host responses routed back', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1', askHost: true });
  writePointer(fixture.pointerPath, v1, 'v1');
  const hostRequests = [];
  const { shell } = startShell(fixture, { onHostRequest: (message) => hostRequests.push(message) });
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');
    const pendingCall = shell.handleMessage(callRequest(100, 'ask-host'));
    await waitFor(() => hostRequests.length === 1, 'runtime -> host request');
    assert.equal(hostRequests[0].method, 'roots/list');
    assert.equal(shell.status().hostRequests, 1);

    assert.equal(
      await shell.handleMessage({ jsonrpc: '2.0', id: hostRequests[0].id, result: { roots: [] } }),
      null,
    );
    const payload = payloadOf(await pendingCall);
    assert.deepEqual(payload.serverResponse.result, { roots: [] });
    assert.equal(shell.status().hostRequests, 0);
  } finally {
    await shell.close();
  }
});

test('runtime -> host requests with the same id stay isolated across a hot switch', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1', askHost: true, hostRequestId: 'shared-id' });
  const v2 = writeRuntime(fixture.root, 'v2', { version: 'v2', askHost: true, hostRequestId: 'shared-id' });
  writePointer(fixture.pointerPath, v1, 'v1');
  const hostRequests = [];
  const { shell } = startShell(fixture, { onHostRequest: (message) => hostRequests.push(message) });
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');
    const oldCall = shell.handleMessage(callRequest(102, 'ask-host'));
    await waitFor(() => hostRequests.length === 1, 'old runtime host request');
    const oldHostRequestId = hostRequests[0].id;
    assert.notEqual(oldHostRequestId, 'shared-id');

    writePointer(fixture.pointerPath, v2, 'v2');
    assert.equal((await shell.reload()).switched, true);
    const newCall = shell.handleMessage(callRequest(103, 'ask-host'));
    await waitFor(() => shell.status().current?.pending === 1, 'new runtime host request');
    await waitFor(() => hostRequests.length === 2, 'new runtime host request');
    const newHostRequestId = hostRequests[1].id;
    assert.notEqual(newHostRequestId, oldHostRequestId);
    assert.notEqual(newHostRequestId, 'shared-id');

    await shell.handleMessage({ jsonrpc: '2.0', id: oldHostRequestId, result: { owner: 'old' } });
    assert.deepEqual(payloadOf(await oldCall).serverResponse.result, { owner: 'old' });
    await shell.handleMessage({ jsonrpc: '2.0', id: newHostRequestId, result: { owner: 'new' } });
    assert.deepEqual(payloadOf(await newCall).serverResponse.result, { owner: 'new' });
    await shell.whenIdle();
    assert.equal(shell.status().hostRequests, 0);
  } finally {
    await shell.close();
  }
});

test('a late old-generation host response cannot satisfy the new runtime request with the same id', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1', askHost: true, hostRequestId: 'shared-late-id' });
  const v2 = writeRuntime(fixture.root, 'v2', { version: 'v2', askHost: true, hostRequestId: 'shared-late-id' });
  writePointer(fixture.pointerPath, v1, 'v1');
  const hostRequests = [];
  const { shell } = startShell(fixture, {
    drainTimeoutMs: 100,
    killGraceMs: 50,
    onHostRequest: (message) => hostRequests.push(message),
  });
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');
    const oldCall = shell.handleMessage(callRequest(105, 'ask-host'));
    await waitFor(() => hostRequests.length === 1, 'old runtime host request');
    const oldHostRequestId = hostRequests[0].id;

    writePointer(fixture.pointerPath, v2, 'v2');
    assert.equal((await shell.reload()).switched, true);
    const newCall = shell.handleMessage(callRequest(106, 'ask-host'));
    await waitFor(() => shell.status().current?.pending === 1, 'new runtime host request');
    const failedOldCall = await oldCall;
    assert.match(failedOldCall.error?.message ?? '', /drain timeout/);
    assert.equal(hostRequests.length, 2, 'new runtime gets an independent host wire ID');
    const newHostRequestId = hostRequests[1].id;
    assert.notEqual(newHostRequestId, oldHostRequestId);
    assert.notEqual(newHostRequestId, 'shared-late-id');

    await shell.handleMessage({ jsonrpc: '2.0', id: oldHostRequestId, result: { owner: 'late-old' } });
    await shell.handleMessage({ jsonrpc: '2.0', id: newHostRequestId, result: { owner: 'new' } });
    assert.deepEqual(payloadOf(await newCall).serverResponse.result, { owner: 'new' });
    await shell.whenIdle();
  } finally {
    await shell.close();
  }
});

test('runtime stdout enforces the byte limit across fragments and resumes after oversized lines', { timeout: 30000 }, async () => {
  const maxBytes = 8 * 1024 * 1024;
  const fixture = makeFixture();
  const notificationLine = (data) => JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data },
  });
  const exactLine = notificationLine('x'.repeat(maxBytes - notificationLine('').length));
  assert.equal(Buffer.byteLength(exactLine), maxBytes);
  const oversizedLine = notificationLine('y'.repeat(maxBytes + 1 - notificationLine('').length));
  assert.equal(Buffer.byteLength(oversizedLine), maxBytes + 1);
  const probe = {
    exactPayloadLength: maxBytes - notificationLine('').length,
    oversizedPayloadLength: maxBytes + 1 - notificationLine('').length,
  };
  const runtime = writeRuntime(fixture.root, 'probe', { version: 'probe', stdoutProbe: probe });
  writePointer(fixture.pointerPath, runtime, 'probe');
  const { shell, notifications, logs } = startShell(fixture, { healthTimeoutMs: 10000 });
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'probe');
    assert.equal(payloadOf(await shell.handleMessage(callRequest(104, 'stdout-probe'))).version, 'probe');
    await waitFor(() => notifications.some((message) => message.params?.data === 'after-crlf'), 'valid notifications after oversized line');
    assert.ok(notifications.some((message) => message.params?.data?.length === probe.exactPayloadLength), 'exact-limit line is processed');
    assert.ok(notifications.some((message) => message.params?.data === 'after-lf'));
    assert.equal(notifications.some((message) => message.params?.data?.startsWith('yyyy')), false, 'oversized line is discarded rather than parsed');
    assert.ok(logs.some((line) => /oversized stdout line/.test(line)));
  } finally {
    await shell.close();
  }
});

test('runtime -> host requests get -32601 when no host request channel exists', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1', askHost: true });
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell, logs } = startShell(fixture);
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');
    const payload = payloadOf(await shell.handleMessage(callRequest(101, 'ask-host')));
    assert.equal(payload.serverResponse.error.code, -32601);
    assert.ok(logs.some((line) => /no host request channel/.test(line)));
  } finally {
    await shell.close();
  }
});

test('host initialize is serialized with a hot switch', async () => {
  const fixture = makeFixture();
  const v1 = writeRuntime(fixture.root, 'v1', { version: 'v1' });
  const v2 = writeRuntime(fixture.root, 'v2', { version: 'v2', initDelayMs: 250 });
  writePointer(fixture.pointerPath, v1, 'v1');
  const { shell } = startShell(fixture);
  try {
    assert.equal((await shell.handleMessage(initRequest())).result.serverInfo.version, 'v1');
    writePointer(fixture.pointerPath, v2, 'v2');

    const switching = shell.reload();
    // Queued after the switch: this initialize must be answered by v2, not by
    // the runtime that is about to be replaced.
    const reinitialize = shell.handleMessage(initRequest(110));
    const switched = await switching;
    assert.equal(switched.switched, true);
    const response = await reinitialize;
    assert.equal(response.result.serverInfo.version, 'v2');
    assert.equal(shell.status().current.version, 'v2');
  } finally {
    await shell.close();
  }
});

function startMcpProcess(cwd) {
  const child = spawn(process.execPath, [shellEntry], {
    cwd,
    env: { ...process.env, ...isolatedEnv, CLAUDE_PROJECT_DIR: cwd },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const messages = [];
  const waiters = new Map();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    messages.push(message);
    if (message.id === undefined || message.id === null) return;
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
  });
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  return {
    child,
    messages,
    exited,
    request(message, timeoutMs = 15000) {
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          waiters.delete(message.id);
          rejectPromise(new Error(`timed out waiting for MCP response id=${message.id}`));
        }, timeoutMs);
        timer.unref?.();
        waiters.set(message.id, (response) => {
          clearTimeout(timer);
          resolvePromise(response);
        });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
  };
}

test('src/mcp-server.mjs keeps the shell over stdio and reports parse errors', { timeout: 30000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'zat-shell-process-'));
  const proc = startMcpProcess(workspace);
  try {
    const init = await proc.request(initRequest(1));
    assert.equal(init.result.serverInfo.name, 'ai-agent-teams');
    assert.equal(init.result.serverInfo.version, packageVersion);

    proc.child.stdin.write('not json\n');
    await waitFor(() => proc.messages.some((message) => message.id === null && message.error?.code === -32700), 'parse error response');

    const list = await proc.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(list.result.tools.length, TOOL_DEFINITIONS.length);
  } finally {
    proc.child.stdin.end();
    await Promise.race([proc.exited, sleep(5000)]);
    if (proc.child.exitCode === null && proc.child.signalCode === null) {
      proc.child.kill('SIGKILL');
    }
  }
});
