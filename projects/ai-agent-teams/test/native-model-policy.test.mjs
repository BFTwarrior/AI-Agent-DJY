import test from 'node:test';
import assert from 'node:assert/strict';
import { testHomeRoot } from './support/cleanup.mjs';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { ModelWatcher } from '../src/host-model.mjs';
import { readNativeWorkerModel, assertNativeModelSupported } from '../src/service/model-policy.mjs';

const inherit = () => ({ source: 'inherit', model: null, reasoning: null, modelSelection: null });
const native = (modelId = 'deepseek/chat', reasoning = null) => ({
  source: 'native-agent', pluginId: 'ai-agent-teams', agentId: 'team-worker',
  model: `provider/custom/${modelId}`, reasoning,
  modelSelection: {
    providerId: 'provider/custom', modelId,
    ...(reasoning ? { options: { reasoningLevel: reasoning } } : {}),
  },
  signature: JSON.stringify([modelId, reasoning]),
});

function setup(t, { selection = native(), host = { model: 'host/gpt', reasoning: 'high', source: 'host' }, policy = 'follow-host' } = {}) {
  const { config } = loadConfig('config/example.v06.json');
  config.zcode.defaultModel = 'default/model';
  config.zcode.defaultReasoning = 'high';
  config.zcode.modelPolicy = policy;
  const store = new Store(':memory:');
  t.after(() => store.close());
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({
    store, adapter, config, cwd: process.cwd(), homeRoot: testHomeRoot(),
    hostModel: () => host, nativeAgentModel: () => selection,
  });
  // The getter is the only reader contract; no real native settings are read.
  service.nativeAgentModel = () => selection;
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'worker', role: 'engineer' }, { name: 'lead', role: 'lead' }],
  });
  return { store, adapter, service, select(value) { selection = value; }, host(value) { host = value; } };
}

function activate(store, name, model = 'member/original') {
  const member = store.findMember('alpha', name);
  return store.updateMember(member.id, { sessionId: `session-${name}`, model, reasoning: 'low', status: 'working' });
}

for (const policy of ['follow-host', 'fixed']) {
  test(`native worker selection overrides ${policy} for members and leads without borrowing host reasoning`, (t) => {
    const { store, service } = setup(t, { policy });
    for (const name of ['worker', 'lead']) {
      const resolved = service.resolveModelForSpawn(store.findMember('alpha', name));
      assert.equal(resolved.model, native().model);
      assert.equal(resolved.reasoning, null);
      assert.deepEqual(resolved.modelSelection, native().modelSelection);
    }
    const snapshot = readNativeWorkerModel(service);
    snapshot.modelSelection.modelId = 'modified by caller';
    assert.deepEqual(readNativeWorkerModel(service).modelSelection, native().modelSelection);
  });
}

test('native inherit and absent injection retain original follow/fixed behavior and control seats ignore the pin', (t) => {
  const { service, select } = setup(t, { selection: inherit() });
  const member = { role: 'engineer', modelOverride: 'member/preferred', reasoningOverride: 'low' };
  assert.deepEqual(service.resolveModelForSpawn(member), { model: 'host/gpt', reasoning: 'high' });
  service.modelPolicy = { mode: 'fixed', model: 'fixed/model', reasoning: 'medium' };
  assert.deepEqual(service.resolveModelForSpawn(member), { model: 'fixed/model', reasoning: 'medium' });
  select(native());
  for (const role of ['shadow', 'captain']) {
    assert.equal(readNativeWorkerModel(service, { role }), null);
    assert.equal(service.resolveModelForSpawn({ role }).model, 'fixed/model');
  }
  service.nativeAgentModel = null;
  assert.equal(readNativeWorkerModel(service), null);
  assert.equal(service.resolveModelForSpawn(member).model, 'fixed/model');
});

test('native reader errors fail closed with stable codes and unsupported adapters cannot claim the pin', (t) => {
  const { service, adapter } = setup(t);
  const failure = Object.assign(new Error('invalid native selection'), { code: 'NATIVE_AGENT_INVALID_SELECTION' });
  service.nativeAgentModel = () => { throw failure; };
  assert.throws(() => readNativeWorkerModel(service), (error) => error === failure);
  assert.throws(() => service.resolveModelForSpawn(), (error) => error === failure);
  service.nativeAgentModel = () => { throw new Error('reader exploded'); };
  assert.throws(() => readNativeWorkerModel(service), { code: 'E_NATIVE_MODEL_READ' });
  service.nativeAgentModel = () => ({ source: 'native-agent', model: 'invalid' });
  assert.throws(() => readNativeWorkerModel(service), { code: 'E_NATIVE_MODEL_INVALID' });
  service.nativeAgentModel = () => native();
  for (const kind of ['cli', 'container']) {
    adapter.kind = kind;
    adapter.supportsModelSwitch = false;
    assert.throws(() => service.resolveModelForSpawn(), { code: 'E_NATIVE_MODEL_UNSUPPORTED' });
  }
  assert.equal(adapter.calls.length, 0);
  assert.doesNotThrow(() => assertNativeModelSupported({ kind: 'fake', supportsModelSwitch: false }));
});

test('hot apply preserves each native worker pin and passes structured IDs instead of parsing slashes', async (t) => {
  const { store, adapter, service } = setup(t);
  activate(store, 'worker');
  activate(store, 'lead');
  await service.applyModelToActiveSessions({ model: 'host/new-gpt', reasoning: 'max' });
  const calls = adapter.calls.filter((call) => call.kind === 'setModel');
  assert.equal(calls.length, 2);
  for (const { input } of calls) {
    assert.equal(input.model, native().model);
    assert.equal(input.reasoning, null);
    assert.deepEqual(input.modelSelection, native().modelSelection);
  }
  for (const member of store.listMembers('alpha')) {
    assert.equal(member.model, native().model);
    assert.equal(member.nativeModelSignature, native().signature);
    assert.deepEqual(member.nativeModelPrevious, { model: 'member/original', reasoning: 'low' });
  }
});

for (const policy of ['follow-host', 'fixed']) {
  test(`watcher detects native pin changes and cancellation under ${policy} without a host model`, async (t) => {
    const { store, service, select, adapter } = setup(t, { policy, host: { model: null, reasoning: null, source: 'none' } });
    const worker = activate(store, 'worker');
    const watcher = new ModelWatcher({ service, logger: { warn() {} } });
    assert.equal((await watcher.tick()).applied, 1);
    assert.equal((await watcher.tick()).changed, false);
    select(native('deepseek/reasoner', 'medium'));
    assert.equal((await watcher.tick()).applied, 1);
    assert.equal(store.getMember(worker.id).model, native('deepseek/reasoner').model);
    assert.equal(store.getMember(worker.id).reasoning, 'medium');
    select(inherit());
    assert.equal((await watcher.tick()).applied, 1);
    const restored = store.getMember(worker.id);
    assert.equal(restored.model, policy === 'fixed' ? 'default/model' : 'member/original');
    assert.equal(restored.nativeModelSignature, undefined);
    assert.equal(restored.nativeModelPrevious, undefined);
    assert.equal(adapter.calls.filter((call) => call.kind === 'setModel').length, 3);
  });
}

test('cancelling a native pin restores a configured member override rather than the effective native model', async (t) => {
  const { store, service, select } = setup(t, { host: { model: null, reasoning: null, source: 'none' } });
  const worker = activate(store, 'worker');
  store.updateMember(worker.id, { modelOverride: 'member/preferred', reasoningOverride: 'low' });
  const watcher = new ModelWatcher({ service, logger: { warn() {} } });
  await watcher.tick();
  select(inherit());
  await watcher.tick();
  assert.equal(store.getMember(worker.id).model, 'member/preferred');
  assert.equal(service.resolveModelForSpawn(store.getMember(worker.id)).model, 'member/preferred');
});

test('hot apply never records an old session result on a replacement member session', async (t) => {
  const { store, service, adapter } = setup(t);
  const worker = activate(store, 'worker');
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  adapter.setModel = async () => { entered.resolve(); await gate.promise; return { ok: true }; };
  const applying = service.applyModelToActiveSessions({ model: 'host/gpt' });
  await entered.promise;
  store.updateMember(worker.id, { sessionId: 'replacement', model: 'replacement/model' });
  gate.resolve();
  assert.equal((await applying).applied, 0);
  assert.equal(store.getMember(worker.id).model, 'replacement/model');
  assert.equal(store.getMember(worker.id).nativeModelSignature, undefined);
});

test('watcher reports native reader failures without applying host fallback', async (t) => {
  const { store, service, adapter } = setup(t);
  activate(store, 'worker');
  const warnings = [];
  service.nativeAgentModel = () => { throw Object.assign(new Error('native selection unavailable'), { code: 'NATIVE_AGENT_READ_FAILED' }); };
  const watcher = new ModelWatcher({ service, logger: { warn(message) { warnings.push(message); } } });
  const result = await watcher.tick();
  assert.equal(result.error, 'NATIVE_AGENT_READ_FAILED');
  assert.equal(adapter.calls.length, 0);
  assert.equal(warnings.length, 1);
});

for (const failure of ['reader', 'unsupported']) {
  test(`watcher audits ${failure} native failures once and preserves captain attention after recovery`, async (t) => {
    const { store, service, adapter } = setup(t);
    activate(store, 'worker');
    const read = service.nativeAgentModel;
    const code = failure === 'reader' ? 'NATIVE_AGENT_READ_FAILED' : 'E_NATIVE_MODEL_UNSUPPORTED';
    if (failure === 'reader') {
      service.nativeAgentModel = () => { throw Object.assign(new Error('private reader details'), { code }); };
    } else {
      adapter.kind = 'cli';
      adapter.supportsModelSwitch = false;
    }
    const watcher = new ModelWatcher({ service, logger: { warn() {} } });
    assert.equal((await watcher.tick()).error, code);
    assert.equal((await watcher.tick()).error, code);
    const events = store.listEvents('alpha').filter((event) => event.type === 'model.follow_failed');
    assert.equal(events.length, 1);
    assert.equal(events[0].errorCode, code);
    assert.equal(events[0].error, code, 'the event does not leak reader details');
    assert.equal(store.getTeam('alpha').needsCaptain, true);
    assert.equal(adapter.calls.length, 0);
    service.nativeAgentModel = read;
    adapter.kind = 'fake';
    adapter.supportsModelSwitch = true;
    assert.equal((await watcher.tick()).applied, 1);
    assert.equal(store.getTeam('alpha').needsCaptain, true, 'recovery must not clear other attention sources');
  });
}

for (const failure of ['throw', 'false']) {
  test(`a native switch with a ${failure} reply keeps restoration state when the pin is cancelled`, async (t) => {
    const { store, service, adapter, select } = setup(t, { policy: 'fixed' });
    const worker = activate(store, 'worker');
    const realSetModel = adapter.setModel.bind(adapter);
    adapter.setModel = async () => {
      if (failure === 'throw') throw new Error('reply lost after remote switch');
      return { ok: false, warning: 'reply rejected after remote switch' };
    };
    const watcher = new ModelWatcher({ service, logger: { warn() {} } });
    assert.equal((await watcher.tick()).failed.length, 1);
    assert.equal(store.getMember(worker.id).model, 'member/original');
    assert.equal(store.getMember(worker.id).nativeModelSignature, `unconfirmed:${native().signature}`);
    assert.deepEqual(store.getMember(worker.id).nativeModelPrevious, { model: 'member/original', reasoning: 'low' });
    select(inherit());
    // A failed restoration must retry even though fixed mode normally skips.
    assert.equal((await watcher.tick()).failed.length, 1);
    adapter.setModel = realSetModel;
    assert.equal((await watcher.tick()).applied, 1);
    assert.equal(store.getMember(worker.id).model, 'default/model');
    assert.equal(store.getMember(worker.id).nativeModelSignature, undefined);
    assert.equal(store.getMember(worker.id).nativeModelPrevious, undefined);
  });
}

test('a failed native switch cannot mark a replacement session as unconfirmed', async (t) => {
  const { store, service, adapter } = setup(t);
  const worker = activate(store, 'worker');
  adapter.setModel = async () => {
    store.updateMember(worker.id, { sessionId: 'replacement' });
    throw new Error('old session closed');
  };
  assert.equal((await service.applyModelToActiveSessions({ model: 'host/gpt' })).failed.length, 1);
  assert.equal(store.getMember(worker.id).nativeModelSignature, undefined);
  assert.equal(store.getMember(worker.id).nativeModelPrevious, undefined);
});

test('fixed-mode native changes do not switch shadow or captain seats', async (t) => {
  const { store, service, adapter } = setup(t, { policy: 'fixed' });
  activate(store, 'worker');
  const control = activate(store, 'lead');
  for (const role of ['shadow', 'captain']) {
    store.updateMember(control.id, { role, license: { roleKey: role } });
    const watcher = new ModelWatcher({ service, logger: { warn() {} } });
    assert.equal((await watcher.tick()).applied, 1);
    assert.equal(store.getMember(control.id).model, 'member/original');
  }
  assert.equal(adapter.calls.filter((call) => call.kind === 'setModel' && call.input.sessionId === control.sessionId).length, 0);
});

test('queued native hot applies reject superseded reader snapshots before side effects', async (t) => {
  const { store, service, adapter, select } = setup(t, { policy: 'fixed' });
  const worker = activate(store, 'worker');
  const gate = Promise.withResolvers();
  service.modelApplyChain = gate.promise;
  const watcher = new ModelWatcher({ service, logger: { warn() {} } });
  const applying = watcher.tick();
  select(native('new/pin'));
  gate.resolve();
  assert.equal((await applying).skipped, 'superseded');
  assert.equal(adapter.calls.length, 0);
  assert.equal(store.getMember(worker.id).model, 'member/original');
  assert.equal((await watcher.tick()).applied, 1);
  assert.deepEqual(adapter.calls[0].input.modelSelection, native('new/pin').modelSelection);
});

test('contractors snapshot the native pin at submission and create with its structured selection', async (t) => {
  const { store, service, adapter, select } = setup(t);
  service.pumpContractors = () => {};
  const record = await service.submitContractor({ teamId: 'alpha', prompt: 'Inspect only', model: 'caller/other', reasoning: 'max' });
  assert.equal(record.model, native().model);
  assert.equal(record.reasoning, null);
  assert.deepEqual(record.modelSelection, native().modelSelection);
  select(native('different/model'));
  await service.runContractor('alpha', record);
  const created = adapter.calls.find((call) => call.kind === 'create');
  assert.equal(created.input.model, native().model);
  assert.equal(created.input.reasoning, null);
  assert.deepEqual(created.input.modelSelection, native().modelSelection);
  assert.equal(store.getContractor(record.id).status, 'completed');
});

test('contractors reject unsupported native selections before queueing and daemon red reviews do not read native settings', async (t) => {
  const { store, service, adapter } = setup(t);
  service.pumpContractors = () => {};
  service.contractorAdapter = { kind: 'cli', supportsModelSwitch: false };
  await assert.rejects(service.submitContractor({ teamId: 'alpha', prompt: 'Inspect only' }), { code: 'E_NATIVE_MODEL_UNSUPPORTED' });
  assert.equal(store.listContractors('alpha').length, 0);
  assert.equal(adapter.calls.length, 0);
  service.nativeAgentModel = () => { throw new Error('must not read for daemon review'); };
  const review = await service.submitContractor({ teamId: 'alpha', purpose: 'red_auto_review', prompt: 'Continue failed task' });
  assert.equal(review.status, 'queued');
  assert.equal(review.modelSelection, undefined);
});
