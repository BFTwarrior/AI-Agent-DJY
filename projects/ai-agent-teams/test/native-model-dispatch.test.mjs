import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { dispatchPlannedTasks } from '../src/service/task-dispatch.mjs';
import { removeTreeWithRetry } from './support/cleanup.mjs';

const ACTIVE = new Set(['claimed', 'in_progress']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const HOST = { model: 'host/gpt', reasoning: 'high', source: 'host' };
const INHERIT = { source: 'inherit' };
const pin = (modelId = 'deepseek-chat', reasoning) => ({
  source: 'native-agent', agentId: 'plugin:ai-agent-teams@test-market:team-worker',
  model: `custom/${modelId}`, reasoning: reasoning ?? null,
  modelSelection: { providerId: 'custom', modelId, ...(reasoning ? { options: { reasoningLevel: reasoning } } : {}) },
  signature: JSON.stringify([modelId, reasoning ?? null]),
});

function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, { native = pin(), inject = true, host = HOST } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'native-model-dispatch-'));
  const { config } = loadConfig(fileURLToPath(new URL('../config/example.v06.json', import.meta.url)));
  config.features.lazyMembers = false;
  config.zcode.modelPolicy = 'follow-host';
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  let selection = native;
  const service = new TeamService({ store, adapter, config, cwd, homeRoot: join(cwd, 'homes'),
    now: () => 1000, hostModel: () => host,
    ...(inject ? { nativeAgentModel: () => {
      if (selection instanceof Error) throw selection;
      return selection;
    } } : {}),
  });
  t.after(() => { service.close(); store.close(); removeTreeWithRetry(cwd); });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const member = service.addMember('alpha', { name: 'worker', role: 'engineer' });
  store.updateMember(member.id, { model: 'preferred/old', reasoning: 'low' });
  const add = (id) => store.addTask({ id, teamId: 'alpha', subject: id, kind: 'work', status: 'pending',
    assignee: member.name, assigneeId: member.id, licenseId: member.licenseId,
    attempt: 0, turnFailureCount: 2, dependencies: [],
  });
  const dispatch = (id) => dispatchPlannedTasks(service, { teamId: 'alpha', team: store.getTeam('alpha'),
    tasks: store.listTasks('alpha'), plan: { dispatch: [{ taskId: id, member: member.name }] },
    worktreeBase: { ready: true }, activeStatuses: ACTIVE, terminalStatuses: TERMINAL,
  });
  const warm = async () => {
    const { sessionId } = await adapter.create({ model: HOST.model });
    store.updateMember(member.id, { sessionId, workdir: cwd });
    adapter.calls.length = 0;
    return sessionId;
  };
  return { cwd, config, store, adapter, service, member, add, dispatch, warm,
    select: (value) => { selection = value; },
  };
}

function assertHeld(f, id) {
  const task = f.store.getTask(id);
  assert.equal(task.status, 'pending');
  assert.equal(task.attemptId, undefined);
  assert.equal(task.reassigning, false);
  assert.deepEqual(task.hold, { class: 'native_model_selection', reason: 'native_model_selection' });
  assert.equal(task.needsCaptain, true);
  assert.equal(task.turnFailureCount, 2);
  assert.equal(f.store.getTeam('alpha').needsCaptain, true);
  assert.equal(f.store.listAttempts('alpha').filter((a) => a.taskId === id).at(-1).status, 'failed');
  assert.equal(f.adapter.calls.filter((call) => call.kind === 'send').length, 0);
  assert.equal(f.store.listEvents('alpha').filter((e) => ['task.turn_failed', 'task.retry_scheduled'].includes(e.type)).length, 0);
}

test('native dispatch creates a DeepSeek worker under a GPT host without borrowing host reasoning', async (t) => {
  const f = fixture(t);
  f.store.updateTeam('alpha', { captainSessionId: 'main-gpt-session' });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 1);
  const create = f.adapter.calls.find((call) => call.kind === 'create').input;
  assert.equal(create.model, 'custom/deepseek-chat');
  assert.deepEqual(create.modelSelection, pin().modelSelection);
  assert.equal(create.reasoning, null);
  assert.equal(f.adapter.calls.filter((call) => call.kind === 'setModel').length, 0);
  const member = f.store.getMember(f.member.id);
  assert.equal(member.nativeModelSignature, pin().signature);
  assert.deepEqual(member.nativeModelPrevious, { model: 'preferred/old', reasoning: 'low' });
  assert.equal(f.adapter.calls.some((call) => call.input?.sessionId === 'main-gpt-session'), false);
});

test('warm native dispatch applies structured slash-containing identities after the cursor and before send', async (t) => {
  const f = fixture(t, { native: pin('vendor/model$literal') });
  const sessionId = await f.warm();
  const order = [];
  f.adapter.turnCursor = async () => { order.push('cursor'); return 0; };
  const set = f.adapter.setModel.bind(f.adapter);
  t.mock.method(f.adapter, 'setModel', async (input) => { order.push('setModel'); return set(input); });
  f.adapter.handler = async () => { order.push('send'); return {}; };
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 1);
  assert.deepEqual(order, ['cursor', 'setModel', 'send']);
  const applied = f.adapter.calls.find((call) => call.kind === 'setModel').input;
  assert.equal(applied.sessionId, sessionId);
  assert.deepEqual(applied.modelSelection, { providerId: 'custom', modelId: 'vendor/model$literal' });
  assert.equal(applied.reasoning, null);
});

test('unchanged native signature avoids redundant setModel on a warm worker', async (t) => {
  const f = fixture(t);
  await f.warm();
  f.store.updateMember(f.member.id, { nativeModelSignature: pin().signature, nativeModelPrevious: { model: HOST.model, reasoning: HOST.reasoning } });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 1);
  assert.equal(f.adapter.calls.filter((call) => call.kind === 'setModel').length, 0);
});

test('settings changed during the cursor use the latest pin and preserve the original preference', async (t) => {
  const f = fixture(t);
  await f.warm();
  f.adapter.turnCursor = async () => { f.select(pin('deepseek-reasoner', 'medium')); return 1; };
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 1);
  const applied = f.adapter.calls.find((call) => call.kind === 'setModel').input;
  assert.deepEqual(applied.modelSelection, pin('deepseek-reasoner', 'medium').modelSelection);
  assert.equal(applied.reasoning, 'medium');
  assert.deepEqual(f.store.getMember(f.member.id).nativeModelPrevious, { model: 'preferred/old', reasoning: 'low' });
});

test('pin removal restores the existing host policy and clears native bookkeeping', async (t) => {
  const f = fixture(t, { native: INHERIT });
  const sessionId = await f.warm();
  f.store.updateMember(f.member.id, { model: 'custom/deepseek-chat', reasoning: null,
    nativeModelSignature: pin().signature, nativeModelPrevious: { model: 'preferred/old', reasoning: 'low' } });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 1);
  const applied = f.adapter.calls.find((call) => call.kind === 'setModel').input;
  assert.deepEqual(applied, { sessionId, model: HOST.model, reasoning: HOST.reasoning });
  const member = f.store.getMember(f.member.id);
  assert.equal(member.nativeModelSignature, undefined);
  assert.equal(member.nativeModelPrevious, undefined);
  assert.equal(member.model, HOST.model);
});

test('inherit spawn clears previous native state and does not resurrect the effective native model', async (t) => {
  const f = fixture(t, { native: INHERIT, host: { source: 'none', model: null, reasoning: null } });
  f.store.updateMember(f.member.id, { model: 'custom/deepseek-chat', reasoning: null,
    nativeModelSignature: pin().signature, nativeModelPrevious: { model: 'preferred/old', reasoning: 'low' } });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 1);
  assert.equal(f.adapter.calls.find((call) => call.kind === 'create').input.model, 'preferred/old');
  assert.equal(f.store.getMember(f.member.id).nativeModelSignature, undefined);
  assert.equal(f.store.getMember(f.member.id).nativeModelPrevious, undefined);
});

for (const code of ['NATIVE_AGENT_SELECTION_INVALID', 'NATIVE_AGENT_IDENTITY_AMBIGUOUS', 'E_NATIVE_MODEL_READ']) {
  test(`native preflight ${code} creates a releasable hold before external session creation`, async (t) => {
    const f = fixture(t, { native: Object.assign(new Error('private diagnostic must not leak'), { code }) });
    f.add('task');
    assert.equal((await f.dispatch('task')).dispatched, 0);
    assertHeld(f, 'task');
    assert.equal(f.adapter.calls.length, 0);
    assert.equal(f.store.getMember(f.member.id).workerSessionStart, undefined);
    assert.equal(JSON.stringify(f.store.listEvents('alpha')).includes('private diagnostic'), false);
    assert.equal(JSON.stringify(f.store.listAttempts('alpha')).includes('private diagnostic'), false);
    f.select(pin());
    assert.equal(f.service.releaseTaskHold('alpha', 'task', {
      reason: 'selection corrected', expectedReason: 'native_model_selection', actor: { role: 'admin' },
    }).ok, true);
    assert.equal((await f.dispatch('task')).dispatched, 1);
    assert.equal(f.store.getTask('task').turnFailureCount, 2);
  });
}

for (const kind of ['cli', 'container']) {
  test(`native ${kind} preflight refuses unsupported selection before creation`, async (t) => {
    const f = fixture(t);
    f.adapter.kind = kind;
    f.adapter.supportsModelSwitch = false;
    f.add('task');
    assert.equal((await f.dispatch('task')).dispatched, 0);
    assertHeld(f, 'task');
    assert.equal(f.adapter.calls.length, 0);
  });
}

for (const failure of ['throw', 'false', 'not-ok', 'missing']) {
  test(`warm native setModel ${failure} prevents send and preserves the old session and failure budget`, async (t) => {
    const f = fixture(t);
    const sessionId = await f.warm();
    if (failure === 'missing') f.adapter.setModel = undefined;
    else t.mock.method(f.adapter, 'setModel', async () => {
      if (failure === 'throw') throw new Error('private provider diagnostic');
      return failure === 'false' ? false : { ok: false, warning: 'private provider diagnostic' };
    });
    f.add('task');
    assert.equal((await f.dispatch('task')).dispatched, 0);
    assertHeld(f, 'task');
    assert.equal(f.store.getMember(f.member.id).sessionId, sessionId);
    assert.equal(f.store.getMember(f.member.id).sessionRecoveryState, undefined);
    assert.equal(f.adapter.calls.some((call) => call.kind === 'stop'), false);
    assert.equal(JSON.stringify(f.store.listEvents('alpha')).includes('private provider'), false);
  });
}

test('new spawn rechecks settings changed during create before sending its task', async (t) => {
  const f = fixture(t);
  const create = f.adapter.create.bind(f.adapter);
  t.mock.method(f.adapter, 'create', async (input) => { const result = await create(input); f.select(pin('second-model')); return result; });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 1);
  assert.equal(f.adapter.calls.find((call) => call.kind === 'setModel').input.model, 'custom/second-model');
  assert.deepEqual(f.store.getMember(f.member.id).nativeModelPrevious, { model: 'preferred/old', reasoning: 'low' });
});

test('unknown native create outcome retains the existing unknown-session hold and occupied slot', async (t) => {
  const f = fixture(t);
  t.mock.method(f.adapter, 'create', async () => { throw new Error('remote create result unavailable'); });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 0);
  assert.equal(f.store.getTask('task').hold.reason, 'session_creation_unknown');
  assert.equal(f.store.getMember(f.member.id).workerSessionStart.state, 'unknown');
  assert.equal(f.service.workspaceSessionCount(), 1);
  assert.equal(f.store.getMemberToken(f.member.id), undefined);
  assert.equal(f.store.listAttempts('alpha')[0].status, 'orphaned');
});

test('settings changed during setModel converge before send without mixing reasoning', async (t) => {
  const f = fixture(t);
  await f.warm();
  const set = f.adapter.setModel.bind(f.adapter);
  let changed = false;
  t.mock.method(f.adapter, 'setModel', async (input) => {
    const result = await set(input);
    if (!changed) { changed = true; f.select(pin('second-model')); }
    return result;
  });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 1);
  assert.deepEqual(f.adapter.calls.filter((call) => call.kind === 'setModel').map((call) => call.input.model),
    ['custom/deepseek-chat', 'custom/second-model']);
  assert.equal(f.store.getMember(f.member.id).reasoning, null);
});

test('continuously changing settings stop after bounded attempts and do not send', async (t) => {
  const f = fixture(t);
  await f.warm();
  const set = f.adapter.setModel.bind(f.adapter);
  let changes = 0;
  t.mock.method(f.adapter, 'setModel', async (input) => { const result = await set(input); f.select(pin(`changed-${++changes}`)); return result; });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 0);
  assertHeld(f, 'task');
  assert.equal(changes, 3);
});

test('halt while native setModel awaits prevents send and preserves halt-owned state', async (t) => {
  const f = fixture(t);
  await f.warm();
  const entered = gate();
  const finish = gate();
  t.mock.method(f.adapter, 'setModel', async () => { entered.resolve(); await finish.promise; return { ok: true }; });
  f.add('task');
  const pending = f.dispatch('task');
  await entered.promise;
  await f.service.halt('alpha', 'test halt');
  finish.resolve();
  assert.equal((await pending).dispatched, 0);
  assert.equal(f.adapter.calls.some((call) => call.kind === 'send'), false);
  assert.equal(f.store.listAttempts('alpha')[0].status, 'halted');
  assert.equal(f.store.getTask('task').hold, undefined);
  assert.equal(f.store.getMember(f.member.id).sessionId, undefined);
});

test('session replacement while setModel awaits cannot write or send to the replacement', async (t) => {
  const f = fixture(t);
  await f.warm();
  const entered = gate();
  const finish = gate();
  t.mock.method(f.adapter, 'setModel', async () => { entered.resolve(); await finish.promise; return { ok: true }; });
  f.add('task');
  const pending = f.dispatch('task');
  await entered.promise;
  const replacement = await f.adapter.create({});
  f.store.updateMember(f.member.id, { sessionId: replacement.sessionId, model: 'replacement/model' });
  finish.resolve();
  assert.equal((await pending).dispatched, 0);
  assertHeld(f, 'task');
  assert.equal(f.store.getMember(f.member.id).sessionId, replacement.sessionId);
  assert.equal(f.store.getMember(f.member.id).model, 'replacement/model');
  assert.equal(f.store.getMember(f.member.id).nativeModelSignature, undefined);
});

test('queued native dispatch fences a session changed while waiting for the model chain', async (t) => {
  const f = fixture(t);
  await f.warm();
  const blocked = gate();
  const cursor = gate();
  f.service.modelApplyChain = blocked.promise;
  f.adapter.turnCursor = async () => { cursor.resolve(); return 1; };
  f.add('task');
  const pending = f.dispatch('task');
  await cursor.promise;
  f.store.updateMember(f.member.id, { sessionId: 'new-session', model: 'replacement/model' });
  blocked.resolve();
  assert.equal((await pending).dispatched, 0);
  assertHeld(f, 'task');
  assert.equal(f.adapter.calls.some((call) => call.kind === 'setModel'), false);
});

test('the model apply chain remains held until native send finishes', async (t) => {
  const f = fixture(t);
  await f.warm();
  const entered = gate();
  const finish = gate();
  f.adapter.handler = async () => { entered.resolve(); await finish.promise; return {}; };
  f.add('task');
  const pending = f.dispatch('task');
  await entered.promise;
  let followed = false;
  const queued = f.service.modelApplyChain.then(() => { followed = true; });
  await Promise.resolve();
  assert.equal(followed, false);
  finish.resolve();
  assert.equal((await pending).dispatched, 1);
  await queued;
  assert.equal(followed, true);
});

test('uncertain native application followed by pin removal restores policy after hold release', async (t) => {
  const f = fixture(t);
  const sessionId = await f.warm();
  const set = f.adapter.setModel.bind(f.adapter);
  let fail = true;
  t.mock.method(f.adapter, 'setModel', async (input) => {
    const result = await set(input);
    if (fail) throw new Error('response lost after remote application');
    return result;
  });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 0);
  assertHeld(f, 'task');
  const uncertain = f.store.getMember(f.member.id);
  assert.equal(uncertain.model, 'preferred/old', 'an unconfirmed model must not be reported as applied');
  assert.match(uncertain.nativeModelSignature, /^unconfirmed:/);
  assert.deepEqual(uncertain.nativeModelPrevious, { model: 'preferred/old', reasoning: 'low' });
  fail = false;
  f.select(INHERIT);
  f.service.releaseTaskHold('alpha', 'task', {
    reason: 'pin removed', expectedReason: 'native_model_selection', actor: { role: 'admin' },
  });
  assert.equal((await f.dispatch('task')).dispatched, 1);
  const restored = f.adapter.calls.filter((call) => call.kind === 'setModel').at(-1).input;
  assert.deepEqual(restored, { sessionId, model: HOST.model, reasoning: HOST.reasoning });
  assert.equal(f.store.getMember(f.member.id).nativeModelSignature, undefined);
  assert.equal(f.store.getMember(f.member.id).nativeModelPrevious, undefined);
});

test('pin removal during setModel restores policy before send', async (t) => {
  const f = fixture(t);
  await f.warm();
  const set = f.adapter.setModel.bind(f.adapter);
  t.mock.method(f.adapter, 'setModel', async (input) => { const result = await set(input); f.select(INHERIT); return result; });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 1);
  assert.deepEqual(f.adapter.calls.filter((call) => call.kind === 'setModel').map((call) => call.input.model),
    ['custom/deepseek-chat', HOST.model]);
  assert.equal(f.store.getMember(f.member.id).nativeModelSignature, undefined);
});

test('a cancelled pin with no restorable model is held rather than silently sent', async (t) => {
  const f = fixture(t, { native: INHERIT, host: { source: 'none', model: null, reasoning: null } });
  f.config.zcode.defaultModel = null;
  await f.warm();
  f.store.updateMember(f.member.id, { model: 'custom/deepseek-chat', reasoning: null,
    nativeModelSignature: pin().signature, nativeModelPrevious: { model: null, reasoning: null } });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 0);
  assertHeld(f, 'task');
  assert.equal(f.adapter.calls.some((call) => call.kind === 'setModel'), false);
});

test('reader invalidation after creation holds the bound session without sending', async (t) => {
  const f = fixture(t);
  const create = f.adapter.create.bind(f.adapter);
  t.mock.method(f.adapter, 'create', async (input) => {
    const result = await create(input);
    f.select(Object.assign(new Error('sensitive settings contents'), { code: 'NATIVE_AGENT_STATE_INVALID' }));
    return result;
  });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 0);
  assertHeld(f, 'task');
  const member = f.store.getMember(f.member.id);
  assert.ok(member.sessionId);
  assert.equal(member.workerSessionStart, undefined);
  assert.equal(member.sessionRecoveryState, undefined);
  assert.equal(f.service.workspaceSessionCount(), 1);
});

test('a newer attempt during setModel is neither invalidated nor sent by the stale dispatch', async (t) => {
  const f = fixture(t);
  await f.warm();
  const entered = gate();
  const finish = gate();
  t.mock.method(f.adapter, 'setModel', async () => { entered.resolve(); await finish.promise; return { ok: true }; });
  f.add('task');
  const pending = f.dispatch('task');
  await entered.promise;
  f.store.updateTask('task', { attemptId: 'new-attempt', status: 'claimed' });
  finish.resolve();
  assert.equal((await pending).dispatched, 0);
  assert.equal(f.store.getTask('task').attemptId, 'new-attempt');
  assert.equal(f.store.getTask('task').hold, undefined);
  assert.equal(f.adapter.calls.some((call) => call.kind === 'send'), false);
  assert.equal(f.store.getMember(f.member.id).nativeModelSignature, undefined);
});

test('a rejected model application cannot mark a replaced session as unconfirmed', async (t) => {
  const f = fixture(t);
  await f.warm();
  t.mock.method(f.adapter, 'setModel', async () => {
    f.store.updateMember(f.member.id, { sessionId: 'replacement', model: 'replacement/model' });
    throw new Error('private failure');
  });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 0);
  assertHeld(f, 'task');
  assert.equal(f.store.getMember(f.member.id).nativeModelSignature, undefined);
  assert.equal(f.store.getMember(f.member.id).model, 'replacement/model');
});

test('no native reader preserves the existing host-follow dispatch path', async (t) => {
  const f = fixture(t, { inject: false });
  f.add('task');
  assert.equal((await f.dispatch('task')).dispatched, 1);
  const create = f.adapter.calls.find((call) => call.kind === 'create').input;
  assert.equal(create.model, HOST.model);
  assert.equal(create.reasoning, HOST.reasoning);
  assert.equal(create.modelSelection, undefined);
  assert.equal(f.adapter.calls.some((call) => call.kind === 'setModel'), false);
});
