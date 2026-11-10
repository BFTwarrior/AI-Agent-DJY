import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { getDeliveryIntent, prepareDeliveryIntent, settleDeliveryIntent } from '../src/service/delivery-intents.mjs';

const identity = (extra = {}) => ({
  id: 'op-1', kind: 'integration', taskId: 'task-1', teamId: 'team-1',
  taskEpoch: 2, controlEpoch: 3, deliveryGeneration: 4, reviewDigest: 'review-digest',
  target: 'main', commit: 'abc123', artifact: 'sha256:artifact',
  initiator: 'captain', executor: 'daemon', ...extra,
});

function setup(path = ':memory:') {
  const store = new Store(path);
  store.createTeam({ id: 'team-1', name: 'one', control: 'active', controlEpoch: 3 });
  store.addTask({ id: 'task-1', teamId: 'team-1', taskEpoch: 2, controlEpoch: 3, deliveryGeneration: 4 });
  return store;
}

test('integration intent is durable before effects and can settle after simulated crash', () => {
  const store = setup();
  try {
    const first = prepareDeliveryIntent(store, identity({ payload: { branch: 'integration/op-1', worktreePath: '/controlled/op-1' } }));
    assert.equal(first.intent.phase, 'prepared');
    // Simulated process interruption: a new recovery call only sees the persisted DB snapshot.
    const recovered = getDeliveryIntent(store, 'task-1', 'integration', 'op-1');
    assert.equal(recovered.branch, 'integration/op-1');
    assert.equal(settleDeliveryIntent(store, { ...identity(), outcome: { appliedCommit: 'abc123' }, resultDigest: 'receipt-1' }).intent.phase, 'settled');
    assert.equal(getDeliveryIntent(store, 'task-1', 'integration', 'op-1').outcome.appliedCommit, 'abc123');
  } finally { store.close(); }
});

test('same operation is idempotent; a changed frozen identity conflicts', () => {
  const store = setup();
  try {
    prepareDeliveryIntent(store, identity());
    assert.equal(prepareDeliveryIntent(store, identity()).duplicate, true);
    assert.throws(() => prepareDeliveryIntent(store, identity({ commit: 'different' })), { code: 'E_INTENT_ID_CONFLICT' });
    settleDeliveryIntent(store, { ...identity(), outcome: 'ok', resultDigest: 'ok' });
    assert.throws(() => settleDeliveryIntent(store, { ...identity(), phase: 'blocked', outcome: 'x', resultDigest: 'different' }), { code: 'E_INTENT_TERMINAL' });
  } finally { store.close(); }
});

test('team mismatch, stale epochs and concurrent settle attempts fail closed/idempotently', async () => {
  const store = setup();
  try {
    assert.throws(() => prepareDeliveryIntent(store, identity({ teamId: 'other' })), { code: 'E_INTENT_TEAM_MISMATCH' });
    assert.throws(() => prepareDeliveryIntent(store, identity({ taskEpoch: 1 })), { code: 'E_INTENT_CAS_STALE' });
    prepareDeliveryIntent(store, identity());
    const calls = await Promise.all([
      Promise.resolve().then(() => settleDeliveryIntent(store, { ...identity(), outcome: 'ok', resultDigest: 'same' })),
      Promise.resolve().then(() => settleDeliveryIntent(store, { ...identity(), outcome: 'ok', resultDigest: 'same' })),
    ]);
    assert.equal(calls.filter((x) => x.duplicate).length, 1);
    assert.equal(store.listEvents('team-1').length, 2);
  } finally { store.close(); }
});

test('transaction rollback leaves no intent or event if event persistence fails', () => {
  const store = setup();
  const addEvent = store.addEvent.bind(store);
  try {
    store.addEvent = () => { throw new Error('injected event failure'); };
    assert.throws(() => prepareDeliveryIntent(store, identity()), /injected event failure/);
    assert.equal(store.getTask('task-1').deliveryIntents, undefined);
    store.addEvent = addEvent;
    assert.equal(store.listEvents('team-1').length, 0);
  } finally { store.close(); }
});

test('publish and negative intents share CAS and terminal transitions cannot be rewritten', () => {
  const store = setup();
  try {
    const pub = { ...identity({ id: 'pub', kind: 'publish', authorizationMode: 'on', payload: { rootId: 'root', expectedOldHead: 'base' } }) };
    store.updateTask('task-1', { stagedDeliveryIntent: { id: 'pub', rootId: 'root', mergeTargetId: 'task-1',
      taskEpoch: 2, controlEpoch: 3, deliveryGeneration: 4, targetRef: 'main', expectedOldHead: 'base',
      appliedCommit: 'abc123', artifactDigest: 'sha256:artifact', initiator: 'captain', publicationStarted: false } });
    prepareDeliveryIntent(store, pub);
    assert.equal(store.getTask('task-1').stagedDeliveryIntent.publicationStarted, true);
    settleDeliveryIntent(store, { ...pub, outcome: 'published' });
    assert.equal(prepareDeliveryIntent(store, pub).duplicate, true);
    const neg = { ...identity({ id: 'neg', kind: 'negative' }) };
    prepareDeliveryIntent(store, neg);
    settleDeliveryIntent(store, { ...neg, phase: 'blocked', outcome: 'ambiguous' });
    assert.equal(getDeliveryIntent(store, 'task-1', 'negative', 'neg').phase, 'blocked');
  } finally { store.close(); }
});

test('terminal duplicates require matching outcome as well as result digest', () => {
  const store = setup();
  try {
    prepareDeliveryIntent(store, identity());
    const settled = { ...identity(), outcome: { verdict: 'ok', findings: [] }, resultDigest: 'same' };
    settleDeliveryIntent(store, settled);
    assert.equal(settleDeliveryIntent(store, structuredClone(settled)).duplicate, true);
    assert.throws(() => settleDeliveryIntent(store, { ...settled, outcome: { verdict: 'bad' } }), { code: 'E_INTENT_TERMINAL' });
  } finally { store.close(); }
});

test('publish requires a matching staged operation and never fabricates one', () => {
  const store = setup();
  const pub = identity({ kind: 'publish', authorizationMode: 'on', payload: { rootId: 'root', expectedOldHead: 'base' } });
  const staged = { id: 'op-1', rootId: 'root', mergeTargetId: 'task-1', taskEpoch: 2,
    controlEpoch: 3, deliveryGeneration: 4, targetRef: 'main', expectedOldHead: 'base',
    appliedCommit: 'abc123', artifactDigest: 'sha256:artifact', initiator: 'captain', publicationStarted: false };
  try {
    assert.throws(() => prepareDeliveryIntent(store, pub), { code: 'E_INTENT_STAGED_MISSING' });
    for (const [key, value] of Object.entries({ id: 'other', mergeTargetId: 'other', taskEpoch: 1,
      controlEpoch: 2, deliveryGeneration: 3, targetRef: 'other', appliedCommit: 'other', artifactDigest: 'other', rootId: 'wrong', expectedOldHead: 'wrong', initiator: 'other' })) {
      store.updateTask('task-1', { stagedDeliveryIntent: { ...staged, [key]: value } });
      assert.throws(() => prepareDeliveryIntent(store, pub), { code: 'E_INTENT_STAGED_MISMATCH' }, key);
    }
    store.updateTask('task-1', { stagedDeliveryIntent: staged });
    prepareDeliveryIntent(store, pub);
    assert.equal(store.getTask('task-1').stagedDeliveryIntent.publicationStarted, true);
  } finally { store.close(); }
});

test('validates identity, actors, mode and payload before writing', () => {
  const store = setup();
  try {
    for (const key of ['taskId', 'teamId', 'target', 'commit', 'artifact', 'reviewDigest', 'taskEpoch', 'controlEpoch', 'deliveryGeneration']) {
      const value = identity(); delete value[key];
      assert.throws(() => prepareDeliveryIntent(store, value), { code: 'E_INTENT_IDENTITY_REQUIRED' }, key);
    }
    for (const value of [null, '', ' ', 4, {}, '__proto__']) assert.throws(() => prepareDeliveryIntent(store, identity({ id: value })), { code: 'E_INTENT_ID_REQUIRED' });
    for (const key of ['initiator', 'executor']) assert.throws(() => prepareDeliveryIntent(store, identity({ [key]: {} })), { code: 'E_INTENT_ACTORS_REQUIRED' });
    for (const key of ['taskEpoch', 'controlEpoch', 'deliveryGeneration']) assert.throws(() => prepareDeliveryIntent(store, identity({ [key]: -1 })), { code: 'E_INTENT_IDENTITY_REQUIRED' });
    assert.throws(() => prepareDeliveryIntent(store, identity({ kind: 'publish', authorizationMode: 'on', reviewDigest: null })), { code: 'E_INTENT_IDENTITY_REQUIRED' });
    assert.throws(() => prepareDeliveryIntent(store, identity({ kind: 'publish', authorizationMode: 'off' })), { code: 'E_INTENT_IDENTITY_REQUIRED' });
    assert.throws(() => prepareDeliveryIntent(store, identity({ payload: { phase: 'settled' } })), { code: 'E_INTENT_IMMUTABLE_FIELD' });
    assert.equal(store.getTask('task-1').deliveryIntents, undefined);
  } finally { store.close(); }
});

test('team control epoch and task generation fence prepare and settle', () => {
  const store = setup();
  try {
    store.createTeam({ id: 'other', name: 'other', controlEpoch: 3 });
    assert.throws(() => prepareDeliveryIntent(store, identity({ teamId: 'other' })), { code: 'E_INTENT_TEAM_MISMATCH' });
    prepareDeliveryIntent(store, identity());
    store.updateTeam('team-1', { controlEpoch: 4 });
    assert.throws(() => settleDeliveryIntent(store, identity()), { code: 'E_INTENT_CAS_STALE' });
    store.updateTeam('team-1', { controlEpoch: 3 });
    store.updateTask('task-1', { deliveryGeneration: 5 });
    assert.throws(() => settleDeliveryIntent(store, identity()), { code: 'E_INTENT_CAS_STALE' });
  } finally { store.close(); }
});

test('prepared intent survives SQLite file close and reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-intents-'));
  const db = join(dir, 'test.sqlite');
  let store;
  try {
    store = setup(db);
    prepareDeliveryIntent(store, identity({ payload: { branch: 'integration/op-1' } }));
    store.close();
    store = new Store(db);
    assert.equal(getDeliveryIntent(store, 'task-1', 'integration', 'op-1').branch, 'integration/op-1');
    assert.equal(settleDeliveryIntent(store, { ...identity(), outcome: 'recovered' }).intent.phase, 'settled');
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
