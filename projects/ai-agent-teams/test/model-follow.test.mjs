import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync,
  truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import {
  HostModelReader, ModelWatcher, hostLogPaths, hostSessionPath, parseHostLogLine,
  readHostSessionFile, writeHostSessionFile,
} from '../src/host-model.mjs';
import { createApp } from '../src/http/server.mjs';
import { createMcpHandler } from '../src/mcp/handler.mjs';
import { listenForFetch } from './support/listen.mjs';

const SESSION = 'sess_host_test';
const NOW = new Date(2026, 9, 31, 12, 0, 0);
const HOOK_SCRIPT = fileURLToPath(new URL('../scripts/session-start.mjs', import.meta.url));

function makeLogHome() {
  const root = mkdtempSync(join(tmpdir(), 'host-model-'));
  const logDir = join(root, '.zcode', 'cli', 'log');
  mkdirSync(logDir, { recursive: true });
  return {
    root,
    logDir,
    today: join(logDir, 'zcode-2026-10-31.jsonl'),
    yesterday: join(logDir, 'zcode-2026-10-30.jsonl'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function modelLine(sessionId, model, previousModel) {
  return JSON.stringify({
    timestamp: '2026-10-31T04:00:00.000Z',
    level: 'info',
    event: 'session.model.updated',
    sessionId,
    context: { model, ...(previousModel ? { previousModel } : {}) },
  });
}

function reasoningLine(sessionId, thoughtLevel) {
  return JSON.stringify({
    timestamp: '2026-10-31T04:00:01.000Z',
    level: 'info',
    event: 'session.reasoning_effort.updated',
    sessionId,
    context: { thoughtLevel },
  });
}

function writeLines(path, lines) {
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function setupService({ hostModel, modelPolicy, defaultModel, defaultReasoning, adapter } = {}) {
  const { config } = loadConfig('config/example.two-teams.json');
  if (modelPolicy !== undefined) config.zcode.modelPolicy = modelPolicy;
  if (defaultModel !== undefined) config.zcode.defaultModel = defaultModel;
  if (defaultReasoning !== undefined) config.zcode.defaultReasoning = defaultReasoning;
  const store = new Store(':memory:');
  const sessionAdapter = adapter ?? new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter: sessionAdapter,
    config,
    cwd: process.cwd(),
    now: () => 1000,
    ...(hostModel ? { hostModel } : {}),
  });
  return { config, store, adapter: sessionAdapter, service };
}

function runningTeam(service) {
  service.createTeam({
    id: 'alpha',
    name: 'Alpha',
    phase: 'running',
    members: [{ name: 'a1' }, { name: 'a2' }],
  });
}

function runHook(input, env = {}) {
  return spawnSync(process.execPath, [HOOK_SCRIPT], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      ZCODE_SESSION_ID: '',
      AI_AGENT_TEAMS_WORKER: '',
      AI_AGENT_TEAMS_AUTO_PANEL: '',
      ...env,
    },
  });
}

class FailingSetModelAdapter extends FakeSessionAdapter {
  constructor(failing) {
    super();
    this.failing = new Set(failing);
  }

  async setModel(input) {
    this.calls.push({ kind: 'setModel', input });
    if (this.failing.has(input.sessionId)) throw new Error(`setModel failed for ${input.sessionId}`);
    return { ok: true };
  }
}

test('host log paths cover today and yesterday only when files exist', () => {
  const home = makeLogHome();
  try {
    assert.deepEqual(hostLogPaths({ homeDir: home.root, now: NOW }), []);
    writeLines(home.today, []);
    writeLines(home.yesterday, []);
    assert.deepEqual(hostLogPaths({ homeDir: home.root, now: NOW }), [home.today, home.yesterday]);
    assert.equal(hostLogPaths({ homeDir: join(home.root, 'missing'), now: NOW }).length, 0);
  } finally {
    home.cleanup();
  }
});

test('parseHostLogLine only accepts the target session and known events', () => {
  assert.deepEqual(parseHostLogLine(modelLine('other', 'p/other'), SESSION), null);
  assert.equal(parseHostLogLine(`not json ${SESSION}`, SESSION), null);
  assert.deepEqual(
    parseHostLogLine(modelLine(SESSION, 'p/m1'), SESSION),
    { field: 'model', value: 'p/m1', timestamp: '2026-10-31T04:00:00.000Z' },
  );
  assert.deepEqual(
    parseHostLogLine(reasoningLine(SESSION, 'max'), SESSION),
    { field: 'reasoning', value: 'max', timestamp: '2026-10-31T04:00:01.000Z' },
  );
  // Only session.model.updated is a supported model source; model.request.started
  // has no model/thoughtLevel context and must not be treated as one.
  const requestStarted = JSON.stringify({
    event: 'model.request.started', sessionId: SESSION, context: { iteration: 1 },
  });
  assert.equal(parseHostLogLine(requestStarted, SESSION), null);
});

test('HostModelReader returns the latest model and reasoning for the session', () => {
  const home = makeLogHome();
  try {
    writeLines(home.today, [
      modelLine(SESSION, 'p/model-a'),
      modelLine('sess_other', 'p/other-model'),
      reasoningLine(SESSION, 'low'),
      modelLine(SESSION, 'p/model-b'),
      reasoningLine(SESSION, 'max'),
    ]);
    const reader = new HostModelReader({ sessionId: SESSION, homeDir: home.root, now: () => NOW });
    const value = reader.read();
    assert.equal(value.model, 'p/model-b');
    assert.equal(value.reasoning, 'max');
    assert.equal(value.source, 'host');
    assert.equal(value.sessionId, SESSION);
    assert.equal(value.sessionSource, 'env');
  } finally {
    home.cleanup();
  }
});

test('HostModelReader merges a session that crosses midnight', () => {
  const home = makeLogHome();
  try {
    writeLines(home.yesterday, [
      modelLine(SESSION, 'p/yesterday-model'),
      reasoningLine(SESSION, 'high'),
    ]);
    writeLines(home.today, [reasoningLine(SESSION, 'max')]);
    const reader = new HostModelReader({ sessionId: SESSION, homeDir: home.root, now: () => NOW });
    const value = reader.read();
    assert.equal(value.model, 'p/yesterday-model');
    assert.equal(value.reasoning, 'max');
    assert.equal(value.source, 'host');
  } finally {
    home.cleanup();
  }
});

test('HostModelReader picks up appended updates without rescanning older lines', () => {
  const home = makeLogHome();
  try {
    writeLines(home.today, [modelLine(SESSION, 'p/model-a')]);
    const reader = new HostModelReader({ sessionId: SESSION, homeDir: home.root, now: () => NOW });
    assert.equal(reader.read().model, 'p/model-a');
    appendFileSync(home.today, `${modelLine(SESSION, 'p/model-b')}\n`, 'utf8');
    assert.equal(reader.read().model, 'p/model-b');
    assert.equal(reader.read().model, 'p/model-b');
  } finally {
    home.cleanup();
  }
});

test('HostModelReader falls back to defaultModel/defaultReasoning without a session', () => {
  const home = makeLogHome();
  try {
    const reader = new HostModelReader({
      sessionId: null,
      homeDir: home.root,
      now: () => NOW,
      defaultModel: 'p/default-model',
      defaultReasoning: 'medium',
    });
    const value = reader.read();
    assert.equal(value.model, 'p/default-model');
    assert.equal(value.reasoning, 'medium');
    assert.equal(value.source, 'default');
    assert.equal(value.sessionId, null);

    const missingLogs = new HostModelReader({
      sessionId: SESSION,
      homeDir: join(home.root, 'no-logs'),
      now: () => NOW,
      defaultModel: 'p/default-model',
      defaultReasoning: null,
    });
    assert.equal(missingLogs.read().model, 'p/default-model');
    assert.equal(missingLogs.read().reasoning, null);
  } finally {
    home.cleanup();
  }
});

test('HostModelReader tolerates chunk boundaries inside multi-byte lines', () => {
  const home = makeLogHome();
  try {
    const line = modelLine(SESSION, 'p/model-a').replace('"context"', '"note":"中文模型切换","context"');
    writeLines(home.today, [line]);
    const reader = new HostModelReader({
      sessionId: SESSION, homeDir: home.root, now: () => NOW, chunkSize: 7,
    });
    assert.equal(reader.read().model, 'p/model-a');
  } finally {
    home.cleanup();
  }
});

test('HostModelReader waits for a partially appended line to complete', () => {
  const home = makeLogHome();
  try {
    writeLines(home.today, [modelLine(SESSION, 'p/model-a')]);
    const reader = new HostModelReader({ sessionId: SESSION, homeDir: home.root, now: () => NOW });
    assert.equal(reader.read().model, 'p/model-a');
    const next = modelLine(SESSION, 'p/model-b');
    appendFileSync(home.today, next.slice(0, 20), 'utf8');
    assert.equal(reader.read().model, 'p/model-a');
    appendFileSync(home.today, `${next.slice(20)}\n`, 'utf8');
    assert.equal(reader.read().model, 'p/model-b');
  } finally {
    home.cleanup();
  }
});

test('a complete line plus a trailing half line in one append both land in order', () => {
  const home = makeLogHome();
  try {
    writeLines(home.today, [modelLine(SESSION, 'p/model-a')]);
    const reader = new HostModelReader({ sessionId: SESSION, homeDir: home.root, now: () => NOW });
    assert.equal(reader.read().model, 'p/model-a');
    const second = modelLine(SESSION, 'p/model-b');
    const third = modelLine(SESSION, 'p/model-c');
    // One append: the complete second line and only the first 20 bytes of the third.
    appendFileSync(home.today, `${second}\n${third.slice(0, 20)}`, 'utf8');
    assert.equal(reader.read().model, 'p/model-b');
    appendFileSync(home.today, `${third.slice(20)}\n`, 'utf8');
    assert.equal(reader.read().model, 'p/model-c');
  } finally {
    home.cleanup();
  }
});

test('a partially written first line stays unconsumed for the next read', () => {
  const home = makeLogHome();
  try {
    const complete = modelLine(SESSION, 'p/model-a');
    const partial = modelLine(SESSION, 'p/model-b');
    writeFileSync(home.today, `${complete}\n${partial.slice(0, 20)}`, 'utf8');
    const reader = new HostModelReader({ sessionId: SESSION, homeDir: home.root, now: () => NOW });
    assert.equal(reader.read().model, 'p/model-a');
    appendFileSync(home.today, `${partial.slice(20)}\n`, 'utf8');
    assert.equal(reader.read().model, 'p/model-b');
  } finally {
    home.cleanup();
  }
});

test('HostModelReader recovers after truncation and shorter rewrites', () => {
  const home = makeLogHome();
  try {
    writeLines(home.today, [modelLine(SESSION, 'p/model-a')]);
    const reader = new HostModelReader({ sessionId: SESSION, homeDir: home.root, now: () => NOW });
    assert.equal(reader.read().model, 'p/model-a');

    truncateSync(home.today, 0);
    appendFileSync(home.today, `${modelLine(SESSION, 'p/longer-model-name')}\n`, 'utf8');
    assert.equal(reader.read().model, 'p/longer-model-name');

    // A shorter replacement makes stat.size smaller than the stored offset.
    writeFileSync(home.today, `${modelLine(SESSION, 'p/z')}\n`, 'utf8');
    assert.equal(reader.read().model, 'p/z');
  } finally {
    home.cleanup();
  }
});

test('HostModelReader parses a large append in bounded chunks', () => {
  const home = makeLogHome();
  try {
    writeLines(home.today, [modelLine(SESSION, 'p/model-a')]);
    const reader = new HostModelReader({
      sessionId: SESSION, homeDir: home.root, now: () => NOW, chunkSize: 16,
    });
    assert.equal(reader.read().model, 'p/model-a');
    const filler = Array.from({ length: 40 }, (_, index) => JSON.stringify({
      event: 'tool.call', sessionId: SESSION, context: { index, note: '中文填充' },
    }));
    appendFileSync(home.today, `${filler.join('\n')}\n${modelLine(SESSION, 'p/model-z')}\n`, 'utf8');
    assert.equal(reader.read().model, 'p/model-z');
  } finally {
    home.cleanup();
  }
});

test('writeHostSessionFile is atomic 0600 state that the reader prefers over env', () => {
  const home = makeLogHome();
  const workspace = join(home.root, 'workspace');
  try {
    const written = writeHostSessionFile(workspace, 'sess_from_hook');
    assert.equal(written.sessionId, 'sess_from_hook');
    const statePath = hostSessionPath(workspace);
    assert.equal(written.path, statePath);
    assert.equal(existsSync(statePath), true);
    if (process.platform !== 'win32') {
      assert.equal(statSync(statePath).mode & 0o777, 0o600);
    }
    assert.deepEqual(readHostSessionFile(statePath), {
      sessionId: 'sess_from_hook',
      updatedAt: written.updatedAt,
      source: 'session-start-hook',
    });
    assert.equal(readHostSessionFile(join(workspace, 'missing.json')), null);

    writeLines(home.today, [modelLine('sess_from_hook', 'p/hook-model')]);
    const reader = new HostModelReader({
      sessionId: 'sess_env', workspace, homeDir: home.root, now: () => NOW,
    });
    const value = reader.read();
    assert.equal(value.sessionId, 'sess_from_hook');
    assert.equal(value.sessionSource, 'file');
    assert.equal(value.model, 'p/hook-model');
  } finally {
    home.cleanup();
  }
});

test('HostModelReader falls back to ZCODE_SESSION_ID without a state file', () => {
  const home = makeLogHome();
  const workspace = join(home.root, 'workspace');
  try {
    mkdirSync(workspace, { recursive: true });
    writeLines(home.today, [modelLine('sess_env', 'p/env-model')]);
    const reader = new HostModelReader({
      sessionId: 'sess_env', workspace, homeDir: home.root, now: () => NOW,
    });
    const value = reader.read();
    assert.equal(value.sessionId, 'sess_env');
    assert.equal(value.sessionSource, 'env');
    assert.equal(value.model, 'p/env-model');
  } finally {
    home.cleanup();
  }
});

test('HostModelReader discards cached values when the host session changes', () => {
  const home = makeLogHome();
  const workspace = join(home.root, 'workspace');
  try {
    writeHostSessionFile(workspace, 'sess_first');
    writeLines(home.today, [
      modelLine('sess_first', 'p/first-model'),
      reasoningLine('sess_first', 'high'),
    ]);
    const reader = new HostModelReader({ workspace, homeDir: home.root, now: () => NOW });
    assert.equal(reader.read().model, 'p/first-model');

    writeHostSessionFile(workspace, 'sess_second');
    appendFileSync(home.today, `${modelLine('sess_second', 'p/second-model')}\n`, 'utf8');
    const value = reader.read();
    assert.equal(value.sessionId, 'sess_second');
    assert.equal(value.model, 'p/second-model');
    assert.equal(value.reasoning, null);
  } finally {
    home.cleanup();
  }
});

test('SessionStart hook persists the host session id for the daemon', () => {
  const home = makeLogHome();
  const workspace = join(home.root, 'workspace');
  try {
    mkdirSync(join(workspace, '.ai-agent-teams'), { recursive: true });
    writeLines(home.today, [modelLine(SESSION, 'p/hook-followed')]);
    const hooked = runHook(JSON.stringify({ source: 'startup', cwd: workspace }), {
      ZCODE_SESSION_ID: SESSION,
    });
    assert.equal(hooked.status, 0, hooked.stderr);
    // Panel stays opt-in: persisting the id must not inject an instruction.
    assert.equal(hooked.stdout.trim(), '');
    const state = readHostSessionFile(hostSessionPath(workspace));
    assert.equal(state.sessionId, SESSION);

    const reader = new HostModelReader({ workspace, homeDir: home.root, now: () => NOW });
    const value = reader.read();
    assert.equal(value.sessionId, SESSION);
    assert.equal(value.sessionSource, 'file');
    assert.equal(value.model, 'p/hook-followed');
  } finally {
    home.cleanup();
  }
});

test('agent_teams_model status reports the session id written by the real hook', () => {
  const home = makeLogHome();
  const workspace = join(home.root, 'workspace');
  try {
    mkdirSync(join(workspace, '.ai-agent-teams'), { recursive: true });
    writeLines(home.today, [
      modelLine(SESSION, 'p/hook-model'),
      reasoningLine(SESSION, 'high'),
    ]);
    // Run the actual hook script, not a stub: this is the merge-gate path the
    // daemon follows in a desktop session.
    const hooked = runHook(JSON.stringify({ source: 'startup', cwd: workspace }), {
      ZCODE_SESSION_ID: SESSION,
    });
    assert.equal(hooked.status, 0, hooked.stderr);
    const reader = new HostModelReader({ workspace, homeDir: home.root, now: () => NOW });
    const { store, service } = setupService({ hostModel: () => reader.read() });
    runningTeam(service);
    const status = service.modelStatus();
    assert.equal(status.host.sessionId, SESSION);
    assert.equal(status.host.sessionSource, 'file');
    assert.equal(status.host.model, 'p/hook-model');
    assert.equal(status.host.reasoning, 'high');
    store.close();
  } finally {
    home.cleanup();
  }
});

test('SessionStart hook honors the payload session_id and skips worker sessions', () => {
  const home = makeLogHome();
  const workspace = join(home.root, 'workspace');
  try {
    mkdirSync(join(workspace, '.ai-agent-teams'), { recursive: true });
    const fromPayload = runHook(JSON.stringify({
      source: 'startup', cwd: workspace, session_id: 'sess_payload',
    }));
    assert.equal(fromPayload.status, 0, fromPayload.stderr);
    assert.equal(readHostSessionFile(hostSessionPath(workspace)).sessionId, 'sess_payload');

    // A workspace without team state must not gain an untracked
    // .ai-agent-teams/ directory just because a session started there.
    const unrelated = join(home.root, 'unrelated-workspace');
    mkdirSync(unrelated, { recursive: true });
    const skipped = runHook(JSON.stringify({ source: 'startup', cwd: unrelated }), {
      ZCODE_SESSION_ID: 'sess_unrelated',
    });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(existsSync(hostSessionPath(unrelated)), false);

    const other = join(home.root, 'worker-workspace');
    mkdirSync(join(other, '.ai-agent-teams'), { recursive: true });
    const worker = runHook(JSON.stringify({ source: 'startup', cwd: other }), {
      ZCODE_SESSION_ID: 'sess_worker',
      AI_AGENT_TEAMS_WORKER: '1',
    });
    assert.equal(worker.status, 0, worker.stderr);
    assert.equal(existsSync(hostSessionPath(other)), false);
  } finally {
    home.cleanup();
  }
});

test('follow-host spawns members with the host model and denies the model tool', async () => {
  const { store, adapter, service } = setupService({
    hostModel: () => ({
      model: 'p/host-model', reasoning: 'max', source: 'host', sessionId: SESSION, sessionSource: 'file',
    }),
  });
  runningTeam(service);
  service.addTask('alpha', { id: 't1', subject: 'work', assignee: 'a1', kind: 'work' });
  await service.tick('alpha');
  const created = adapter.calls.find((call) => call.kind === 'create' && call.input.memberName === 'a1');
  assert.equal(created.input.model, 'p/host-model');
  assert.equal(created.input.reasoning, 'max');
  for (const name of [
    'agent_teams_model',
    'mcp__agent-teams__agent_teams_model',
    'mcp__agent-teams-member__agent_teams_model',
    'mcp__plugin_ai-agent-teams_agent-teams__agent_teams_model',
  ]) {
    assert.ok(created.input.disallowedTools.includes(name), name);
  }
  // The shared captain-only list also covers workspace/route on the plugin
  // server, closing the denylist drift the review found.
  assert.ok(created.input.disallowedTools.includes('mcp__plugin_ai-agent-teams_agent-teams__agent_teams_workspace'));
  assert.ok(created.input.disallowedTools.includes('mcp__plugin_ai-agent-teams_agent-teams__agent_teams_route'));
  const member = store.findMember('alpha', 'a1');
  assert.equal(member.model, 'p/host-model');
  assert.equal(member.reasoning, 'max');
  store.close();
});

test('follow-host falls back to defaultModel when the host log has no model', async () => {
  const { store, adapter, service } = setupService({
    hostModel: () => ({ model: null, reasoning: null, source: 'none', sessionId: null }),
    defaultModel: 'p/default-model',
    defaultReasoning: 'medium',
  });
  runningTeam(service);
  service.addTask('alpha', { id: 't1', subject: 'work', assignee: 'a1', kind: 'work' });
  await service.tick('alpha');
  const created = adapter.calls.find((call) => call.kind === 'create' && call.input.memberName === 'a1');
  assert.equal(created.input.model, 'p/default-model');
  assert.equal(created.input.reasoning, 'medium');
  store.close();
});

test('config-level fixed policy pins spawns and the watcher skips', async () => {
  const { store, adapter, service } = setupService({
    modelPolicy: 'fixed',
    defaultModel: 'p/pinned',
    defaultReasoning: 'low',
    hostModel: () => ({ model: 'p/host-model', reasoning: 'max', source: 'host', sessionId: SESSION }),
  });
  assert.deepEqual(service.modelPolicy, { mode: 'fixed', model: 'p/pinned', reasoning: 'low' });
  runningTeam(service);
  service.addTask('alpha', { id: 't1', subject: 'work', assignee: 'a1', kind: 'work' });
  await service.tick('alpha');
  const created = adapter.calls.find((call) => call.kind === 'create' && call.input.memberName === 'a1');
  assert.equal(created.input.model, 'p/pinned');
  assert.equal(created.input.reasoning, 'low');

  const watcher = new ModelWatcher({ service, logger: { warn() {} } });
  assert.deepEqual(await watcher.tick(), { changed: false, applied: 0, skipped: 'fixed' });
  assert.equal(adapter.calls.filter((call) => call.kind === 'setModel').length, 0);
  store.close();
});

test('a member spawned after agent_teams_model set uses the pinned model', async () => {
  const { store, adapter, service } = setupService({
    hostModel: () => ({ model: 'p/host-model', reasoning: 'max', source: 'host', sessionId: SESSION }),
  });
  runningTeam(service);
  await service.setFixedModel({ model: 'p/pinned-later', reasoning: 'high' });
  service.addTask('alpha', { id: 't2', subject: 'work', assignee: 'a2', kind: 'work' });
  await service.tick('alpha');
  const created = adapter.calls.find((call) => call.kind === 'create' && call.input.memberName === 'a2');
  assert.equal(created.input.model, 'p/pinned-later');
  assert.equal(created.input.reasoning, 'high');
  store.close();
});

test('ModelWatcher hot-switches active sessions only when the host model changes', async () => {
  let host = { model: 'p/model-a', reasoning: 'high', source: 'host', sessionId: SESSION };
  const { store, adapter, service } = setupService({ hostModel: () => host });
  runningTeam(service);
  const member = store.findMember('alpha', 'a1');
  store.updateMember(member.id, { sessionId: 'sess_a1', status: 'working' });
  const watcher = new ModelWatcher({ service, logger: { warn() {} } });

  const first = await watcher.tick();
  assert.equal(first.changed, true);
  assert.equal(first.applied, 1);
  assert.equal(adapter.calls.filter((call) => call.kind === 'setModel').length, 1);
  assert.equal(store.getMember(member.id).model, 'p/model-a');
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'model.followed'));

  const second = await watcher.tick();
  assert.equal(second.changed, false);
  assert.equal(adapter.calls.filter((call) => call.kind === 'setModel').length, 1);

  host = { model: 'p/model-b', reasoning: 'max', source: 'host', sessionId: SESSION };
  const third = await watcher.tick();
  assert.equal(third.changed, true);
  assert.equal(third.applied, 1);
  const calls = adapter.calls.filter((call) => call.kind === 'setModel');
  assert.deepEqual(calls.at(-1).input, { sessionId: 'sess_a1', model: 'p/model-b', reasoning: 'max' });
  assert.equal(store.getMember(member.id).reasoning, 'max');
  store.close();
});

test('ModelWatcher re-follows after fixed/follow even when the host signature is unchanged', async () => {
  let host = { model: 'p/model-a', reasoning: 'high', source: 'host', sessionId: SESSION };
  const { store, service } = setupService({ hostModel: () => host });
  runningTeam(service);
  const member = store.findMember('alpha', 'a1');
  store.updateMember(member.id, { sessionId: 'sess_a1', status: 'working' });
  const watcher = new ModelWatcher({ service, logger: { warn() {} } });

  const first = await watcher.tick();
  assert.equal(first.changed, true);
  assert.equal(store.getMember(member.id).model, 'p/model-a');

  await service.setFixedModel({ model: 'p/pinned', reasoning: 'low' });
  assert.equal(store.getMember(member.id).model, 'p/pinned');

  // The host is unavailable at the moment follow is requested, so the watcher
  // applies the fallback and keeps the old host signature cached.
  host = null;
  await service.followHostModel();
  assert.notEqual(store.getMember(member.id).model, 'p/model-a');

  // The host comes back with exactly the old signature. The policy epoch changed,
  // so the watcher must re-apply instead of skipping as "unchanged".
  host = { model: 'p/model-a', reasoning: 'high', source: 'host', sessionId: SESSION };
  const after = await watcher.tick();
  assert.equal(after.changed, true);
  assert.equal(store.getMember(member.id).model, 'p/model-a');
  assert.equal(store.getMember(member.id).reasoning, 'high');
  store.close();
});

test('ModelWatcher reacts to a reasoning-only change', async () => {
  let host = { model: 'p/model-a', reasoning: 'high', source: 'host', sessionId: SESSION };
  const { store, adapter, service } = setupService({ hostModel: () => host });
  runningTeam(service);
  const member = store.findMember('alpha', 'a1');
  store.updateMember(member.id, { sessionId: 'sess_a1', status: 'working' });
  const watcher = new ModelWatcher({ service, logger: { warn() {} } });

  await watcher.tick();
  host = { model: 'p/model-a', reasoning: 'max', source: 'host', sessionId: SESSION };
  const changed = await watcher.tick();
  assert.equal(changed.changed, true);
  assert.equal(changed.applied, 1);
  const calls = adapter.calls.filter((call) => call.kind === 'setModel');
  assert.deepEqual(calls.at(-1).input, { sessionId: 'sess_a1', model: 'p/model-a', reasoning: 'max' });
  assert.equal(store.getMember(member.id).reasoning, 'max');
  store.close();
});

test('applyModelToActiveSessions isolates a failing member and the watcher never rejects', async () => {
  const adapter = new FailingSetModelAdapter(['sess_a1']);
  const { store, service } = setupService({
    adapter,
    hostModel: () => ({ model: 'p/host-model', reasoning: 'max', source: 'host', sessionId: SESSION }),
  });
  runningTeam(service);
  const a1 = store.findMember('alpha', 'a1');
  const a2 = store.findMember('alpha', 'a2');
  store.updateMember(a1.id, { sessionId: 'sess_a1', status: 'working' });
  store.updateMember(a2.id, { sessionId: 'sess_a2', status: 'working' });

  const watcher = new ModelWatcher({ service, logger: { warn() {} } });
  let result;
  await assert.doesNotReject(async () => { result = await watcher.tick(); });
  assert.equal(result.applied, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].memberId, a1.id);
  const events = store.listEvents('alpha');
  assert.ok(events.some((event) => event.type === 'model.followed'));
  assert.ok(events.some((event) => event.type === 'model.follow_failed' && event.memberId === a1.id));
  assert.equal(store.getMember(a1.id).model ?? null, null);
  assert.equal(store.getMember(a2.id).model, 'p/host-model');
  store.close();
});

test('an all-failed tick does not commit the signature and retries next tick', async () => {
  const adapter = new FailingSetModelAdapter(['sess_a1', 'sess_a2']);
  let host = { model: 'p/model-a', reasoning: 'high', source: 'host', sessionId: SESSION };
  const { store, service } = setupService({ adapter, hostModel: () => host });
  runningTeam(service);
  const a1 = store.findMember('alpha', 'a1');
  const a2 = store.findMember('alpha', 'a2');
  store.updateMember(a1.id, { sessionId: 'sess_a1', status: 'working' });
  store.updateMember(a2.id, { sessionId: 'sess_a2', status: 'working' });
  let clock = 1_000_000;
  const watcher = new ModelWatcher({ service, logger: { warn() {} }, now: () => clock });

  const failed = await watcher.tick();
  assert.equal(failed.applied, 0);
  assert.equal(failed.failed.length, 2);
  assert.equal(failed.retry, true);
  assert.equal(adapter.calls.filter((call) => call.kind === 'setModel').length, 2);

  const retried = await watcher.tick();
  assert.equal(retried.applied, 0);
  assert.equal(adapter.calls.filter((call) => call.kind === 'setModel').length, 4);

  adapter.failing.clear();
  host = { model: 'p/model-a', reasoning: 'high', source: 'host', sessionId: SESSION };
  // The second failure schedules a backoff; advancing past it retries.
  const backedOff = await watcher.tick();
  assert.equal(backedOff.skipped, 'backoff');
  assert.equal(adapter.calls.filter((call) => call.kind === 'setModel').length, 4);
  clock += 3000;
  const recovered = await watcher.tick();
  assert.equal(recovered.applied, 2);
  const committed = await watcher.tick();
  assert.equal(committed.changed, false);
  assert.equal(adapter.calls.filter((call) => call.kind === 'setModel').length, 6);
  store.close();
});

test('set pins a model and follow resumes the host policy', async () => {
  const { store, adapter, service } = setupService({
    hostModel: () => ({ model: 'p/host-model', reasoning: 'max', source: 'host', sessionId: SESSION }),
  });
  runningTeam(service);
  const member = store.findMember('alpha', 'a1');
  store.updateMember(member.id, { sessionId: 'sess_a1', status: 'working' });

  const fixed = await service.setFixedModel({ model: 'p/pinned', reasoning: 'low' });
  assert.equal(service.modelPolicy.mode, 'fixed');
  assert.equal(fixed.policy.model, 'p/pinned');
  assert.equal(fixed.applied.applied, 1);
  assert.equal(store.getMember(member.id).model, 'p/pinned');
  assert.equal(adapter.calls.filter((call) => call.kind === 'setModel').length, 1);

  const watcher = new ModelWatcher({ service, logger: { warn() {} } });
  assert.equal((await watcher.tick()).skipped, 'fixed');

  const follow = await service.followHostModel();
  assert.equal(service.modelPolicy.mode, 'follow-host');
  assert.equal(follow.host.model, 'p/host-model');
  assert.equal(follow.applied.applied, 1);
  assert.equal(store.getMember(member.id).model, 'p/host-model');
  await assert.rejects(() => service.setFixedModel({ model: '' }), /model is required/);
  store.close();
});

test('model status reports policy, host session and member models', () => {
  const { store, service } = setupService({
    hostModel: () => ({
      model: 'p/host-model', reasoning: 'max', source: 'host', sessionId: SESSION, sessionSource: 'file',
    }),
  });
  runningTeam(service);
  const status = service.modelStatus();
  assert.equal(status.policy.mode, 'follow-host');
  assert.equal(status.host.model, 'p/host-model');
  assert.equal(status.host.sessionId, SESSION);
  assert.equal(status.host.sessionSource, 'file');
  assert.equal(status.members.length, 2);
  assert.equal(status.members[0].teamId, 'alpha');
  store.close();
});

test('contractor spawn denies every agent_teams_model name shape', async () => {
  const { config, store, adapter, service } = setupService();
  config.features.contractors = true;
  config.contractors.enabled = true;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  await service.spawnContractor({
    teamId: 'alpha', purpose: 'audit', prompt: 'read only audit', mode: 'read-only',
  });
  const created = adapter.calls.find((call) => call.kind === 'create' && call.input.ephemeral === true);
  for (const name of [
    'agent_teams_model',
    'mcp__agent-teams__agent_teams_model',
    'mcp__agent-teams-member__agent_teams_model',
    'mcp__plugin_ai-agent-teams_agent-teams__agent_teams_model',
  ]) {
    assert.ok(created.input.disallowedTools.includes(name), name);
  }
  store.close();
});

test('HTTP model route exposes status/set/follow to the captain only', async () => {
  const { store, service } = setupService({
    hostModel: () => ({ model: 'p/host-model', reasoning: 'max', source: 'host', sessionId: SESSION }),
  });
  runningTeam(service);
  const memberToken = store.getMemberToken(store.findMember('alpha', 'a1').id);
  const app = createApp({
    store, service, token: 'secret', uiToken: 'view', uiAccessKey: '',
  });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const admin = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  try {
    const status = await fetch(`${base}/model`, { headers: admin });
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.data.policy.mode, 'follow-host');

    const set = await fetch(`${base}/model`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ action: 'set', model: 'p/pinned', reasoning: 'low' }),
    });
    assert.equal(set.status, 200);
    assert.equal((await set.json()).data.policy.model, 'p/pinned');

    const follow = await fetch(`${base}/model`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ action: 'follow' }),
    });
    assert.equal(follow.status, 200);
    assert.equal((await follow.json()).data.policy.mode, 'follow-host');

    const invalid = await fetch(`${base}/model`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ action: 'nope' }),
    });
    assert.equal(invalid.status, 400);

    const denied = await fetch(`${base}/model`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert.equal(denied.status, 403);
  } finally {
    await app.close();
    store.close();
  }
});

test('agent_teams_model routes status/set/follow through the daemon API', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { policy: { mode: 'follow-host' } }, error: null }),
    };
  };
  const handle = createMcpHandler({ fetchImpl: fakeFetch, baseUrl: 'http://daemon', token: 't' });
  const call = (args) => handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'agent_teams_model', arguments: args },
  });

  assert.equal((await call({})).result.isError, false);
  assert.equal(calls[0].url, 'http://daemon/api/v1/model');
  assert.equal(calls[0].method, 'GET');

  await call({ action: 'set', model: 'p/pinned', reasoning: 'low' });
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].body), { action: 'set', model: 'p/pinned', reasoning: 'low' });

  await call({ action: 'follow' });
  assert.deepEqual(JSON.parse(calls[2].body), { action: 'follow' });

  const bad = await call({ action: 'nope' });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /unknown model action/);
});

test('member sessions cannot see or call the model policy tool', async () => {
  const handle = createMcpHandler({
    fetchImpl: async () => ({
      ok: true, status: 200, json: async () => ({ ok: true, data: {}, error: null }),
    }),
    baseUrl: 'http://daemon',
    token: 'member-token',
    defaultTeam: 'alpha',
    defaultMember: 'a1',
  });
  const list = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(list.result.tools.some((tool) => tool.name === 'agent_teams_model'), false);
  const response = await handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'agent_teams_model', arguments: { action: 'follow' } },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /model policy/);
});

test('config defaults modelPolicy to follow-host and rejects unknown values', () => {
  const { config, store } = setupService();
  assert.equal(config.zcode.modelPolicy, 'follow-host');
  const invalid = structuredClone(config);
  invalid.zcode.modelPolicy = 'sometimes';
  assert.match(validateConfig(invalid).errors.join('\n'), /modelPolicy must be follow-host\|fixed/);
  store.close();
});

test('fixed without defaultModel warns that the pin is not yet effective', () => {
  const { config, store } = setupService();
  const fixed = structuredClone(config);
  fixed.zcode.modelPolicy = 'fixed';
  fixed.zcode.defaultModel = null;
  assert.match(
    validateConfig(fixed).warnings.join('\n'),
    /modelPolicy=fixed has no defaultModel/,
  );
  store.close();
});

test('host status keeps the resolved session id when the log has no model event', () => {
  const home = makeLogHome();
  const workspace = join(home.root, 'workspace');
  try {
    mkdirSync(join(workspace, '.ai-agent-teams'), { recursive: true });
    writeHostSessionFile(workspace, 'sess_new');
    writeLines(home.today, [JSON.stringify({ event: 'tool.call', sessionId: 'sess_new' })]);
    const reader = new HostModelReader({
      workspace,
      homeDir: home.root,
      now: () => NOW,
      defaultModel: 'p/default-model',
      defaultReasoning: 'medium',
    });
    const { store, service } = setupService({ hostModel: () => reader.read() });
    runningTeam(service);
    const status = service.modelStatus();
    // The model is the configured fallback, but the session id proves the hook
    // ran; dropping it would make the merge-gate diagnostic useless.
    assert.equal(status.host.model, 'p/default-model');
    assert.equal(status.host.source, 'default');
    assert.equal(status.host.sessionId, 'sess_new');
    assert.equal(status.host.sessionSource, 'file');
    store.close();
  } finally {
    home.cleanup();
  }
});

test('follow-host prefers a member override over a default-only host value', async () => {
  let host = {
    model: 'p/config-default', reasoning: 'medium', source: 'default', sessionId: SESSION,
  };
  const { store, adapter, service } = setupService({
    hostModel: () => host,
    defaultModel: 'p/config-default',
    defaultReasoning: 'medium',
  });
  service.createTeam({
    id: 'alpha',
    name: 'Alpha',
    phase: 'running',
    members: [
      { name: 'a1', model: 'p/member-model', reasoning: 'low' },
      { name: 'a2' },
    ],
  });
  service.addTask('alpha', { id: 't1', subject: 'work', assignee: 'a1', kind: 'work' });
  await service.tick('alpha');
  const first = adapter.calls.find((call) => call.kind === 'create' && call.input.memberName === 'a1');
  assert.equal(first.input.model, 'p/member-model');
  assert.equal(first.input.reasoning, 'low');
  assert.equal(store.findMember('alpha', 'a1').modelOverride, 'p/member-model');

  // A real host value always wins over the member preference.
  host = { model: 'p/host-real', reasoning: 'max', source: 'host', sessionId: SESSION };
  service.addTask('alpha', { id: 't2', subject: 'work', assignee: 'a2', kind: 'work' });
  await service.tick('alpha');
  const second = adapter.calls.find((call) => call.kind === 'create' && call.input.memberName === 'a2');
  assert.equal(second.input.model, 'p/host-real');
  assert.equal(second.input.reasoning, 'max');
  store.close();
});

test('a permanently failing hot switch gives up, emits one abandon event and stops', async () => {
  const adapter = new FailingSetModelAdapter(['sess_a1']);
  const { store, service } = setupService({
    adapter,
    hostModel: () => ({ model: 'p/model-a', reasoning: 'high', source: 'host', sessionId: SESSION }),
  });
  runningTeam(service);
  const member = store.findMember('alpha', 'a1');
  store.updateMember(member.id, { sessionId: 'sess_a1', status: 'working' });
  let clock = 1000;
  const watcher = new ModelWatcher({
    service, logger: { warn() {} }, now: () => clock, maxFailedTicks: 3,
  });

  assert.equal((await watcher.tick()).attempts, 1);
  assert.equal((await watcher.tick()).attempts, 2);
  clock += 3000; // the second failure scheduled a 3s backoff
  const abandoned = await watcher.tick();
  assert.equal(abandoned.abandoned, true);
  assert.equal(abandoned.attempts, 3);
  const calls = adapter.calls.filter((call) => call.kind === 'setModel').length;
  assert.equal(calls, 3);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'model.follow_abandoned'));

  // Sealed: no further attempts or events for the same host signature.
  clock += 600000;
  const after = await watcher.tick();
  assert.equal(after.changed, false);
  assert.equal(adapter.calls.filter((call) => call.kind === 'setModel').length, calls);
  assert.equal(
    store.listEvents('alpha').filter((event) => event.type === 'model.follow_abandoned').length,
    1,
  );
  store.close();
});

test('an adapter without model switching is skipped instead of retried', async () => {
  const adapter = new FakeSessionAdapter();
  adapter.supportsModelSwitch = false;
  const { store, service } = setupService({
    adapter,
    hostModel: () => ({ model: 'p/host-model', reasoning: 'max', source: 'host', sessionId: SESSION }),
  });
  runningTeam(service);
  const member = store.findMember('alpha', 'a1');
  store.updateMember(member.id, { sessionId: 'sess_a1', status: 'working' });
  const watcher = new ModelWatcher({ service, logger: { warn() {} } });

  const first = await watcher.tick();
  assert.equal(first.skipped, 'unsupported');
  assert.equal(first.applied, 0);
  assert.equal(adapter.calls.filter((call) => call.kind === 'setModel').length, 0);
  assert.equal((await watcher.tick()).changed, false);
  assert.equal(store.listEvents('alpha').some((event) => event.type === 'model.follow_failed'), false);
  store.close();
});

test('the watcher isolates a broken host reader and never rejects', async () => {
  const service = {
    modelPolicy: { mode: 'follow-host', model: null, reasoning: null },
    currentHostModel() { throw new Error('host log exploded'); },
    applyModelToActiveSessions() { throw new Error('must not be called'); },
  };
  const watcher = new ModelWatcher({ service, logger: { warn() {} } });
  let result;
  await assert.doesNotReject(async () => { result = await watcher.tick(); });
  assert.equal(result.error, 'host log exploded');
  assert.equal(result.changed, false);
});

test('policy changes emit model.policy_changed (INV-043)', async () => {
  const { store, service } = setupService({
    hostModel: () => ({ model: 'p/host-model', reasoning: 'max', source: 'host', sessionId: SESSION }),
  });
  runningTeam(service);
  await service.setFixedModel({ model: 'p/pinned', reasoning: 'low' });
  const setEvents = store.listEvents('alpha').filter((event) => event.type === 'model.policy_changed');
  assert.equal(setEvents.length, 1);
  assert.equal(setEvents[0].from.mode, 'follow-host');
  assert.equal(setEvents[0].to.mode, 'fixed');
  assert.equal(setEvents[0].to.model, 'p/pinned');

  await service.followHostModel({ actor: 'ui' });
  const events = store.listEvents('alpha').filter((event) => event.type === 'model.policy_changed');
  assert.equal(events.length, 2);
  assert.equal(events[1].from.mode, 'fixed');
  assert.equal(events[1].to.mode, 'follow-host');
  assert.equal(events[1].actor, 'ui');
  store.close();
});

test('set during an in-flight follow tick wins the final member model', async () => {
  class GatedSetModelAdapter extends FakeSessionAdapter {
    constructor() {
      super();
      this.gate = null;
    }

    async setModel(input) {
      this.calls.push({ kind: 'setModel', input });
      if (this.gate) await this.gate;
      return { ok: true };
    }
  }
  const adapter = new GatedSetModelAdapter();
  let release;
  adapter.gate = new Promise((resolve) => { release = resolve; });
  const { store, service } = setupService({
    adapter,
    hostModel: () => ({ model: 'p/host-model', reasoning: 'max', source: 'host', sessionId: SESSION }),
  });
  runningTeam(service);
  const member = store.findMember('alpha', 'a1');
  store.updateMember(member.id, { sessionId: 'sess_a1', status: 'working' });
  const watcher = new ModelWatcher({ service, logger: { warn() {} } });

  const tickPromise = watcher.tick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const setPromise = service.setFixedModel({ model: 'p/pinned', reasoning: 'low' });
  release();
  const tickResult = await tickPromise;
  const setResult = await setPromise;
  assert.equal(tickResult.applied, 1);
  assert.equal(setResult.applied.applied, 1);
  assert.equal(service.modelPolicy.mode, 'fixed');
  // Serialized applies: the pin is the last write, not the queued host value.
  assert.equal(store.getMember(member.id).model, 'p/pinned');
  assert.equal((await watcher.tick()).skipped, 'fixed');
  store.close();
});

test('a stale-epoch follow application is superseded instead of overwriting a pin', async () => {
  // The watcher reads the epoch and queues its application in the same turn, so
  // this guard is a contract for any caller that captured an older epoch (for
  // example a retried or re-queued follow). Without it the host value would land
  // after `set` and silently unpin the operator's model.
  const { store, service } = setupService({ defaultModel: null, defaultReasoning: null });
  runningTeam(service);
  const member = store.findMember('alpha', 'a1');
  store.updateMember(member.id, { sessionId: 'sess_a1', status: 'working' });
  const staleEpoch = service.modelPolicyEpoch;
  await service.setFixedModel({ model: 'p/pinned', reasoning: 'low' });
  assert.equal(store.getMember(member.id).model, 'p/pinned');
  // Back to following, but the host/default resolves to nothing, so the pin stays.
  await service.followHostModel();
  assert.equal(service.modelPolicy.mode, 'follow-host');
  assert.equal(store.getMember(member.id).model, 'p/pinned');
  const stale = await service.applyModelToActiveSessions({
    model: 'p/host-model',
    reasoning: 'max',
    reason: 'follow-host',
    expectedEpoch: staleEpoch,
  });
  assert.equal(stale.skipped, 'superseded');
  assert.equal(stale.applied, 0);
  assert.equal(store.getMember(member.id).model, 'p/pinned');
  store.close();
});

test('a new day log file is picked up after the first read', () => {
  const home = makeLogHome();
  try {
    writeLines(home.yesterday, [modelLine(SESSION, 'p/model-yesterday')]);
    const reader = new HostModelReader({ sessionId: SESSION, homeDir: home.root, now: () => NOW });
    assert.equal(reader.read().model, 'p/model-yesterday');
    writeLines(home.today, [modelLine(SESSION, 'p/model-today')]);
    assert.equal(reader.read().model, 'p/model-today');
    // A removed file drops its offset without losing the cached value.
    rmSync(home.yesterday);
    assert.equal(reader.read().model, 'p/model-today');
  } finally {
    home.cleanup();
  }
});

test('container and cli follow-host warnings match what can actually hot-switch', () => {
  const { config, store } = setupService();
  const container = structuredClone(config);
  container.isolation.mode = 'container';
  container.zcode.modelPolicy = 'follow-host';
  assert.match(validateConfig(container).warnings.join('\n'), /container cannot hot-switch/);

  const cli = structuredClone(config);
  cli.zcode.protocol = 'cli';
  cli.zcode.defaultModel = null;
  cli.zcode.defaultReasoning = 'max'; // the daemon auto-selects app-server here
  assert.doesNotMatch(validateConfig(cli).warnings.join('\n'), /protocol=cli cannot hot-switch/);
  const bareCli = structuredClone(cli);
  bareCli.zcode.defaultReasoning = null;
  assert.match(validateConfig(bareCli).warnings.join('\n'), /protocol=cli cannot hot-switch/);
  store.close();
});
