import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { migratePhase0Epochs } from '../src/service/phase0-epochs.mjs';

function fixture() {
  const store = new Store(':memory:');
  for (const teamId of ['red', 'blue']) {
    store.createTeam({ id: teamId, controlEpoch: undefined, name: `${teamId} team` });
    for (const suffix of ['a', 'b']) {
      store.addTask({ id: `${teamId}-${suffix}`, teamId, status: 'merged', mergedCommit: `commit-${suffix}`, custom: { keep: true } });
      for (const generation of [1, 2]) {
        store.addAttempt({ id: `${teamId}-${suffix}-${generation}`, taskId: `${teamId}-${suffix}`, teamId, status: 'completed' });
      }
    }
  }
  return store;
}

test('phase 0 migrates two teams, tasks and attempts without changing merged task fields', () => {
  const store = fixture();
  try {
    const before = store.listTeams(true).flatMap((team) => store.listTasks(team.id));
    const result = migratePhase0Epochs(store);
    assert.deepEqual(result, { teams: 2, tasks: 4, attempts: 8, changed: true });
    for (const task of before) {
      const after = store.getTask(task.id);
      const { taskEpoch, controlEpoch, legacyLease, ...unchanged } = after;
      assert.deepEqual(unchanged, task);
      assert.equal(taskEpoch, 0);
      assert.equal(controlEpoch, 0);
      assert.equal(legacyLease, true);
    }
    for (const team of store.listTeams(true)) assert.equal(team.controlEpoch, 0);
    for (const attempt of store.listAttempts('red').concat(store.listAttempts('blue'))) {
      assert.equal(attempt.taskEpoch, 0);
      assert.equal(attempt.controlEpoch, 0);
      assert.equal(attempt.legacyLease, true);
    }
  } finally { store.close(); }
});

test('phase 0 is idempotent and writes no repeated migration events', () => {
  const store = fixture();
  try {
    migratePhase0Epochs(store);
    const eventCount = store.listEvents('red').length + store.listEvents('blue').length;
    assert.deepEqual(migratePhase0Epochs(store), { teams: 0, tasks: 0, attempts: 0, changed: false });
    assert.equal(store.listEvents('red').length + store.listEvents('blue').length, eventCount);
    for (const teamId of ['red', 'blue']) {
      assert.equal(store.listEvents(teamId).filter((event) => event.type === 'migration.phase0_epochs.completed').length, 1);
    }
  } finally { store.close(); }
});

test('phase 0 rolls back all SQLite changes and events when event recording fails', () => {
  const store = fixture();
  try {
    const teamsBefore = store.listTeams(true);
    const tasksBefore = teamsBefore.flatMap((team) => store.listTasks(team.id));
    const attemptsBefore = ['red', 'blue'].flatMap((teamId) => store.listAttempts(teamId));
    const addEvent = store.addEvent.bind(store);
    store.addEvent = (...args) => {
      addEvent(...args);
      throw new Error('injected transaction failure');
    };
    assert.throws(() => migratePhase0Epochs(store), /injected transaction failure/);
    store.addEvent = addEvent;
    assert.deepEqual(store.listTeams(true), teamsBefore);
    assert.deepEqual(teamsBefore.flatMap((team) => store.listTasks(team.id)), tasksBefore);
    assert.deepEqual(['red', 'blue'].flatMap((teamId) => store.listAttempts(teamId)), attemptsBefore);
    assert.equal(store.listEvents('red').length + store.listEvents('blue').length, 0);
  } finally { store.close(); }
});
