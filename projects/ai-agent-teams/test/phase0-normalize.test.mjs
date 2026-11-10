import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { migrateLegacyRepairs, normalizeTaskModes, quarantineLegacy } from '../src/service/phase0-normalize.mjs';
import { nextReady } from '../src/domain/scheduler.mjs';

function storeWith(tasks, team = {}) {
  const store = new Store(':memory:');
  store.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', control: 'active', ...team });
  for (const task of tasks) store.addTask(task);
  return store;
}

test('legacy repair migration proves a parent or classifies it as manual legacy', () => {
  const store = storeWith([
    { id: 'root', teamId: 'alpha', kind: 'implementation', status: 'completed', mode: 'bound',
      deliveryUnitId: 'root', deliverySeq: 0, sourceCommit: 'root-c' },
    { id: 'review', teamId: 'alpha', kind: 'review', status: 'completed', verdict: 'pass',
      reviewedTaskId: 'root', binding: { sourceCommit: 'root-c', deliveryUnitId: 'root', deliverySeq: 0 } },
    { id: 'proven', teamId: 'alpha', kind: 'repair', status: 'completed', sourceTaskId: 'root',
      parentReviewTaskId: 'review', worktreeBase: 'root-c', sourceCommit: 'repair-c' },
    { id: 'unproven', teamId: 'alpha', kind: 'repair', status: 'completed', sourceTaskId: 'root' },
  ]);
  try {
    const first = migrateLegacyRepairs(store, { useWorktrees: true });
    assert.equal(first.migrated, 1);
    assert.equal(first.legacy, 1);
    const proven = store.getTask('proven');
    assert.equal(proven.mode, 'bound');
    assert.equal(proven.deliveryUnitId, 'root');
    assert.equal(proven.deliverySeq, 1);
    assert.equal(proven.bindingState, 'ready');
    const unproven = store.getTask('unproven');
    assert.equal(unproven.mode, 'legacy');
    assert.equal(unproven.legacyRepair, true);
    assert.equal(unproven.deliveryUnitId, undefined);
    const quarantined = quarantineLegacy(store);
    assert.equal(quarantined.quarantined, 1);
    const held = store.getTask('unproven');
    assert.equal(held.hold.class, 'legacy_repair_manual');
    assert.equal(held.status, 'cancelled');
    assert.ok(held.quarantinedAt > 0);
    assert.equal(held.historical, true);
    assert.equal(quarantineLegacy(store).quarantined, 0);
    const events = store.listEvents('alpha').filter((event) => event.type === 'task.repair_migrated').length;
    const second = migrateLegacyRepairs(store, { useWorktrees: true });
    assert.equal(second.changed, false);
    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'task.repair_migrated').length, events);
  } finally {
    store.close();
  }
});

test('mode normalization is idempotent and preserves merged rows', () => {  const store = storeWith([
    { id: 'impl', teamId: 'alpha', kind: 'implementation', status: 'completed', worktree: '/tmp/impl',
      worktreeBase: 'base-c' },
    { id: 'review', teamId: 'alpha', kind: 'review', status: 'pending', worktree: '/tmp/review' },
    { id: 'merged', teamId: 'alpha', kind: 'implementation', status: 'completed', mergeState: 'merged',
      mergeCommit: 'merged-c', mergedCommit: 'merged-c' },
    { id: 'integration-repair', teamId: 'alpha', kind: 'repair', status: 'pending',
      parentIntegrationId: 'int-root', deliveryUnitId: 'root', deliverySeq: 2 },
    { id: 'manual-repair', teamId: 'alpha', kind: 'repair', status: 'pending' },
  ]);
  try {
    const first = normalizeTaskModes(store, { useWorktrees: true });
    assert.ok(first.changed > 0);
    const impl = store.getTask('impl');
    assert.equal(impl.mode, 'bound');
    assert.equal(impl.deliveryUnitId, 'impl');
    assert.equal(impl.deliverySeq, 0);
    assert.equal(impl.bindingState, 'pending_adopt');
    assert.equal(store.getTask('review').mode, 'legacy');
    const merged = store.getTask('merged');
    assert.equal(merged.bindingState, 'merged');
    assert.equal(merged.mode, undefined);
    const integrationRepair = store.getTask('integration-repair');
    assert.equal(integrationRepair.mode, 'legacy');
    assert.equal(integrationRepair.deliveryUnitId, undefined);
    assert.equal(store.getTask('manual-repair').mode, 'legacy');
    const second = normalizeTaskModes(store, { useWorktrees: true });
    assert.equal(second.changed, 0);
  } finally {
    store.close();
  }
});

test('a migrated bound repair carries the root epoch and is dispatchable', () => {
  const store = storeWith([
    { id: 'root', teamId: 'alpha', kind: 'implementation', status: 'completed', mode: 'bound',
      deliveryUnitId: 'root', deliverySeq: 0, sourceBase: 'base-c', sourceCommit: 'root-c', taskEpoch: 2 },
    { id: 'review', teamId: 'alpha', kind: 'review', status: 'completed', verdict: 'pass',
      mode: 'bound', reviewMode: 'bound', reviewedTaskId: 'root',
      binding: { sourceCommit: 'root-c', sourceBase: 'base-c', sourceTaskId: 'root',
        deliveryUnitId: 'root', deliverySeq: 0 } },
    { id: 'repair', teamId: 'alpha', kind: 'repair', status: 'pending', sourceTaskId: 'root',
      parentReviewTaskId: 'review', worktreeBase: 'root-c', sourceBase: 'root-c', deliverySeq: 1 },
  ]);
  try {
    assert.equal(migrateLegacyRepairs(store, { useWorktrees: true }).migrated, 1);
    const repair = store.getTask('repair');
    assert.equal(repair.deliveryGeneration, 2);
    assert.equal(store.getTask('review').deliveryGeneration, 2);
    const ready = nextReady(store.listTasks('alpha'));
    assert.equal(ready.some((task) => task.id === 'repair'), true,
      'a promoted repair must be dispatchable in the root epoch');
    assert.equal(migrateLegacyRepairs(store, { useWorktrees: true }).changed, false);
  } finally {
    store.close();
  }
});
