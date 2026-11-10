import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { readWindowsAcl, windowsUserSid } from '../src/fs-permissions.mjs';

test('store persists teams, members, tasks, messages, events, usage and plans', () => {
  const store = new Store(':memory:');
  try {
    store.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', control: 'active' });
    store.addMember({ teamId: 'alpha', name: 'alice', role: 'worker' });
    store.addTask({ id: 't1', teamId: 'alpha', subject: 'task', assignee: 'alice', dependencies: [] });
    store.addMessage({ teamId: 'alpha', to: 'alice', content: 'hello' });
    store.addEvent('alpha', 'test.event', { value: 1 });
    store.recordUsage({ teamId: 'alpha', memberId: 'm1', totalTokens: 10 });
    store.savePlan('alpha', { status: 'staged', members: ['alice'], tasks: ['t1'] });

    assert.equal(store.getTeam('alpha').name, 'Alpha');
    assert.equal(store.listMembers('alpha')[0].name, 'alice');
    assert.equal(store.getTask('t1').subject, 'task');
    assert.equal(store.listMessages('alpha')[0].content, 'hello');
    assert.equal(store.listEvents('alpha').length, 1);
    assert.equal(store.listUsage('alpha')[0].totalTokens, 10);
    assert.equal(store.getPlan('alpha').status, 'staged');

    store.updateTask('t1', { status: 'completed', output: 'done' });
    assert.equal(store.getTask('t1').status, 'completed');
    store.archiveTeam('alpha');
    assert.equal(store.getTeam('alpha').phase, 'archived');
    assert.equal(store.listTeams().length, 0);
    assert.equal(store.listTeams(true).length, 1);
  } finally {
    store.close();
  }
});

test('publication guard prevents cross-connection review and identity mutations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-teams-publication-'));
  const first = new Store(join(dir, 'db.sqlite'));
  const second = new Store(join(dir, 'db.sqlite'));
  try {
    first.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', control: 'active' });
    first.createTeam({ id: 'beta', name: 'Beta', phase: 'running', control: 'active' });
    first.addMember({ id: 'member', teamId: 'alpha', name: 'reviewer' });
    first.addTask({ id: 'review', teamId: 'alpha', kind: 'review', status: 'completed' });
    first.updateTeam('alpha', { publicationGuard: { operationId: 'publisher', taskId: 'root' } });
    for (const write of [
      () => second.updateTask('review', { archived: true }),
      () => second.addTask({ id: 'new-review', teamId: 'alpha', kind: 'review' }),
      () => second.updateMember('member', { status: 'removed' }),
      () => second.updateTeam('alpha', { phase: 'archived' }),
      () => second.addTask({ id: 'other-team', teamId: 'beta', kind: 'review' }),
    ]) assert.throws(write, (error) => error.code === 'E_PUBLICATION_HELD');
    assert.throws(() => second.updateTeam('alpha', { publicationGuard: undefined }, { publicationOwner: 'wrong' }),
      (error) => error.code === 'E_PUBLICATION_HELD');
    first.updateTask('review', { evidence: 'settled' }, { publicationOwner: 'publisher' });
    first.updateTeam('alpha', { publicationGuard: undefined }, { publicationOwner: 'publisher' });
    second.updateTask('review', { archived: true });
    assert.equal(first.getTask('review').archived, true);
  } finally {
    second.close(); first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store rejects duplicate team, member, and task ids', () => {
  const store = new Store(':memory:');
  try {
    store.createTeam({ id: 'alpha', name: 'Alpha' });
    assert.throws(() => store.createTeam({ id: 'alpha', name: 'Again' }), /already exists/);
    store.addMember({ teamId: 'alpha', name: 'alice' });
    assert.throws(() => store.addMember({ teamId: 'alpha', name: 'alice' }), /duplicate member/);
    store.addTask({ id: 't1', teamId: 'alpha', subject: 'task', dependencies: [] });
    assert.throws(() => store.addTask({ id: 't1', teamId: 'alpha', subject: 'again', dependencies: [] }), /already exists/);
  } finally {
    store.close();
  }
});

test('store creates its parent directory and database privately', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-store-'));
  const nested = join(root, 'nested');
  // Simulate a directory created by an older version or an external tool.
  mkdirSync(nested, { recursive: true, mode: 0o755 });
  chmodSync(nested, 0o755);
  const dbPath = join(nested, 'state.sqlite');
  writeFileSync(dbPath, '');
  const store = new Store(dbPath);
  try {
    const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync);
    if (process.platform === 'win32') {
      const userSid = windowsUserSid();
      const expectedSids = new Set([userSid, 'S-1-5-18']);
      for (const path of [nested, dbPath, ...sidecars]) {
        const acl = readWindowsAcl(path);
        assert.deepEqual(
          acl.map(({ sid }) => sid).sort(),
          [...expectedSids].sort(),
          `${path} must grant access only to the current user and LocalSystem`,
        );
        for (const entry of acl) {
          assert.equal(entry.type, 'Allow', `${path} must not contain deny ACEs`);
          assert.equal(Number(entry.rights), 2032127, `${path} must grant only FullControl`);
          assert.equal(entry.inherited, false, `${path} must not have inherited ACEs`);
        }
      }
    } else {
      assert.equal(statSync(nested).mode & 0o777, 0o700, 'existing database directory must be tightened to 0700');
      assert.equal(statSync(dbPath).mode & 0o777, 0o600, 'database file must be restricted to 0600');
      for (const sidecar of sidecars) {
        assert.equal(statSync(sidecar).mode & 0o777, 0o600, `${sidecar} must be restricted to 0600`);
      }
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('store reopens a filesystem database after the permission best-effort', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-store-file-'));
  const dbPath = join(root, 'state.sqlite');
  try {
    const first = new Store(dbPath);
    first.createTeam({ id: 'alpha', name: 'Alpha' });
    first.close();
    const second = new Store(dbPath);
    try {
      assert.equal(second.getTeam('alpha').name, 'Alpha');
    } finally {
      second.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test('pruneEvents keeps the newest rows and leaves history alone under the cap', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 10; i += 1) store.addEvent('alpha', `e${i}`, { value: i });
    assert.equal(store.pruneEvents(10), 0);
    assert.equal(store.listEvents('alpha').length, 10);
    assert.equal(store.pruneEvents(4), 6);
    const remaining = store.listEvents('alpha');
    assert.deepEqual(remaining.map((event) => event.type), ['e6', 'e7', 'e8', 'e9']);
    assert.throws(() => store.pruneEvents(0), /positive integer/);
  } finally {
    store.close();
  }
});

test('pruneEvents never deletes events belonging to an archived team', () => {
  const store = new Store(':memory:');
  try {
    store.createTeam({ id: 'old', name: 'Old', phase: 'archived' });
    for (let i = 0; i < 5; i += 1) store.addEvent('old', `archived-${i}`, { value: i });
    store.createTeam({ id: 'live', name: 'Live', phase: 'running' });
    for (let i = 0; i < 5; i += 1) store.addEvent('live', `live-${i}`, { value: i });
    // The newest four rows are live; the archived tail is older than the
    // cutoff, but it must survive the retention sweep.
    assert.equal(store.pruneEvents(4), 1);
    assert.equal(store.listEvents('old').length, 5);
    assert.deepEqual(store.listEvents('live').map((event) => event.type), ['live-1', 'live-2', 'live-3', 'live-4']);
  } finally {
    store.close();
  }
});

test('archived events newer than live rows do not consume the live retention window', () => {
  const store = new Store(':memory:');
  try {
    store.createTeam({ id: 'live', name: 'Live', phase: 'running' });
    for (let i = 0; i < 8; i += 1) store.addEvent('live', `live-${i}`, { value: i });
    store.createTeam({ id: 'old', name: 'Old', phase: 'archived' });
    for (let i = 0; i < 3; i += 1) store.addEvent('old', `archived-${i}`, { value: i });
    const archivedBefore = store.listEvents('old').length;
    // Live rows: 8 events. Keeping 6 deletes 2 live rows. A global cutoff
    // would instead delete 5 live rows because the 3 archived rows are newer
    // and push the cutoff forward.
    assert.equal(store.pruneEvents(6), 2);
    assert.equal(store.listEvents('live').length, 6);
    assert.equal(store.listEvents('old').length, archivedBefore);
  } finally {
    store.close();
  }
});

test('transaction defers events until COMMIT and flushes them in order', () => {
  const store = new Store(':memory:');
  const seen = [];
  store.subscribe((event) => seen.push(event));
  try {
    store.transaction(() => {
      store.createTeam({ id: 'alpha', name: 'Alpha' });
      store.addMember({ teamId: 'alpha', name: 'alice' });
      store.addEvent('alpha', 'alpha.event', { value: 1 });
      assert.equal(seen.length, 0, 'listeners must not observe uncommitted events');
    });
    assert.deepEqual(seen.map((event) => event.type), ['team.created', 'member.added', 'event']);
    assert.equal(store.listEvents('alpha').length, 1);
    assert.equal(store.getTeam('alpha').name, 'Alpha');
  } finally {
    store.close();
  }
});

test('transaction discards buffered events on rollback', () => {
  const store = new Store(':memory:');
  const seen = [];
  store.subscribe((event) => seen.push(event));
  try {
    assert.throws(() => store.transaction(() => {
      store.createTeam({ id: 'alpha', name: 'Alpha' });
      store.addEvent('alpha', 'alpha.event', {});
      throw new Error('rollback please');
    }), /rollback please/);
    assert.equal(seen.length, 0);
    assert.equal(store.getTeam('alpha'), undefined);
    assert.equal(store.listEvents('alpha').length, 0);
    // Buffering must be reset: later writes emit immediately again.
    store.createTeam({ id: 'beta', name: 'Beta' });
    assert.deepEqual(seen.map((event) => event.type), ['team.created']);
  } finally {
    store.close();
  }
});

test('transaction is not reentrant and recovers after a nested failure', () => {
  const store = new Store(':memory:');
  const seen = [];
  store.subscribe((event) => seen.push(event));
  try {
    store.transaction(() => {
      store.createTeam({ id: 'alpha', name: 'Alpha' });
      assert.throws(() => store.transaction(() => {}), /not reentrant/);
    });
    assert.deepEqual(seen.map((event) => event.type), ['team.created']);
    // A nested failure that escapes the outer callback rolls the outer back.
    assert.throws(() => store.transaction(() => {
      store.addMember({ teamId: 'alpha', name: 'bob' });
      store.transaction(() => {});
    }), /not reentrant/);
    assert.equal(store.findMember('alpha', 'bob'), undefined);
    assert.equal(seen.length, 1);
  } finally {
    store.close();
  }
});

test('transaction rejects an async callback instead of committing early', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(
      () => store.transaction(async () => {
        store.createTeam({ id: 'alpha', name: 'Alpha' });
      }),
      /must be synchronous/,
    );
    assert.equal(store.inTransaction, false, 'the failed transaction must be rolled back');
    assert.equal(store.getTeam('alpha'), undefined);
    // A later synchronous transaction still works after the rejection.
    store.transaction(() => store.createTeam({ id: 'beta', name: 'Beta' }));
    assert.equal(store.getTeam('beta').name, 'Beta');
  } finally {
    store.close();
  }
});

test('event pruning compacts persistent database outside transactions and remains readable', () => {
  const root = mkdtempSync(join(tmpdir(), 'store-vacuum-'));
  const path = join(root, 'state.db');
  const store = new Store(path);
  try {
    store.createTeam({ id: 'alpha', name: 'Alpha' });
    store.transaction(() => {
      for (let i = 0; i < 1200; i += 1) store.addEvent('alpha', 'large', { text: 'x'.repeat(4000) });
    });
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = statSync(path).size;
    const deleted = store.pruneEvents(10);
    assert.equal(deleted, 1190);
    assert.ok(statSync(path).size <= before, 'pruning does not grow the database file');
    assert.throws(() => store.transaction(() => store.compactAfterPrune(deleted)), /committed transaction/);
    assert.equal(store.compactAfterPrune(deleted), true);
    assert.ok(statSync(path).size < before);
    assert.equal(store.listEvents('alpha').length, 10);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(store.compactAfterPrune(0), false);
    assert.equal(existsSync(path), true);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
