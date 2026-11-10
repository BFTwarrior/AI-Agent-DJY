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
import { beginAttempt } from '../src/domain/attempts.mjs';
import { ModelWatcher } from '../src/host-model.mjs';
import { withNativeModelForDispatch, withNativeModelForMail } from '../src/service/native-model-dispatch.mjs';
import { removeTreeWithRetry } from './support/cleanup.mjs';

const HOST = { model: 'host/gpt', reasoning: 'high', source: 'host' };
const INHERIT = { source: 'inherit' };
const PIN = {
  source: 'native-agent', agentId: 'plugin:ai-agent-teams@test-market:team-worker',
  model: 'custom/provider/vendor/deepseek', reasoning: null, signature: 'deepseek-pin',
  modelSelection: { providerId: 'custom/provider', modelId: 'vendor/deepseek' },
};
const invalid = () => Object.assign(new Error('private settings diagnostic'), { code: 'NATIVE_AGENT_SELECTION_INVALID' });

function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, path, { selection = PIN, inject = true } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'native-send-paths-'));
  const { config } = loadConfig(fileURLToPath(new URL('../config/example.v06.json', import.meta.url)));
  config.features.lazyMembers = false;
  config.zcode.redAutoReview.enabled = false;
  config.zcode.modelPolicy = 'follow-host';
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  let clock = 1000;
  let native = selection;
  const service = new TeamService({ store, adapter, config, cwd, homeRoot: join(cwd, 'homes'),
    now: () => clock, hostModel: () => HOST,
    ...(inject ? { nativeAgentModel: () => {
      if (native instanceof Error) throw native;
      return native;
    } } : {}),
  });
  t.after(() => { service.close(); store.close(); removeTreeWithRetry(cwd); });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const member = service.addMember('alpha', { name: 'worker', role: 'engineer' });
  const { sessionId } = await adapter.create({ model: HOST.model });
  store.updateMember(member.id, { sessionId, workdir: cwd, model: HOST.model, reasoning: HOST.reasoning });
  let started;
  let message;
  if (path === 'continue') {
    const task = store.addTask({ id: 'task', teamId: 'alpha', subject: 'continue work', kind: 'work',
      status: 'pending', assignee: member.name, assigneeId: member.id, licenseId: member.licenseId,
      attempt: 1, dependencies: [], turnFailureCount: 2, continueDeferCount: 3, redContinueCount: 1,
    });
    started = beginAttempt(task, member.name, { now: clock });
    store.updateTask(task.id, { ...started, status: 'in_progress', autoContinue: true, retryNotBefore: clock });
    store.addAttempt({ id: started.attemptId, teamId: 'alpha', taskId: task.id, status: 'claimed', startedAt: clock });
  } else {
    message = store.addMessage({ id: 'mail', teamId: 'alpha', from: 'captain', to: member.name,
      content: 'Please check the result.', approvalState: 'approved', deliveryFailures: 2,
    });
  }
  adapter.calls.length = 0;
  const run = async () => path === 'continue'
    ? service.continueDueTurns('alpha', clock)
    : (await service.tick('alpha')).mail;
  return { path, cwd, store, adapter, service, member, sessionId, started, message, run,
    select: (value) => { native = value; }, advance: (ms = 5000) => { clock += ms; }, now: () => clock,
  };
}

function assertRefused(f) {
  assert.equal(f.adapter.calls.some((call) => call.kind === 'send'), false);
  assert.equal(f.store.getMember(f.member.id).sessionId, f.sessionId);
  assert.equal(f.store.getTeam('alpha').needsCaptain, true);
  if (f.path === 'continue') {
    const task = f.store.getTask('task');
    assert.equal(task.status, 'pending');
    assert.equal(task.attemptId, undefined);
    assert.equal(task.reassigning, false);
    assert.deepEqual(task.hold, { class: 'native_model_selection', reason: 'native_model_selection' });
    assert.equal(task.turnFailureCount, 2);
    assert.equal(task.continueDeferCount, 3);
    assert.equal(task.redContinueCount, 1);
    assert.equal(f.store.getAttempt(f.started.attemptId).status, 'failed');
    assert.equal(f.store.listEvents('alpha').some((event) => ['task.continue_deferred', 'task.continue_abandoned', 'task.turn_failed'].includes(event.type)), false);
  } else {
    const message = f.store.getMessage('mail');
    assert.equal(message.deliveredAt, undefined);
    assert.equal(message.discardedAt, undefined);
    assert.equal(message.content, f.message.content);
    assert.equal(message.deliveryFailures, 2);
    assert.equal(message.deliveryRetryAt, f.now() + 5000);
    assert.match(message.lastDeliveryError, /^(NATIVE_AGENT_|E_NATIVE_)/);
    assert.equal(f.store.listTasks('alpha').length, 0, 'mail must not manufacture a task');
    assert.equal(f.store.listAttempts('alpha').length, 0, 'mail must not manufacture an attempt');
  }
  assert.equal(JSON.stringify(f.store.listEvents('alpha')).includes('private settings'), false);
}

for (const path of ['continue', 'mail']) {
  test(`${path}: existing GPT session applies the native structured pin before sending`, async (t) => {
    const f = await fixture(t, path);
    assert.equal(await f.run(), 1);
    assert.deepEqual(f.adapter.calls.map((call) => call.kind), ['setModel', 'send']);
    assert.deepEqual(f.adapter.calls[0].input.modelSelection, PIN.modelSelection);
    assert.equal(f.adapter.calls[0].input.reasoning, null);
    assert.equal(f.adapter.calls[1].input.sessionId, f.sessionId);
    if (path === 'continue') assert.ok(f.adapter.calls[1].input.message.includes(f.started.attemptId));
    else assert.ok(f.store.getMessage('mail').deliveredAt);
  });

  test(`${path}: invalid native reader refuses delivery with recoverable state and no budget charge`, async (t) => {
    const f = await fixture(t, path, { selection: invalid() });
    assert.equal(await f.run(), 0);
    assertRefused(f);
    assert.equal(f.adapter.calls.length, 0);
    f.select(PIN);
    if (path === 'continue') {
      f.service.releaseTaskHold('alpha', 'task', { reason: 'settings repaired', expectedReason: 'native_model_selection', actor: { role: 'admin' } });
      assert.equal((await f.service.tick('alpha')).dispatched, 1);
      assert.equal(f.store.getTask('task').turnFailureCount, 2);
    } else {
      assert.equal(await f.run(), 0, 'honor the existing short retry deadline');
      f.advance();
      assert.equal(await f.run(), 1);
      assert.equal(f.store.getMessage('mail').deliveryFailures, 0);
      assert.equal(f.store.getMessage('mail').lastDeliveryError, undefined);
    }
  });

  for (const kind of ['cli', 'container']) {
    test(`${path}: ${kind} unsupported native selection does not bypass preflight`, async (t) => {
      const f = await fixture(t, path);
      f.adapter.kind = kind;
      f.adapter.supportsModelSwitch = false;
      assert.equal(await f.run(), 0);
      assertRefused(f);
      assert.equal(f.adapter.calls.length, 0);
    });
  }

  test(`${path}: watcher abandonment cannot permit stale-model delivery`, async (t) => {
    const f = await fixture(t, path);
    t.mock.method(f.adapter, 'setModel', async () => { throw new Error('private model transport diagnostic'); });
    const watcher = new ModelWatcher({ service: f.service, now: f.now, maxFailedTicks: 1, logger: { warn() {} } });
    const abandoned = await watcher.tick();
    assert.equal(abandoned.abandoned, true);
    assert.equal((await watcher.tick()).changed, false);
    assert.equal(await f.run(), 0);
    assertRefused(f);
    assert.equal(f.adapter.setModel.mock.callCount(), 2, 'the send path must attempt reconciliation independently of the watcher');
  });

  test(`${path}: deleting a pin restores host policy before delivery`, async (t) => {
    const f = await fixture(t, path, { selection: INHERIT });
    f.store.updateMember(f.member.id, { model: PIN.model, reasoning: null,
      nativeModelSignature: PIN.signature, nativeModelPrevious: { model: HOST.model, reasoning: HOST.reasoning } });
    assert.equal(await f.run(), 1);
    assert.deepEqual(f.adapter.calls[0].input, { sessionId: f.sessionId, model: HOST.model, reasoning: HOST.reasoning });
    assert.equal(f.store.getMember(f.member.id).nativeModelSignature, undefined);
    assert.equal(f.store.getMember(f.member.id).nativeModelPrevious, undefined);
  });

  test(`${path}: halt while setModel awaits prevents send without overwriting halt-owned state`, async (t) => {
    const f = await fixture(t, path);
    const entered = gate();
    const finish = gate();
    t.mock.method(f.adapter, 'setModel', async () => { entered.resolve(); await finish.promise; return { ok: true }; });
    const pending = f.run();
    await entered.promise;
    await f.service.halt('alpha', 'test halt');
    finish.resolve();
    assert.equal(await pending, 0);
    assert.equal(f.adapter.calls.some((call) => call.kind === 'send'), false);
    assert.equal(f.store.getMember(f.member.id).sessionId, undefined);
    if (path === 'continue') {
      assert.equal(f.store.getAttempt(f.started.attemptId).status, 'halted');
      assert.equal(f.store.getTask('task').hold, undefined);
    } else assert.equal(f.store.getMessage('mail').deliveredAt, undefined);
  });

  test(`${path}: session replacement while setModel awaits cannot receive or inherit stale writes`, async (t) => {
    const f = await fixture(t, path);
    const entered = gate();
    const finish = gate();
    t.mock.method(f.adapter, 'setModel', async () => { entered.resolve(); await finish.promise; return { ok: true }; });
    const pending = f.run();
    await entered.promise;
    f.store.updateMember(f.member.id, { sessionId: 'replacement', model: 'replacement/model' });
    finish.resolve();
    assert.equal(await pending, 0);
    assert.equal(f.adapter.calls.some((call) => call.kind === 'send'), false);
    assert.equal(f.store.getMember(f.member.id).model, 'replacement/model');
    assert.equal(f.store.getMember(f.member.id).nativeModelSignature, undefined);
  });

  test(`${path}: uncertain model application followed by removal safely recovers`, async (t) => {
    const f = await fixture(t, path);
    const set = f.adapter.setModel.bind(f.adapter);
    let fail = true;
    t.mock.method(f.adapter, 'setModel', async (input) => {
      const result = await set(input);
      if (fail) throw new Error('model applied but response lost');
      return result;
    });
    assert.equal(await f.run(), 0);
    assertRefused(f);
    assert.match(f.store.getMember(f.member.id).nativeModelSignature, /^unconfirmed:/);
    fail = false;
    f.select(INHERIT);
    if (path === 'continue') {
      f.service.releaseTaskHold('alpha', 'task', { reason: 'pin removed', expectedReason: 'native_model_selection', actor: { role: 'admin' } });
      assert.equal((await f.service.tick('alpha')).dispatched, 1);
    } else { f.advance(); assert.equal(await f.run(), 1); }
    assert.equal(f.adapter.calls.filter((call) => call.kind === 'setModel').at(-1).input.model, HOST.model);
    assert.equal(f.store.getMember(f.member.id).nativeModelSignature, undefined);
  });

  test(`${path}: no native reader keeps the existing send behavior`, async (t) => {
    const f = await fixture(t, path, { inject: false });
    assert.equal(await f.run(), 1);
    assert.deepEqual(f.adapter.calls.map((call) => call.kind), ['send']);
  });
}

test('continue: non-native busy deferral retains its existing count and backoff', async (t) => {
  const f = await fixture(t, 'continue', { inject: false });
  f.adapter.handler = async () => { throw new Error('prompt is already running'); };
  assert.equal(await f.run(), 0);
  const task = f.store.getTask('task');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.attemptId, f.started.attemptId);
  assert.equal(task.hold, undefined);
  assert.equal(task.continueDeferCount, 4);
  assert.equal(task.turnFailureCount, 2);
  assert.ok(task.retryNotBefore > f.now());
});

test('mail: non-native send rejection keeps its existing delivery failure backoff', async (t) => {
  const f = await fixture(t, 'mail', { inject: false });
  f.adapter.handler = async () => { throw new Error('prompt is already running'); };
  assert.equal(await f.run(), 0);
  const message = f.store.getMessage('mail');
  assert.equal(message.deliveryFailures, 3);
  assert.equal(message.deliveryRetryAt, f.now() + 20000);
  assert.equal(message.lastDeliveryError, 'prompt is already running');
  assert.equal(message.deliveredAt, undefined);
});

test('mail: approval withdrawn during native model application prevents delivery', async (t) => {
  const f = await fixture(t, 'mail');
  t.mock.method(f.adapter, 'setModel', async () => {
    f.store.updateMessage('mail', { approvalState: 'pending_captain' });
    return { ok: true };
  });
  assert.equal(await f.run(), 0);
  assert.equal(f.adapter.calls.some((call) => call.kind === 'send'), false);
  assert.equal(f.store.getMessage('mail').approvalState, 'pending_captain');
  assert.equal(f.store.getMessage('mail').deliveredAt, undefined);
});

test('mail: concurrent native deliveries recheck pending status inside the shared model chain', async (t) => {
  const f = await fixture(t, 'mail');
  const entered = gate();
  const finish = gate();
  t.mock.method(f.adapter, 'setModel', async () => { entered.resolve(); await finish.promise; return { ok: true }; });
  const first = f.run();
  await entered.promise;
  const second = f.run();
  finish.resolve();
  await Promise.all([first, second]);
  assert.equal(f.adapter.calls.filter((call) => call.kind === 'send').length, 1);
  assert.ok(f.store.getMessage('mail').deliveredAt);
});

test('missing member is a stable stale error in both task and task-free helpers', async (t) => {
  const f = await fixture(t, 'mail', { inject: false });
  const context = { teamId: 'alpha', memberId: 'missing', memberName: 'missing', sessionId: 'missing', controlEpoch: 0 };
  for (const helper of [withNativeModelForDispatch, withNativeModelForMail]) {
    assert.throws(() => helper(f.service, context, () => assert.fail('missing member must not send')),
      { code: 'E_NATIVE_DISPATCH_STALE' });
  }
});

test('manual continue uses its actual newly opened attempt when native configuration rejects', async (t) => {
  const f = await fixture(t, 'continue', { selection: invalid() });
  f.store.updateTask('task', { status: 'failed', attemptId: undefined, lastSessionId: f.sessionId });
  f.store.updateAttempt(f.started.attemptId, { status: 'failed' });
  const result = await f.service.continueTask('alpha', 'task', { actor: { role: 'admin' }, reason: 'continue task' });
  assert.equal(result.sent, false);
  const attempts = f.store.listAttempts('alpha');
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[1].id, f.started.attemptId);
  assert.equal(attempts[1].status, 'failed');
  assert.equal(f.store.getTask('task').hold.reason, 'native_model_selection');
  assert.equal(f.adapter.calls.some((call) => call.kind === 'send'), false);
});
