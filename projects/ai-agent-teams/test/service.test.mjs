import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { Store } from '../src/store.mjs';

function setup() {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  for (const team of ['alpha', 'beta']) {
    service.createTeam({
      id: team,
      name: team,
      phase: 'running',
      members: [1, 2, 3].map((index) => ({ name: `${team}-w${index}`, role: 'worker' })),
    });
    for (let index = 1; index <= 3; index += 1) {
      service.addTask(team, {
        id: `${team}-${index}`,
        subject: `${team} task ${index}`,
        assignee: `${team}-w${index}`,
        kind: 'work',
      });
    }
  }
  return { config, store, adapter, service };
}

test('six active slots are split 3/3 across two teams', async () => {
  const { store, service } = setup();
  const results = await service.tickAll();
  assert.equal(results.find((item) => item.teamId === 'alpha').dispatched, 3);
  assert.equal(results.find((item) => item.teamId === 'beta').dispatched, 3);
  for (const team of ['alpha', 'beta']) {
    for (const task of store.listTasks(team)) {
      assert.equal(task.status, 'in_progress');
      assert.ok(task.attemptId);
    }
  }
  store.close();
});

test('completed work passes the delivery audit', async () => {
  const { store, service } = setup();
  await service.tickAll();
  for (const team of ['alpha', 'beta']) {
    for (const task of store.listTasks(team)) {
      const result = await service.completeTask({
        teamId: team,
        taskId: task.id,
        attemptId: task.attemptId,
        update: { status: 'completed', output: 'done' },
      });
      assert.equal(result.ok, true, result.error);
    }
    assert.equal(service.audit(team).ok, true);
  }
  store.close();
});

test('stale attempt updates are rejected', async () => {
  const { store, service } = setup();
  await service.tickAll();
  const task = store.getTask('alpha-1');
  await assert.rejects(
    service.completeTask({ teamId: 'alpha', taskId: task.id, attemptId: 'stale', update: { status: 'completed' } }),
    /stale attempt/,
  );
  store.close();
});

test('mail is delivered to an active member', async () => {
  const { store, service } = setup();
  await service.tickAll();
  store.addMessage({ teamId: 'alpha', from: 'captain', to: 'alpha-w1', content: 'please check' });
  const result = await service.tick('alpha');
  assert.equal(result.mail, 1);
  assert.ok(store.listMessages('alpha')[0].deliveredAt);
  store.close();
});

test('mail delivery failure does not abort the tick', async () => {
  const { store, adapter, service } = setup();
  await service.tickAll();
  store.addMessage({ teamId: 'alpha', from: 'captain', to: 'alpha-w1', content: 'please check' });
  adapter.handler = async (input) => {
    if (String(input.message).startsWith('Mail from')) {
      throw new Error('A prompt is already running for this session');
    }
    return { response: 'ok' };
  };
  const result = await service.tick('alpha');
  assert.equal(result.mail, 0);
  const failures = () => store.listEvents('alpha').filter((event) => event.type === 'message.delivery_failed');
  assert.equal(failures().length, 1);
  assert.equal(store.listMessages('alpha')[0].deliveredAt, undefined);
  const pending = store.listMessages('alpha')[0];
  assert.equal(pending.deliveryFailures, 1);
  assert.ok(pending.deliveryRetryAt > 1000, 'the message is deferred, not retried every tick');
  await service.tick('alpha');
  assert.equal(failures().length, 1, 'a deferred message does not emit another failure event');
  store.close();
});

test('tickAll defers a transient publication-held team without tick_failed spam', async () => {
  const { store, service } = setup();
  let clock = 1000;
  service.now = () => clock;
  const original = service.tickUnlocked.bind(service);
  let heldAttempts = 0;
  service.tickUnlocked = async (teamId) => {
    if (teamId === 'alpha' && heldAttempts < 2) {
      heldAttempts += 1;
      throw Object.assign(new Error('publication held'), { code: 'E_PUBLICATION_HELD', status: 409 });
    }
    return original(teamId);
  };

  const first = await service.tickAll();
  assert.equal(first.find((item) => item.teamId === 'alpha').blocked, 'publication-held');
  assert.equal(first.find((item) => item.teamId === 'beta').dispatched, 3);
  const second = await service.tickAll();
  assert.equal(second.find((item) => item.teamId === 'alpha').blocked, 'publication-held');
  assert.equal(heldAttempts, 1, 'the one-second retry is suppressed during the backoff window');
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'team.tick_failed').length, 0);

  clock += 5000;
  const third = await service.tickAll();
  assert.equal(third.find((item) => item.teamId === 'alpha').blocked, 'publication-held');
  assert.equal(heldAttempts, 2, 'the team is retried after backoff');
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'team.tick_failed').length, 0);
  store.close();
});

test('tickAll isolates one failing team from the other', async () => {
  const { store, service } = setup();
  const original = service.tick.bind(service);
  service.tick = async (teamId) => {
    if (teamId === 'alpha') throw new Error('alpha boom');
    return original(teamId);
  };
  const results = await service.tickAll();
  assert.equal(results.find((item) => item.teamId === 'alpha').error, 'alpha boom');
  assert.equal(results.find((item) => item.teamId === 'beta').dispatched, 3);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'team.tick_failed'));
  store.close();
});

test('busy-session prompt rejection is deferred without burning the retry budget', async () => {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter({
    handler: async () => { throw new Error('A prompt is already running for this session'); },
  });
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.addTask('alpha', { id: 'a1', subject: 'first', assignee: 'a1', kind: 'work' });
  await service.tick('alpha');
  const task = store.getTask('a1');
  assert.equal(task.status, 'pending');
  assert.equal(task.attemptId, undefined);
  assert.equal(task.turnFailureCount ?? 0, 0);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'task.dispatch_deferred'));
  assert.ok(!store.listEvents('alpha').some((event) => event.type === 'task.turn_failed'));
  store.close();
});

test('halt parks unfinished work and resume reactivates dispatch', async () => {
  const { store, service } = setup();
  await service.tick('alpha');
  const before = store.listTasks('alpha').find((task) => task.status === 'in_progress');
  await service.halt('alpha', 'stop for review');
  assert.equal(store.getTeam('alpha').control, 'halted');
  assert.equal(store.getTask(before.id).status, 'pending');
  assert.equal(store.getTask(before.id).priorStatus, 'in_progress');
  assert.equal(store.listAttempts('alpha').find((attempt) => attempt.id === before.attemptId)?.status, 'halted');
  await service.resume('alpha', 'approved to continue');
  assert.equal(store.getTeam('alpha').control, 'active');
  store.close();
});

test('dispatch failure rolls back the attempt', async () => {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter({ handler: async () => { throw new Error('boom'); } });
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.addTask('alpha', { id: 'a1', subject: 'first', assignee: 'a1', kind: 'work' });
  await service.tick('alpha');
  const task = store.getTask('a1');
  assert.equal(task.status, 'pending');
  assert.equal(task.attemptId, undefined);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'task.dispatch_failed'));
  store.close();
});


test('staged plan edit, approve and discard', async () => {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter, config, cwd: process.cwd(), now: () => 1000,
    roster: { alpha: [{ name: 'a1' }, { name: 'a2' }], beta: [{ name: 'b1' }] },
  });
  service.createTeam({ id: 'alpha', name: 'Alpha' });
  assert.equal(store.listMembers('alpha').length, 2);
  service.editPlan('alpha', { tasks: [{ id: 't1', subject: 'first', assignee: 'a1', kind: 'work' }] });
  assert.equal(store.getTask('t1').status, 'pending');
  await service.approve('alpha');
  assert.equal(store.getTeam('alpha').phase, 'running');
  assert.equal(store.getTask('t1').status, 'in_progress');
  service.createTeam({ id: 'beta', name: 'Beta' });
  service.discardPlan('beta', 'not needed');
  assert.equal(store.getTeam('beta').phase, 'archived');
  store.close();
});

test('remove member requeues its task and stops its session', async () => {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }, { name: 'a2' }] });
  service.addTask('alpha', { id: 't1', subject: 'first', assignee: 'a1', kind: 'work' });
  await service.tick('alpha');
  const member = store.findMember('alpha', 'a1');
  await service.removeMember('alpha', member.id);
  const task = store.getTask('t1');
  assert.equal(task.status, 'pending');
  assert.equal(task.attemptId, undefined);
  assert.equal(store.findMember('alpha', 'a1').status, 'removed');
  store.close();
});

test('reassign moves a task to another member', async () => {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }, { name: 'a2' }] });
  service.addTask('alpha', { id: 't1', subject: 'first', assignee: 'a1', kind: 'work' });
  await service.tick('alpha');
  await service.reassignTask('alpha', 't1', 'a2', 'handoff');
  assert.equal(store.getTask('t1').assignee, 'a2');
  assert.equal(store.getTask('t1').status, 'in_progress');
  store.close();
});

test('claim, heartbeat and amend are available', async () => {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  let clock = 1000;
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => clock });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.addTask('alpha', { id: 't1', subject: 'first', assignee: 'a1', kind: 'work' });
  await service.tick('alpha');
  const task = store.getTask('t1');
  service.claimTask('alpha', 't1', 'a1', task.attemptId);
  clock += 100;
  const heartbeat = service.heartbeatTask('alpha', 't1', task.attemptId);
  assert.ok(heartbeat.leaseExpiresAt > task.leaseExpiresAt);
  const amended = service.amendTask('alpha', 't1', { acceptance: ['updated'] }, 'clarify');
  assert.equal(amended.acceptance[0], 'updated');
  assert.equal(amended.revisions.length, 1);
  store.close();
});


test('daemon runs verify and forces failure on a failed command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-verify-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.txt'), 'one', 'utf8');
    const { config } = loadConfig('config/example.two-teams.json');
    const store = new Store(':memory:');
    const adapter = new FakeSessionAdapter();
    const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: root, now: () => 1000 });
    // The verify gate is what this test pins. The red-box review that continues
    // a failed task is covered in test/red-auto-review.test.mjs.
    service.redReview.enabled = false;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
    service.addTask('alpha', {
      id: 'impl', subject: 'impl', assignee: 'a1', kind: 'implementation',
      objective: 'x', acceptance: ['works'], inScope: ['src/'], verify: ['node -e "process.exit(0)"'],
    });
    await service.tick('alpha');
    const task = store.getTask('impl');
    const result = await service.completeTask({
      teamId: 'alpha', taskId: 'impl', attemptId: task.attemptId,
      update: {
        status: 'completed', acceptanceResults: [{ criterion: 'works', status: 'passed' }],
        changedPaths: ['src/a.txt'],
      },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(store.getTask('impl').commandsRun[0].status, 'passed');

    service.addTask('alpha', {
      id: 'impl2', subject: 'impl2', assignee: 'a1', kind: 'implementation',
      objective: 'x', acceptance: ['works'], inScope: ['src/'], verify: ['node -e "process.exit(1)"'],
    });
    await service.tick('alpha');
    const task2 = store.getTask('impl2');
    await service.completeTask({
      teamId: 'alpha', taskId: 'impl2', attemptId: task2.attemptId,
      update: {
        status: 'completed', acceptanceResults: [{ criterion: 'works', status: 'passed' }],
        changedPaths: ['src/a.txt'],
      },
    });
    assert.equal(store.getTask('impl2').status, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review completion snapshots artifacts and detects drift', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-drift-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.txt'), 'one', 'utf8');
    const { config } = loadConfig('config/example.two-teams.json');
    const store = new Store(':memory:');
    const adapter = new FakeSessionAdapter();
    const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: root, now: () => 1000 });
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'impl' }, { name: 'reviewer' }] });
    service.addTask('alpha', {
      id: 'impl', subject: 'impl', assignee: 'impl', kind: 'implementation',
      objective: 'x', acceptance: ['works'], inScope: ['src/'], verify: ['node -e "process.exit(0)"'],
    });
    store.updateTask('impl', {
      status: 'completed',
      changedPaths: ['src/a.txt'], acceptanceResults: [{ criterion: 'works', status: 'passed' }],
      commandsRun: [{ command: 'node -e "process.exit(0)"', status: 'passed' }],
    });
    service.addTask('alpha', {
      id: 'review', subject: 'review', assignee: 'reviewer', kind: 'review',
      objective: 'review', acceptance: ['quality'], reviewedTaskId: 'impl', dependencies: ['impl'],
    }, { internal: true });
    await service.tick('alpha');
    writeFileSync(join(root, 'src', 'a.txt'), 'two', 'utf8');
    const review = store.getTask('review');
    await service.completeTask({
      teamId: 'alpha', taskId: 'review', attemptId: review.attemptId,
      update: { status: 'completed', verdict: 'pass' },
    });
    assert.deepEqual(store.getTask('review').reviewedDuringDrift, ['src/a.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('plan edit is atomic when one task is invalid', () => {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'staged', members: [{ name: 'a1' }] });
  assert.throws(() => service.editPlan('alpha', {
    tasks: [
      { id: 'ok', subject: 'ok', assignee: 'a1', kind: 'work' },
      { id: 'bad', subject: 'bad', assignee: 'a1', kind: 'work', dependencies: ['missing'] },
    ],
  }), /invalid plan/);
  assert.equal(store.getTask('ok'), undefined);
  store.close();
});

test('a real SQLite write lock defers every writing team and never fails the tick', async () => {
  // Regression for a P2: `node:sqlite` reports lock contention as
  // `code: 'ERR_SQLITE_ERROR'` with a numeric `errcode` of 5 (BUSY) or 6
  // (LOCKED), never as an `'SQLITE_BUSY'` string code. This test uses a second
  // real connection on a real database file, so the error is produced by
  // SQLite and cannot be faked by a test double. A symbolic-code-only check
  // makes `tickAll()` rethrow and starve the healthy team.
  const directory = mkdtempSync(join(tmpdir(), 'ai-agent-teams-sqlite-lock-'));
  const dbPath = join(directory, 'state.db');
  const { config } = loadConfig('config/example.v06.json');
  config.scheduler.dynamicTeams = false;
  // A real file so a second connection can take an exclusive write lock.
  const store = new Store(dbPath);
  // Store() sets a 5s busy timeout; wait zero so contention surfaces at once.
  store.db.exec('PRAGMA busy_timeout = 0');
  let clock = 1000;
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter: new FakeSessionAdapter(),
    config,
    cwd: directory,
    now: () => clock,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  const task = (id) => ({
    id,
    subject: id,
    kind: 'work',
    objective: 'works',
    acceptance: ['works'],
    inScope: ['src/'],
    verify: ['node -e "process.exit(0)"'],
  });
  let locked;
  try {
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    clock += 1; // alpha must be ticked first so the lock hits it, not beta
    service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
    assert.deepEqual(store.listTeams().map((team) => team.id), ['alpha', 'beta']);
    // Both tasks must be dispatchable, so both teams attempt real writes.
    service.addTask('alpha', task('alpha-lock'));
    service.addTask('beta', task('beta-lock'));

    locked = new DatabaseSync(dbPath);
    locked.exec('PRAGMA busy_timeout = 0');
    locked.exec('BEGIN IMMEDIATE');
    locked.prepare('INSERT INTO events (team_id, type, created_at, data) VALUES (?, ?, ?, ?)')
      .run('alpha', 'external-writer', Date.now(), JSON.stringify({ probe: true }));

    let results;
    await assert.doesNotReject(async () => { results = await service.tickAll(); },
      'a busy database must defer the team instead of rejecting the whole tick');

    const alpha = results.find((result) => result.teamId === 'alpha');
    const beta = results.find((result) => result.teamId === 'beta');
    assert.equal(alpha.blocked, 'store-busy');
    assert.equal(alpha.deferred, 1);
    assert.equal(alpha.error, undefined, 'a transient lock is not reported as a team failure');
    // A SQLite write lock is database-wide: every team that tries to write is
    // deferred, and what this test protects is that none of them is reported as
    // a failed team and that the whole tick does not reject.
    assert.equal(beta.error, undefined, 'the peer team is deferred, never failed');
    assert.equal(beta.blocked, 'store-busy');

    assert.deepEqual([...service.transientTickBackoff.keys()].sort(), ['alpha', 'beta']);
    for (const teamId of ['alpha', 'beta']) {
      const backoff = service.transientTickBackoff.get(teamId);
      assert.equal(backoff.blocked, 'store-busy');
      assert.equal(backoff.attempts, 1);
      assert.ok(backoff.retryAt > service.now(), 'the deferred team retries later, not immediately');
    }

    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'team.tick_failed').length, 0,
      'a recoverable lock must not be recorded as a tick failure');
    assert.equal(store.listEvents('beta').filter((event) => event.type === 'team.tick_failed').length, 0,
      'the peer team is not recorded as a tick failure either');
    assert.equal(store.getTask('alpha-lock').status, 'pending', 'the blocked team made no progress');
    assert.equal(store.getTask('beta-lock').status, 'pending', 'a database-wide lock blocks every writer');

    // The deferred team is skipped while the backoff window is open.
    const repeated = await service.tickAll();
    const repeatedAlpha = repeated.find((result) => result.teamId === 'alpha');
    assert.equal(repeatedAlpha.blocked, 'store-busy');
    assert.equal(repeatedAlpha.deferred, 1);

    // After the lock is gone and the window has passed, alpha recovers.
    locked.exec('ROLLBACK');
    locked.close();
    locked = undefined;
    clock += 60000;
    const recovered = await service.tickAll();
    const recoveredAlpha = recovered.find((result) => result.teamId === 'alpha');
    assert.equal(recoveredAlpha.blocked, undefined);
    assert.ok(recoveredAlpha.dispatched > 0, 'the team ticks normally once the lock is released');
    assert.equal(service.transientTickBackoff.has('alpha'), false, 'a successful tick clears the backoff');
  } finally {
    if (locked) {
      try { locked.exec('ROLLBACK'); } catch { /* the transaction may already be gone */ }
      locked.close();
    }
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('amendment freezes after a passing review', () => {
  const { config } = loadConfig('config/example.two-teams.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.addTask('alpha', { id: 't1', subject: 't1', assignee: 'a1', kind: 'work' });
  store.updateTask('t1', { verdict: 'pass' });
  assert.throws(() => service.amendTask('alpha', 't1', { acceptance: ['x'] }, 'late'), /frozen/);
  store.close();
});
