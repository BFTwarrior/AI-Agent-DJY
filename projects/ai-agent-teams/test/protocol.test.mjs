import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient, parseModelRef, ProtocolSessionAdapter, teamCliFooter } from '../src/session/protocol.mjs';

async function waitUntil(predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeWritable extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.writes = [];
    this.acceptNext = true;
  }

  write(chunk) {
    this.writes.push(String(chunk));
    return this.acceptNext;
  }
}

/**
 * A client wired to an in-memory child. `start()` is already resolved so the
 * tests can exercise stdin/stdout limits without spawning a real CLI.
 */
function fakeWire(options = {}) {
  const client = new AppServerClient(options);
  const stdin = new FakeWritable();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = { pid: undefined, exitCode: null, stdin, stdout, stderr, kill() {} };
  client.child = child;
  client.startPromise = Promise.resolve();
  client.attachOutput(child);
  return { client, child, stdin, stdout };
}

function writtenIds(stdin) {
  return stdin.writes.map((line) => JSON.parse(line.trim()).id);
}

test('model refs carry provider, model and reasoning', () => {
  assert.deepEqual(parseModelRef('provider-a/model-x', 'max'), {
    providerId: 'provider-a',
    modelId: 'model-x',
    options: { reasoningLevel: 'max' },
  });
  assert.throws(() => parseModelRef('bare-model'), /providerId\/modelId/);
});

test('structured native model selections preserve slash-containing IDs and own reasoning', () => {
  const selection = { providerId: 'provider/team', modelId: 'catalog/deepseek', options: { reasoningLevel: 'high' } };
  assert.deepEqual(parseModelRef(selection, 'max'), selection);
  assert.deepEqual(parseModelRef({ providerId: 'provider/team', modelId: 'catalog/deepseek' }, 'max'), {
    providerId: 'provider/team', modelId: 'catalog/deepseek',
  });
  for (const invalid of [{}, [], { providerId: '', modelId: 'm' }, { providerId: 'p', modelId: ' ' },
    { providerId: 'p', modelId: 'm', options: null }, { providerId: 'p', modelId: 'm', options: { reasoningLevel: 3 } }]) {
    assert.throws(() => parseModelRef(invalid), /model selection/);
  }
});

test('native model selection is validated before create and reaches setModel unchanged', async () => {
  const calls = [];
  const adapter = new ProtocolSessionAdapter({ client: {
    async request(method, params) {
      calls.push({ method, params });
      return method === 'session/create' ? { session: { sessionId: 'native-1' } } : {};
    },
  } });
  await assert.rejects(adapter.create({ modelSelection: { providerId: '', modelId: 'm' } }), /model selection/);
  assert.equal(calls.length, 0);
  const selection = { providerId: 'provider/team', modelId: 'catalog/deepseek' };
  await adapter.create({ teamId: 'alpha', memberName: 'worker', prompt: 'task', modelSelection: selection, reasoning: 'max' });
  assert.deepEqual(calls.map((call) => call.method), ['session/create', 'session/setModel']);
  assert.deepEqual(calls[1].params.model, selection);
  assert.equal(calls[1].params.persistAsWorkspaceLastUsed, false, 'never change the captain workspace default');
  await adapter.setModel({ sessionId: 'native-1', modelSelection: { ...selection, options: { reasoningLevel: 'high' } } });
  assert.equal(calls.at(-1).params.model.options.reasoningLevel, 'high');
});

test('native selection rejection cleans up the new session without sending a turn', async () => {
  const calls = [];
  const adapter = new ProtocolSessionAdapter({ client: {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session/create') return { session: { sessionId: 'rejected-native' } };
      if (method === 'session/setModel') throw new Error('model unavailable');
      return {};
    },
  } });
  await assert.rejects(adapter.create({
    modelSelection: { providerId: 'provider/team', modelId: 'catalog/deepseek' },
  }), /protocol setModel failed for provider\/team\/catalog\/deepseek: model unavailable/);
  assert.deepEqual(calls.map((call) => call.method), [
    'session/create', 'session/setModel', 'session/stop', 'session/close',
  ]);
  assert.equal(adapter.sessions.has('rejected-native'), false);
  assert.equal((await adapter.send({ sessionId: 'rejected-native', message: 'must not run' })).ok, false);
  assert.equal(calls.length, 4);
});

test('invalid structured hot selection never reaches the protocol transport', async () => {
  let requests = 0;
  const adapter = new ProtocolSessionAdapter({ client: { async request() { requests += 1; } } });
  await assert.rejects(adapter.setModel({
    sessionId: 'existing', model: 'host/gpt', modelSelection: { providerId: 'p', modelId: '' },
  }), /model selection/);
  assert.equal(requests, 0, 'an invalid pin cannot fall back to the supplied display model');
});

test('team CLI footer includes team and member identity', () => {
  const footer = teamCliFooter('alpha', 'a1', 'member-token');
  assert.match(footer, /AGENT_TEAMS_TOKEN="member-token"/);
  assert.match(footer, /AGENT_TEAMS_TEAM="alpha"/);
  assert.match(footer, /AGENT_TEAMS_MEMBER="a1"/);
  assert.match(footer, /claim <taskId> <attemptId>/);
});

test('protocol create forwards toolDenylist', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session/create') return { session: { sessionId: 's1' } };
      return {};
    },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  await adapter.create({ teamId: 'alpha', memberName: 'a1', cwd: 'D:/work', prompt: '', disallowedTools: ['Edit', 'Bash'] });
  const create = calls.find((call) => call.method === 'session/create');
  assert.deepEqual(create.params.toolDenylist, ['Edit', 'Bash']);
});

test('protocol adapter creates, sends, sets model and stops', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session/create') return { session: { sessionId: 's1' } };
      return {};
    },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  const created = await adapter.create({ teamId: 'alpha', memberName: 'a1', cwd: 'D:/work', prompt: 'hello' });
  assert.equal(created.sessionId, 's1');
  await adapter.send({ sessionId: 's1', message: 'do the task' });
  await adapter.send({ sessionId: 's1', message: 'urgent correction', delivery: 'guide' });
  await adapter.setModel({ sessionId: 's1', model: 'provider-a/model-x', reasoning: 'max' });
  await adapter.stop({ sessionId: 's1' });
  assert.ok(calls.some((call) => call.method === 'session/create'));
  assert.ok(calls.some((call) => call.method === 'session/send' && call.params.content.includes('Team CLI')));
  assert.ok(calls.some((call) => call.method === 'session/setModel' && call.params.model.options.reasoningLevel === 'max'));
  assert.ok(calls.filter((call) => call.method === 'session/stop').length >= 1);
});

test('protocol stop treats an already-forgotten session as stopped', async () => {
  const client = {
    async request(method) {
      if (method === 'session/stop') throw new Error('unknown session: s9');
      return {};
    },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  const result = await adapter.stop({ sessionId: 's9' });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyStopped, true);

  const broken = {
    async request() { throw new Error('session/stop exploded'); },
    async close() {},
  };
  const brokenAdapter = new ProtocolSessionAdapter({ client: broken, cwd: 'D:/work' });
  await assert.rejects(() => brokenAdapter.stop({ sessionId: 's1' }), /exploded/);
});

test('protocol send can wait for and return the assistant response', async () => {
  let sent = false;
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session/create') return { session: { sessionId: 's1' } };
      if (method === 'session/messages') {
        return {
          messages: sent
            ? [
              { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'task' }] },
              { info: { id: 'a1', role: 'assistant', finish: 'stop', tokens: { input: 3, output: 2, total: 5 } }, parts: [{ type: 'text', text: 'OK' }] },
            ]
            : [{ info: { id: 'u0', role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }],
        };
      }
      if (method === 'session/send') { sent = true; return { accepted: true }; }
      return {};
    },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  await adapter.create({ teamId: 'alpha', memberName: 'a1', cwd: 'D:/work', prompt: 'hello' });
  const result = await adapter.send({ sessionId: 's1', message: 'task', wait: true, timeoutMs: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.response, 'OK');
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  assert.ok(calls.some((call) => call.method === 'session/send' && call.params.content.includes('hello')
    && call.params.content.includes('task')));
});

test('protocol create mounts only the member-scoped agent-teams MCP server by default', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session/create') return { session: { sessionId: 's1' } };
      return {};
    },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  await adapter.create({ teamId: 'alpha', memberName: 'a1', cwd: 'D:/work', prompt: '', token: 'mt_1' });
  const create = calls.find((call) => call.method === 'session/create');
  assert.equal(create.params.mcpServers.length, 1);
  assert.equal(create.params.mcpServers[0].name, 'agent-teams-member');
  assert.equal(create.params.mcpServers[0].env.find((item) => item.name === 'AGENT_TEAMS_TOKEN').value, 'mt_1');
  assert.equal(create.params.mcpServers[0].env.find((item) => item.name === 'AGENT_TEAMS_TEAM').value, 'alpha');
  assert.equal(create.params.mcpServers[0].env.find((item) => item.name === 'AGENT_TEAMS_MEMBER').value, 'a1');
  assert.equal(create.params.mcpServers[0].env.find((item) => item.name === 'AGENT_TEAMS_AUTOSTART').value, '0');
});

test('protocol create grants the shadow MCP identity only to an explicit shadow', async () => {
  const creates = [];
  const adapter = new ProtocolSessionAdapter({ client: {
    async request(method, params) {
      assert.equal(method, 'session/create');
      creates.push(params);
      return { session: { sessionId: `identity-${creates.length}` } };
    },
  } });
  for (const shadow of [true, false, undefined]) {
    await adapter.create({ teamId: 'alpha', memberName: 'worker', token: 'mt_identity', shadow });
  }
  const shadowEntries = creates.map((params) => params.mcpServers[0].env
    .filter((item) => item.name === 'AGENT_TEAMS_SHADOW'));
  assert.deepEqual(shadowEntries, [[{ name: 'AGENT_TEAMS_SHADOW', value: '1' }], [], []]);
});

test('protocol watcher reports turn-failed without waiting for a lease', async () => {
  let failed;
  const failure = new Promise((resolve) => { failed = resolve; });
  const client = {
    async request(method, params) {
      if (method === 'session/events') {
        if (params.afterSeq < 7) {
          return { events: [{ type: 'turn.failed', sequenceNumber: 7, payload: { error: { message: 'group requests-per-minute limit exceeded', retryable: true } } }] };
        }
        return { events: [] };
      }
      return {};
    },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  const handle = adapter.watchTurn({
    sessionId: 's1', afterSeq: 0, intervalMs: 1, timeoutMs: 1000,
    onFailed: (error) => { failed(error); },
  });
  const error = await Promise.race([failure, new Promise((_, reject) => setTimeout(() => reject(new Error('watch timeout')), 1000))]);
  handle.cancel();
  assert.match(error.message, /requests-per-minute/);
});

test('protocol turn cursor returns the highest event sequence', async () => {
  const client = {
    async request(method, params) {
      assert.equal(method, 'session/events');
      assert.equal(params.afterSeq, 0);
      return { events: [{ sequenceNumber: 2 }, { seq: 9 }, { sequenceNumber: 4 }] };
    },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  assert.equal(await adapter.turnCursor({ sessionId: 's1' }), 9);
});

test('protocol watcher treats non-success turn.completed result types as failures', async () => {
  const failed = new Promise((resolve) => {
    const client = {
      async request(method, _params) {
        if (method === 'session/events') {
          return { events: [{ type: 'turn.completed', sequenceNumber: 3, payload: { resultType: 'error_max_turns' } }] };
        }
        return {};
      },
      async close() {},
    };
    const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
    adapter.watchTurn({ sessionId: 's1', afterSeq: 0, intervalMs: 1, timeoutMs: 1000, onFailed: resolve });
  });
  const error = await Promise.race([failed, new Promise((_, reject) => setTimeout(() => reject(new Error('watch timeout')), 1000))]);
  assert.match(error.message, /error_max_turns/);
});

test('protocol watcher does not fire callbacks after cancel during an in-flight poll', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const client = {
    async request(method) {
      if (method === 'session/events') {
        calls += 1;
        await blocked;
        return { events: [{ type: 'turn.failed', sequenceNumber: 1, payload: { error: { message: 'late failure' } } }] };
      }
      return {};
    },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  let fired = false;
  const handle = adapter.watchTurn({
    sessionId: 's1', afterSeq: 0, intervalMs: 1, timeoutMs: 1000,
    onFailed: () => { fired = true; },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  handle.cancel();
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fired, false);
  assert.equal(calls, 1);
});

test('protocol watcher treats cancelled turn.completed as retryable failure', async () => {
  const failed = new Promise((resolve) => {
    const client = {
      async request(method) {
        if (method === 'session/events') {
          return { events: [{ type: 'turn.completed', sequenceNumber: 4, payload: { resultType: 'cancelled' } }] };
        }
        return {};
      },
      async close() {},
    };
    const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
    adapter.watchTurn({ sessionId: 's1', afterSeq: 0, intervalMs: 1, timeoutMs: 1000, onFailed: resolve });
  });
  const error = await Promise.race([failed, new Promise((_, reject) => setTimeout(() => reject(new Error('watch timeout')), 1000))]);
  assert.match(error.message, /cancelled/);
});

test('protocol compact waits for the compact turn to complete', async () => {
  let eventCalls = 0;
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session/create') return { session: { sessionId: 's1' } };
      if (method === 'session/events') {
        eventCalls += 1;
        if (eventCalls === 1) return { events: [] };
        return { events: [{ type: 'turn.completed', sequenceNumber: 2, payload: { resultType: 'success', response: 'Compacted' } }] };
      }
      if (method === 'session/compact') return { compact: { state: 'accepted' } };
      return {};
    },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  await adapter.create({ teamId: 'alpha', memberName: 'a1', cwd: 'D:/work', prompt: '' });
  const result = await adapter.compact({ sessionId: 's1', instructions: 'summarize', timeoutMs: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'completed');
  assert.ok(calls.some((call) => call.method === 'session/compact' && call.params.instructions === 'summarize'));
});

test('protocol resume restores a closed session record for the next send', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session/create') return { session: { sessionId: 's1' } };
      if (method === 'session/resume') return { session: { sessionId: 's1' } };
      return {};
    },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  await adapter.create({ teamId: 'alpha', memberName: 'a1', cwd: 'D:/work', prompt: '' });
  await adapter.close({ sessionId: 's1' });
  const resumed = await adapter.resume({ sessionId: 's1', cwd: 'D:/work' });
  assert.equal(resumed.ok, true);
  const sent = await adapter.send({ sessionId: 's1', message: 'after resume' });
  assert.equal(sent.ok, true);
  assert.ok(calls.some((call) => call.method === 'session/send' && call.params.content.includes('after resume')));
});

const READY_SCRIPT = [
  "process.stdout.write(JSON.stringify({ method: 'startup/storageState', params: { phase: 'ready' } }) + '\\n');",
  'setInterval(() => {}, 1000);',
].join('\n');

test('app-server start is retryable after a spawn error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-protocol-spawn-'));
  const good = join(dir, 'good.mjs');
  writeFileSync(good, READY_SCRIPT);
  const client = new AppServerClient({ cliPath: 'ai-agent-teams-missing-cli-for-test', cwd: process.cwd(), timeoutMs: 5000 });
  try {
    await assert.rejects(() => client.start(), /ENOENT|not found/i);
    assert.equal(client.startPromise, undefined, 'a failed spawn must not stay cached');
    client.cliPath = good;
    await client.start();
    assert.ok(client.child, 'the retry must spawn a new app-server');
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test('app-server start is retryable after a pre-ready stderr failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-protocol-'));
  const bad = join(dir, 'bad.mjs');
  const good = join(dir, 'good.mjs');
  writeFileSync(bad, "process.stderr.write('boom: no app-server\\n');\\nprocess.exit(2);\\n");
  writeFileSync(good, READY_SCRIPT);
  const client = new AppServerClient({ cliPath: bad, cwd: process.cwd(), timeoutMs: 5000 });
  try {
    await assert.rejects(() => client.start(), /boom: no app-server/);
    assert.equal(client.startPromise, undefined, 'a rejected start promise must not stay cached');
    client.cliPath = good;
    await client.start();
    assert.ok(client.child, 'the retry must spawn a new app-server');
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test('app-server startup timeout kills the wrapper and grandchild tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-protocol-timeout-'));
  const marker = join(dir, 'app-server.pid');
  const grandMarker = join(dir, 'grandchild.pid');
  const hang = join(dir, 'hang.mjs');
  const grandchild = join(dir, 'grandchild.mjs');
  const good = join(dir, 'good.mjs');
  writeFileSync(grandchild, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(grandMarker)}, String(process.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  writeFileSync(hang, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
    `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  writeFileSync(good, READY_SCRIPT);
  const client = new AppServerClient({ cliPath: hang, cwd: process.cwd(), timeoutMs: 800 });
  try {
    await assert.rejects(() => client.start(), /did not become ready within 800ms/);
    assert.equal(client.startPromise, undefined, 'a timed-out start promise must not stay cached');
    assert.equal(await waitUntil(() => existsSync(marker) && existsSync(grandMarker)), true, 'fake app-server tree never started');
    const pid = Number(readFileSync(marker, 'utf8'));
    const grandPid = Number(readFileSync(grandMarker, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.ok(Number.isInteger(grandPid) && grandPid > 0);
    assert.equal(await waitUntil(() => !isAlive(pid)), true, `wrapper ${pid} survived the startup timeout`);
    assert.equal(await waitUntil(() => !isAlive(grandPid)), true, `grandchild ${grandPid} survived the startup timeout`);
    client.cliPath = good;
    await client.start();
    assert.ok(client.child, 'the retry must spawn a new app-server');
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test('a closed stdin invalidates the client and the next request restarts it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-protocol-stdin-'));
  const good = join(dir, 'good.mjs');
  writeFileSync(good, READY_SCRIPT);
  const client = new AppServerClient({ cliPath: good, cwd: process.cwd(), timeoutMs: 5000 });
  try {
    await client.start();
    const first = client.child;
    assert.ok(first);
    Object.defineProperty(first.stdin, 'writable', { value: false, configurable: true });
    await assert.rejects(() => client.request('session/list', {}), /stdin is closed/);
    assert.equal(client.startPromise, undefined, 'the broken client must not stay cached');
    assert.equal(client.child, undefined, 'the broken child must be discarded');
    await client.start();
    assert.ok(client.child, 'the next request must start a fresh app-server');
    assert.notEqual(client.child, first);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test('oversized app-server frames fail closed, reject pending and allow a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-teams-protocol-frame-'));
  const good = join(dir, 'good.mjs');
  writeFileSync(good, READY_SCRIPT);
  const { client, stdout } = fakeWire({ maxFrameBytes: 64 });
  try {
    const pending = client.request('session/list', {}).catch((error) => error);
    await tick();
    assert.equal(client.pending.size, 1);
    stdout.emit('data', Buffer.from('x'.repeat(128)));
    const error = await pending;
    assert.equal(error.code, 'E_PROTOCOL_FRAME_TOO_LARGE');
    assert.match(error.message, /frame exceeded 64 bytes/);
    assert.equal(client.pending.size, 0);
    assert.equal(client.child, undefined);
    assert.equal(client.startPromise, undefined);
    client.maxFrameBytes = 1024;
    client.cliPath = good;
    await client.start();
    assert.ok(client.child, 'the next start must spawn a fresh app-server');
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test('pending request limit rejects before writing and leaves no placeholder', async () => {
  const { client, stdin } = fakeWire({ maxPendingRequests: 2 });
  const first = client.request('session/list', {}).catch((error) => error);
  await tick();
  const second = client.request('session/list', {}).catch((error) => error);
  await tick();
  assert.equal(client.pending.size, 2);
  const error = await client.request('session/list', {}).catch((reason) => reason);
  assert.equal(error.code, 'E_PROTOCOL_PENDING_LIMIT');
  assert.equal(error.method, 'session/list');
  assert.equal(error.requestWritten, false, 'the rejection identifies this request as not written');
  assert.equal(client.pending.size, 2, 'the rejected request must not occupy a pending slot');
  assert.equal(stdin.writes.length, 2, 'the rejected request must not write stdin');
  await client.close();
  assert.match((await first).message, /app-server closed/);
  assert.match((await second).message, /app-server closed/);
});

test('stdin backpressure queues writes in order and flushes after drain', async () => {
  const { client, stdin } = fakeWire({ maxQueuedWriteBytes: 1024 });
  stdin.acceptNext = false;
  const first = client.request('a', {}).catch((error) => error);
  await tick();
  const second = client.request('b', {}).catch((error) => error);
  await tick();
  const third = client.request('c', {}).catch((error) => error);
  await tick();
  assert.equal(stdin.writes.length, 1, 'only the backpressured write reached the stream');
  assert.deepEqual(writtenIds(stdin), [1]);
  assert.equal(client.writeQueue.length, 2);
  stdin.acceptNext = true;
  stdin.emit('drain');
  assert.deepEqual(writtenIds(stdin), [1, 2, 3], 'queued writes must flush in order');
  assert.equal(client.writeQueue.length, 0);
  for (const id of [1, 2, 3]) client.handleLine(JSON.stringify({ id, result: {} }), client.child);
  assert.deepEqual(await first, {});
  assert.deepEqual(await second, {});
  assert.deepEqual(await third, {});
  await client.close();
});

test('queued write bytes beyond the limit reset the client and reject waiters', async () => {
  const { client, stdin } = fakeWire({ maxQueuedWriteBytes: 8 });
  stdin.acceptNext = false;
  const first = client.request('a', {}).catch((error) => error);
  await tick();
  const second = client.request('b', {}).catch((error) => error);
  const secondError = await second;
  assert.equal(secondError.code, 'E_PROTOCOL_WRITE_QUEUE_LIMIT');
  const firstError = await first;
  assert.equal(firstError.code, 'E_PROTOCOL_WRITE_QUEUE_LIMIT');
  assert.equal(client.pending.size, 0);
  assert.equal(client.writeQueue.length, 0);
  assert.equal(client.queuedWriteBytes, 0);
  assert.equal(client.child, undefined);
  assert.equal(client.startPromise, undefined);
});

test('close rejects requests still queued behind drain', async () => {
  const { client, stdin } = fakeWire({ maxQueuedWriteBytes: 1024 });
  stdin.acceptNext = false;
  const first = client.request('a', {}).catch((error) => error);
  await tick();
  const second = client.request('b', {}).catch((error) => error);
  await tick();
  assert.equal(client.writeQueue.length, 1);
  await client.close();
  assert.match((await first).message, /app-server closed/);
  assert.match((await second).message, /app-server closed/);
  assert.equal(client.writeQueue.length, 0);
  assert.equal(client.writeBlocked, false);
});

test('protocol termination proof requires a confirmed close and an absent server session', async () => {
  let listed = [{ sessionId: 's1' }];
  const client = {
    async request(method) {
      if (method === 'session/create') return { session: { sessionId: 's1' } };
      if (method === 'session/list') return { sessions: listed };
      return {};
    },
    pendingForSession() { return 0; },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  assert.equal((await adapter.verifySessionTermination({ sessionId: 's1' })).verified, false);
  await adapter.create({ teamId: 'alpha', memberName: 'a1', prompt: '' });
  const closed = await adapter.close({ sessionId: 's1' });
  assert.equal(closed.ok, true);
  const stillListed = await adapter.verifySessionTermination({ sessionId: 's1' });
  assert.equal(stillListed.verified, false);
  assert.equal(stillListed.sideEffectsRevoked, false);
  listed = [];
  const gone = await adapter.verifySessionTermination({ sessionId: 's1' });
  assert.deepEqual(gone, { verified: true, sessionId: 's1', sideEffectsRevoked: true });
});

test('protocol termination proof never fails open when session/list fails', async () => {
  let fail = false;
  const client = {
    async request(method) {
      if (method === 'session/create') return { session: { sessionId: 's1' } };
      if (method === 'session/list') {
        if (fail) throw new Error('app-server query exploded');
        return [];
      }
      return {};
    },
    pendingForSession() { return 0; },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  await adapter.create({ teamId: 'alpha', memberName: 'a1', prompt: '' });
  await adapter.close({ sessionId: 's1' });
  fail = true;
  const proof = await adapter.verifySessionTermination({ sessionId: 's1' });
  assert.equal(proof.verified, false);
  assert.equal(proof.sideEffectsRevoked, false);
  assert.match(proof.warning, /query failed/);
});

test('protocol termination proof rejects an unrecognized session/list payload', async () => {
  const client = {
    async request(method) {
      if (method === 'session/create') return { session: { sessionId: 's1' } };
      if (method === 'session/list') return { unexpected: true };
      return {};
    },
    pendingForSession() { return 0; },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  await adapter.create({ teamId: 'alpha', memberName: 'a1', prompt: '' });
  await adapter.close({ sessionId: 's1' });
  const proof = await adapter.verifySessionTermination({ sessionId: 's1' });
  assert.equal(proof.verified, false);
  assert.match(proof.warning, /unrecognized payload/);
});

test('protocol termination proof refuses while a send is still in progress', async () => {
  let release;
  const sendGate = new Promise((resolve) => { release = resolve; });
  const client = {
    async request(method) {
      if (method === 'session/create') return { session: { sessionId: 's1' } };
      if (method === 'session/send') { await sendGate; return {}; }
      if (method === 'session/list') return { sessions: [] };
      return {};
    },
    pendingForSession() { return 0; },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  await adapter.create({ teamId: 'alpha', memberName: 'a1', prompt: '' });
  const sending = adapter.send({ sessionId: 's1', message: 'work' });
  await tick();
  await adapter.close({ sessionId: 's1' });
  const blocked = await adapter.verifySessionTermination({ sessionId: 's1' });
  assert.equal(blocked.verified, false);
  assert.equal(blocked.sideEffectsRevoked, false);
  assert.match(blocked.warning, /send is still in progress/);
  release();
  assert.equal((await sending).ok, true);
  const proof = await adapter.verifySessionTermination({ sessionId: 's1' });
  assert.equal(proof.verified, true);
});

test('protocol termination proof refuses while session requests are pending', async () => {
  let pending = 1;
  const client = {
    async request(method) {
      if (method === 'session/create') return { session: { sessionId: 's1' } };
      if (method === 'session/list') return [];
      return {};
    },
    pendingForSession() { return pending; },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  await adapter.create({ teamId: 'alpha', memberName: 'a1', prompt: '' });
  await adapter.close({ sessionId: 's1' });
  const blocked = await adapter.verifySessionTermination({ sessionId: 's1' });
  assert.equal(blocked.verified, false);
  assert.match(blocked.warning, /requests for this session are still in progress/);
  pending = 0;
  const proof = await adapter.verifySessionTermination({ sessionId: 's1' });
  assert.equal(proof.verified, true);
});
