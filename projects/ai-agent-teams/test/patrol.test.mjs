import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, applyDefaults } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { buildPatrolReport } from '../src/service/patrol-run.mjs';
import { ProtocolSessionAdapter } from '../src/session/protocol.mjs';

const MINUTE = 60 * 1000;
const INTERVAL = 15 * MINUTE;

function setup({ handler, startClock = 1_800_000_000_000, patch } = {}) {
  const { config } = loadConfig('config/example.v06.json');
  // The shipped v0.6 example still pins the legacy 10-minute contractor
  // patrol. This task changed the defaults, so exercise applyDefaults here;
  // the live config/local.json is the deployment override.
  delete config.patrol.intervalMinutes;
  delete config.patrol.whenCaptainBusy;
  patch?.(config);
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter({ handler });
  const clock = { now: startClock };
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter,
    config,
    cwd: process.cwd(),
    now: () => clock.now,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  return {
    config,
    store,
    adapter,
    service,
    clock,
    now: () => clock.now,
    advance: (ms) => { clock.now += ms; },
  };
}

function implementationTask(id, assignee = 'Engineer 01', extra = {}) {
  return {
    id,
    subject: id,
    kind: 'implementation',
    assignee,
    objective: 'works',
    acceptance: ['works'],
    inScope: ['src/'],
    verify: ['node -e "process.exit(0)"'],
    ...extra,
  };
}

function captainSends(adapter, store) {
  const captainSessionId = store.getTeam('alpha')?.captainSessionId;
  return adapter.calls.filter((call) => call.kind === 'send'
    && call.input.sessionId === captainSessionId
    && String(call.input.message ?? '').includes('[Patrol Report]'));
}

function reportEvents(store, type = 'patrol.captain') {
  return store.listEvents('alpha').filter((event) => event.type === type);
}

test('a queued report arriving during a flush is preserved for the next send', async () => {
  const { store, service, adapter, advance } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.updateTeam('alpha', { captainSessionId: 'captain-session' });
  service.queuePatrolReport('alpha', { text: 'first report', conclusion: 'first' }, 'busy', true);
  advance(30000);
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  adapter.send = async () => {
    started();
    return new Promise((resolve) => { release = resolve; });
  };
  const flushing = service.flushPatrolPending('alpha');
  await startedPromise;
  service.queuePatrolReport('alpha', { text: 'second report', conclusion: 'second' }, 'busy', true);
  release({ ok: true });
  assert.equal((await flushing).ran, true);
  assert.equal(store.getTeam('alpha').patrolPending.text, 'second report');
  assert.deepEqual(store.getTeam('alpha').patrolBacklog, []);
  store.close();
});

test('two services cannot send the same claimed outbox report', async () => {
  const { store, service, adapter, advance, config } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.updateTeam('alpha', { captainSessionId: 'captain-session' });
  service.queuePatrolReport('alpha', { text: 'one report', conclusion: 'ok' }, 'busy', true);
  advance(30000);
  let release;
  let calls = 0;
  adapter.send = async () => { calls += 1; return new Promise((resolve) => { release = resolve; }); };
  const other = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: service.now });
  const first = service.flushPatrolPending('alpha');
  await new Promise((resolve) => setImmediate(resolve));
  const second = await other.flushPatrolPending('alpha');
  assert.equal(second.ran, false);
  assert.equal(calls, 1);
  release({ ok: true });
  assert.equal((await first).ran, true);
  assert.equal(store.getTeam('alpha').patrolPending, undefined);
  store.close();
});

test('an uncertain patrol send remains queued without automatic replay after restart', async () => {
  const { store, service, adapter, advance, config } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.updateTeam('alpha', { captainSessionId: 'captain-session' });
  service.queuePatrolReport('alpha', { text: 'retained report', conclusion: 'unknown' }, 'busy', true);
  advance(30000);
  let sends = 0;
  adapter.send = async () => { sends += 1; throw new Error('connection lost after send'); };
  assert.equal((await service.flushPatrolPending('alpha')).reason, 'patrol-delivery-unknown');
  assert.equal(store.getTeam('alpha').patrolPending.text, 'retained report');
  const restarted = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd() });
  assert.equal((await restarted.flushPatrolPending('alpha')).reason, 'patrol-delivery-unknown');
  assert.equal(sends, 1);
  store.close();
});

test('captain stop or close failure retains the session identity and control occupancy', async () => {
  for (const failure of ['stop', 'close', 'unconfirmed']) {
    const { store, service, adapter } = setup();
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.updateTeam('alpha', { captainSessionId: 'captain-session' });
    adapter.stop = async () => (failure === 'stop' ? { ok: false, warning: 'stop failed' }
      : failure === 'unconfirmed' ? undefined : { ok: true });
    adapter.close = async () => failure === 'close' ? { ok: false, warning: 'close failed' } : { ok: true };
    await service.stopCaptainSession(store.getTeam('alpha'), 'test');
    assert.equal(store.getTeam('alpha').captainSessionId, 'captain-session');
    assert.equal(store.getTeam('alpha').needsCaptain, true);
    assert.equal(service.controlSessionCount(), 1);
    assert.equal(reportEvents(store, 'captain.stop_failed').length, 1);
    store.close();
  }
});

test('concurrent captain starts share one persisted creation reservation', async () => {
  const { store, service, adapter } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  let creates = 0;
  let release;
  adapter.create = async () => {
    creates += 1;
    return new Promise((resolve) => { release = resolve; });
  };
  const first = service.ensureCaptainSession(store.getTeam('alpha'));
  const second = service.ensureCaptainSession(store.getTeam('alpha'));
  assert.equal(creates, 1);
  assert.equal(store.getTeam('alpha').captainSessionStart.state, 'starting');
  assert.equal(service.controlSessionCount(), 1);
  release({ sessionId: 'one-session' });
  assert.deepEqual(await Promise.all([first, second]), ['one-session', 'one-session']);
  assert.equal(store.getTeam('alpha').captainSessionId, 'one-session');
  assert.equal(store.getTeam('alpha').captainSessionStart, undefined);
  store.close();
});

test('an ambiguous captain create retains the reservation and cannot restart automatically', async () => {
  const { store, service, adapter, config } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  let creates = 0;
  adapter.create = async () => { creates += 1; throw new Error('create response lost'); };
  await assert.rejects(() => service.ensureCaptainSession(store.getTeam('alpha')), /response lost/);
  assert.equal(store.getTeam('alpha').captainSessionStart.state, 'unknown');
  const restarted = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd() });
  assert.equal(restarted.controlSessionCount(), 1);
  await assert.rejects(() => restarted.ensureCaptainSession(store.getTeam('alpha')), /unresolved/);
  assert.equal(creates, 1);
  store.close();
});

test('a captain session created after halt stays unbound and retains its identity', async () => {
  const { store, service, adapter } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  let release;
  adapter.create = async () => new Promise((resolve) => { release = resolve; });
  const start = service.ensureCaptainSession(store.getTeam('alpha'));
  store.updateTeam('alpha', { control: 'halted' });
  release({ sessionId: 'late-session' });
  await assert.rejects(start, /changed before binding/);
  const team = store.getTeam('alpha');
  assert.equal(team.captainSessionId, undefined);
  assert.equal(team.captainSessionStart.state, 'unknown');
  assert.equal(team.captainSessionStart.sessionId, 'late-session');
  assert.equal(service.controlSessionCount(), 1);
  store.close();
});

test('patrol defaults to a 15-minute queue window and accepts an explicit override', () => {
  const { config } = loadConfig('config/example.v06.json');
  const raw = structuredClone(config);
  delete raw.patrol.intervalMinutes;
  delete raw.patrol.whenCaptainBusy;
  const defaults = applyDefaults(raw);
  assert.equal(defaults.patrol.intervalMinutes, 15);
  assert.equal(defaults.patrol.whenCaptainBusy, 'queue');

  // config/local.json may override the default; applyDefaults must not win.
  const local = structuredClone(raw);
  local.patrol.intervalMinutes = 5;
  local.patrol.whenCaptainBusy = 'one-shot-contractor';
  const overridden = applyDefaults(local);
  assert.equal(overridden.patrol.intervalMinutes, 5);
  assert.equal(overridden.patrol.whenCaptainBusy, 'one-shot-contractor');
});

test('a scheduled patrol reports once per 15 minutes while a member is executing', async () => {
  const { store, service, adapter, advance } = setup();
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }],
  });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  assert.equal(store.findMember('alpha', 'Engineer 01').status, 'working');
  assert.equal(store.getTask('t1').status, 'in_progress');

  advance(INTERVAL);
  const first = await service.patrolTickAll();
  assert.equal(first.length, 1);
  assert.equal(first[0].ran, true);
  assert.equal(first[0].conclusion, 'normal');
  const sends = captainSends(adapter, store);
  assert.equal(sends.length, 1);
  assert.match(sends[0].input.message, /\[Patrol Report\] Alpha/);
  assert.match(sends[0].input.message, /1\. Overview/);
  assert.match(sends[0].input.message, /7\. Suggested actions/);

  // Same window: no second report, even if the daemon ticks again.
  assert.deepEqual(await service.patrolTickAll(), []);
  advance(INTERVAL - 1);
  assert.deepEqual(await service.patrolTickAll(), []);
  advance(1);
  const second = await service.patrolTickAll();
  assert.equal(second[0].ran, true);
  assert.equal(captainSends(adapter, store).length, 2);
  assert.equal(reportEvents(store).length, 2);
});

test('halt and archive stop the captain session instead of leaving a stale id', async () => {
  const { store, service, adapter } = setup();
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }],
  });
  const firstId = await service.ensureCaptainSession(store.getTeam('alpha'));
  await service.halt('alpha', 'test halt');
  assert.equal(store.getTeam('alpha').captainSessionId, undefined);
  assert.equal(
    adapter.calls.filter((call) => call.kind === 'stop' && call.input.sessionId === firstId).length,
    1,
    'halt must stop the captain session',
  );

  await service.resume('alpha', 'test resume');
  const secondId = await service.ensureCaptainSession(store.getTeam('alpha'));
  assert.notEqual(secondId, firstId, 'resume must be able to create a fresh captain session');
  await service.archive('alpha');
  assert.equal(store.getTeam('alpha').captainSessionId, undefined);
  assert.equal(
    adapter.calls.filter((call) => call.kind === 'stop' && call.input.sessionId === secondId).length,
    1,
    'archive must stop the captain session',
  );
});

test('patrol skips a fully idle team and a team without unfinished tasks', async () => {
  const { store, service, adapter, advance } = setup();
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'Engineer 01' }],
  });
  service.createTeam({
    id: 'beta', name: 'Beta', phase: 'running',
    members: [{ name: 'Engineer 02' }],
  });
  // Alpha has work, but nobody is executing it.
  service.addTask('alpha', implementationTask('a1', 'Engineer 01'));
  // Beta has an executing member, but nothing unfinished.
  service.addTask('beta', implementationTask('b1', 'Engineer 02'));
  store.updateTask('b1', { status: 'completed' });
  const betaMember = store.findMember('beta', 'Engineer 02');
  store.updateMember(betaMember.id, { status: 'working', workState: 'busy' });

  advance(INTERVAL);
  const results = await service.patrolTickAll();
  const alpha = results.find((item) => item.teamId === 'alpha');
  const beta = results.find((item) => item.teamId === 'beta');
  assert.equal(alpha.reason, 'no-active-execution');
  assert.equal(beta.reason, 'no-active-work');
  assert.equal(store.getTeam('alpha').captainSessionId, undefined);
  assert.equal(store.getTeam('beta').captainSessionId, undefined);
  assert.equal(adapter.calls.filter((call) => call.kind === 'send'
    && String(call.input.message ?? '').includes('[Patrol Report]')).length, 0);
});

test('the report follows the fixed template and lists direction plus suggested actions', () => {
  const now = 1_800_000_000_000;
  const tasks = [
    { id: 'A21', subject: '自动继续 F1 返修', kind: 'repair', status: 'in_progress', assignee: 'eng-1', attemptId: 'at21' },
    { id: 'A22', subject: '自动继续 F1 复审', kind: 'review', status: 'pending', dependencies: ['A21'], reviewedTaskId: 'A21' },
    { id: 'A20', subject: 'A20 实现', kind: 'implementation', status: 'completed' },
    { id: 'A23', subject: '任务闭环自动化', kind: 'implementation', status: 'completed', inScope: ['src/'], changedPaths: ['src/a.mjs'] },
    { id: 'A24', subject: 'A20 审查', kind: 'review', status: 'failed', verdict: 'needs_revision', reviewedTaskId: 'A20' },
    { id: 'A25', subject: '返修完成', kind: 'repair', status: 'completed' },
    { id: 'A26', subject: '无人领取', kind: 'implementation', status: 'pending', createdAt: now - 20 * MINUTE },
    { id: 'A27', subject: '超时任务', kind: 'implementation', status: 'in_progress', assignee: 'eng-2', attemptId: 'at27' },
    { id: 'A29', subject: '范围漂移', kind: 'implementation', status: 'completed', inScope: ['src/'], changedPaths: ['docs/x.md'] },
    { id: 'A30', subject: '连续审查', kind: 'implementation', status: 'completed' },
    { id: 'R30-1', subject: 'review-1', kind: 'review', status: 'failed', verdict: 'needs_revision', round: 1, reviewedTaskId: 'A30' },
    { id: 'R30-2', subject: 'review-2', kind: 'review', status: 'failed', verdict: 'needs_revision', round: 2, reviewedTaskId: 'A30' },
  ];
  const attempts = [
    { id: 'at21', taskId: 'A21', status: 'claimed', startedAt: now - 28 * MINUTE },
    { id: 'at27', taskId: 'A27', status: 'claimed', startedAt: now - 130 * MINUTE },
    { id: 'e1', taskId: 'A27', status: 'failed', startedAt: now - 10 * MINUTE, endedAt: now - 9 * MINUTE, error: 'read ECONNRESET' },
    { id: 'e2', taskId: 'A27', status: 'failed', startedAt: now - 8 * MINUTE, endedAt: now - 7 * MINUTE, error: 'connect ECONNRESET' },
  ];
  const members = [
    { name: 'eng-1', role: 'engineer', status: 'working', workState: 'busy', lastActiveAt: now - 2 * MINUTE },
    { name: 'eng-2', role: 'engineer', status: 'idle', lastActiveAt: now - 60 * MINUTE },
    { name: 'rev-1', role: 'reviewer', status: 'idle' },
    { name: 'captain', role: 'captain', status: 'idle' },
  ];
  const report = buildPatrolReport({
    team: { id: 'alpha', name: 'A队', control: 'active' },
    tasks,
    members,
    attempts,
    now,
    windowStart: now - INTERVAL,
    intervalMinutes: 15,
    quota: 8,
    taskTimeoutMinutes: 120,
    noProgressMinutes: 30,
    captainName: 'captain',
  });

  // Every template section must be present.
  for (const heading of ['1. Overview', '2. In progress', '3. Waiting', '4. Broken chains', '5. Schedule and capacity', '6. Risks and errors', '7. Suggested actions']) {
    assert.ok(report.text.includes(heading), `missing ${heading}`);
  }
  assert.match(report.text, /Conclusion: off-course/);
  assert.equal(report.direction, 'off-course');
  assert.match(report.text, /- Unfinished: /);
  assert.match(report.text, /A21 自动继续 F1 返修 · eng-1 · running 28 minutes · last activity 2 minutes ago/);
  assert.match(report.text, /A22 自动继续 F1 复审 · waiting on A21/);
  assert.match(report.text, /- Worker slots: 8, used 2, free 6/);
  assert.match(report.text, /- Idle eligible members: 2 \(engineer 1 \/ reviewer 1\)/);

  // Chain detection. The two R30 reviews are also unhandled review failures.
  assert.deepEqual(report.facts.chains.completedMissingReview.sort(), ['A23', 'A29']);
  assert.deepEqual(report.facts.chains.reviewFailedMissingRepair.sort(), ['A24', 'R30-1', 'R30-2']);
  assert.deepEqual(report.facts.chains.repairCompletedMissingRereview, ['A25']);
  assert.deepEqual(report.facts.chains.longUnclaimed, ['A26']);

  // Risk detection.
  assert.deepEqual(report.facts.risks.repeatedErrors, [{ taskId: 'A27', count: 2 }]);
  assert.equal(report.facts.risks.runtimeIssues[0].taskId, 'A27');
  assert.deepEqual(report.facts.risks.scopeDrift, ['A29']);
  assert.deepEqual(report.facts.risks.consecutiveReviews, [{ taskId: 'A30', rounds: 2 }]);

  // Suggested actions are always explicit.
  for (const line of ['- Continue: A21, A27', '- Swap:', '- Repair: A24', '- Pause: A27', '- Escalate to captain:']) {
    assert.ok(report.text.includes(line), `missing action ${line}`);
  }
  assert.match(report.text, /Note: this report is read-only; it does not modify code, create tasks or merge./);
});

test('hidden historical rows do not create broken chains or scope-drift risks', () => {
  const now = 1_800_000_000_000;
  const report = buildPatrolReport({
    team: { id: 'alpha', name: 'A队', control: 'active' },
    tasks: [
      { id: 'A1', subject: '实现', kind: 'implementation', status: 'in_progress', assignee: 'eng-1', attemptId: 'a1' },
      { id: 'H2', subject: '历史实现', kind: 'implementation', status: 'completed', hidden: true, inScope: ['src/'], changedPaths: ['docs/x.md'] },
      { id: 'H4B', subject: '历史审查', kind: 'review', status: 'failed', hidden: true, reviewedTaskId: 'H2' },
    ],
    members: [{ name: 'eng-1', role: 'engineer', status: 'working', workState: 'busy', lastActiveAt: now - MINUTE }],
    attempts: [{ id: 'a1', taskId: 'A1', status: 'claimed', startedAt: now - 5 * MINUTE }],
    now,
    windowStart: now - INTERVAL,
    intervalMinutes: 15,
    quota: 8,
    taskTimeoutMinutes: 120,
    noProgressMinutes: 30,
    captainName: 'captain',
  });
  assert.equal(report.conclusion, 'normal');
  assert.equal(report.direction, 'on-track');
  assert.deepEqual(report.facts.chains.reviewFailedMissingRepair, []);
  assert.deepEqual(report.facts.risks.scopeDrift, []);
  assert.doesNotMatch(report.text, /H2|H4B/);
});

test('only recent terminal work is checked for a broken review chain', () => {
  const now = 1_800_000_000_000;
  const report = buildPatrolReport({
    team: { id: 'alpha', name: 'A队', control: 'active' },
    tasks: [
      { id: 'A1', subject: '实现', kind: 'implementation', status: 'in_progress', assignee: 'eng-1', attemptId: 'a1' },
      { id: 'OLD', subject: '旧实现', kind: 'implementation', status: 'completed', closedAt: now - 2 * 60 * MINUTE },
      { id: 'NEW', subject: '新实现', kind: 'implementation', status: 'completed', closedAt: now - 5 * MINUTE },
    ],
    members: [{ name: 'eng-1', role: 'engineer', status: 'working', workState: 'busy', lastActiveAt: now - MINUTE }],
    attempts: [{ id: 'a1', taskId: 'A1', status: 'claimed', startedAt: now - 5 * MINUTE }],
    now,
    windowStart: now - INTERVAL,
    intervalMinutes: 15,
    quota: 8,
    taskTimeoutMinutes: 120,
    noProgressMinutes: 30,
    captainName: 'captain',
  });
  assert.deepEqual(report.facts.chains.completedMissingReview, ['NEW']);
  assert.doesNotMatch(report.text, /OLD/);
});

test('a healthy executing team reports normal and explicitly says the direction is on track', () => {
  const now = 1_800_000_000_000;
  const report = buildPatrolReport({
    team: { id: 'alpha', name: 'A队', control: 'active' },
    tasks: [{ id: 'A1', subject: '实现', kind: 'implementation', status: 'in_progress', assignee: 'eng-1', attemptId: 'a1' }],
    members: [{ name: 'eng-1', role: 'engineer', status: 'working', workState: 'busy', lastActiveAt: now - MINUTE }],
    attempts: [{ id: 'a1', taskId: 'A1', status: 'claimed', startedAt: now - 5 * MINUTE }],
    now,
    windowStart: now - INTERVAL,
    intervalMinutes: 15,
    quota: 6,
  });
  assert.equal(report.conclusion, 'normal');
  assert.equal(report.direction, 'on-track');
  assert.match(report.text, /Conclusion: normal \(on-track\)/);
  assert.match(report.text, /7\. Suggested actions[\s\S]*- Continue: A1/);
  assert.match(report.text, /- Escalate to captain: none/);
});

test('patrol escalates reject without recommending an automatic repair', () => {
  const now = 1_800_000_000_000;
  const report = buildPatrolReport({
    team: { id: 'alpha', name: 'A队', control: 'active' },
    tasks: [{ id: 'reject-review', kind: 'review', status: 'failed', verdict: 'reject', reviewedTaskId: 'root', closedAt: now }],
    members: [], attempts: [], now, windowStart: now - INTERVAL, intervalMinutes: 15, quota: 6,
  });
  assert.ok(report.facts.actions.escalate.includes('reject-review'));
  assert.ok(!report.facts.actions.repair.includes('reject-review'));
  assert.ok(!report.facts.chains.reviewFailedMissingRepair.includes('reject-review'));
});

test('patrol classifies illegal scope paths without disclosing their values', () => {
  const now = 1_800_000_000_000;
  const sensitivePaths = ['/private/customer-record.csv', '../secrets/provider-token.txt', 'secrets/api.key'];
  const report = buildPatrolReport({
    team: { id: 'alpha', name: 'A队', control: 'active' },
    tasks: [{
      id: 'A44', subject: '路径分类巡检', kind: 'implementation', status: 'completed',
      changedPaths: sensitivePaths,
    }],
    now,
    intervalMinutes: 15,
  });

  assert.equal(report.conclusion, 'off-course');
  assert.deepEqual(report.facts.risks.scopeDrift, ['A44']);
  assert.ok(report.facts.actions.escalate.includes('A44'));
  assert.deepEqual(report.facts.risks.scopeClassifications, {
    A44: { illegal: sensitivePaths.length },
  });
  assert.match(report.text, /Scope classification: A44 \(illegal 3\)/);
  for (const path of sensitivePaths) assert.ok(!report.text.includes(path));
});

test('patrol preserves no-scope behavior for ordinary paths but reports explicit scope drift', () => {
  const now = 1_800_000_000_000;
  const report = buildPatrolReport({
    team: { id: 'alpha', name: 'A队', control: 'active' },
    tasks: [
      { id: 'A45', kind: 'implementation', status: 'completed', changedPaths: ['src/ordinary.mjs'] },
      { id: 'A46', kind: 'implementation', status: 'completed', inScope: ['src/'], changedPaths: ['docs/private-notes.md'] },
    ],
    now,
    intervalMinutes: 15,
  });

  assert.deepEqual(report.facts.risks.scopeDrift, ['A46']);
  assert.deepEqual(report.facts.risks.scopeClassifications, { A46: { undeclared: 1 } });
  assert.ok(!report.text.includes('docs/private-notes.md'));
});

test('a restarted daemon resumes from the persisted lastPatrolAt instead of reporting twice', async () => {
  const first = setup();
  first.service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }],
  });
  first.service.addTask('alpha', implementationTask('t1'));
  await first.service.tick('alpha');
  first.advance(INTERVAL);
  assert.equal((await first.service.patrolTickAll())[0].ran, true);
  assert.equal(captainSends(first.adapter, first.store).length, 1);
  const persisted = first.store.getTeam('alpha').lastPatrolAt;
  assert.ok(persisted > 0);

  // Simulate a daemon restart five minutes into the same window.
  first.advance(5 * MINUTE);
  const adapter2 = new FakeSessionAdapter();
  const restarted = new TeamService({ homeRoot: testHomeRoot(),
    store: first.store,
    adapter: adapter2,
    config: first.config,
    cwd: process.cwd(),
    now: () => first.clock.now,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  assert.equal(restarted.patrolLastAt.get('alpha'), persisted);
  assert.deepEqual(await restarted.patrolTickAll(), []);
  assert.equal(captainSends(adapter2, first.store).length, 0);

  // An adapter reporting an unknown session is not proof the old session has
  // stopped. Preserve its identity and hold the report for reconciliation.
  const previousSession = first.store.getTeam('alpha').captainSessionId;
  first.advance(10 * MINUTE);
  const third = await restarted.patrolTickAll();
  assert.equal(third[0].reason, 'patrol-delivery-unknown');
  assert.equal(first.store.getTeam('alpha').captainSessionId, previousSession);
  assert.equal(first.store.getTeam('alpha').patrolPending.state, 'unknown');
  assert.equal(adapter2.calls.filter((call) => call.kind === 'create').length, 0);
  assert.equal(reportEvents(first.store, 'patrol.report_failed').length, 0);
});

test('a busy captain receives the report through the queue instead of a contractor', async () => {
  const { store, service, adapter, advance } = setup();
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }],
  });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  store.updateTeam('alpha', { captainBusy: true });
  advance(INTERVAL);

  const results = await service.patrolTickAll();
  assert.equal(results[0].ran, true);
  assert.equal(results[0].captainBusy, true);
  const sends = captainSends(adapter, store);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].input.delivery, 'queue');
  assert.equal(store.listContractors('alpha').length, 0);
});

test('a report survives a crash after outbox persistence and before the first send', async () => {
  const { store, service, adapter, advance } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }] });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  advance(INTERVAL);
  const flush = service.flushPatrolPending.bind(service);
  service.flushPatrolPending = async () => { throw new Error('simulated daemon crash'); };
  await assert.rejects(service.patrolOnce('alpha'), /simulated daemon crash/);
  const pending = store.getTeam('alpha').patrolPending;
  assert.equal(pending.state, 'queued');
  assert.match(pending.text, /[Patrol Report]/);
  assert.equal(captainSends(adapter, store).length, 0);
  assert.equal(store.getTeam('alpha').lastPatrolAt, pending.createdAt);
  service.flushPatrolPending = flush;
  const recovered = await service.flushPatrolPending('alpha');
  assert.equal(recovered.ran, true);
  assert.equal(recovered.reportId, pending.reportId);
  assert.equal(captainSends(adapter, store).length, 1);
  assert.equal(store.getTeam('alpha').patrolPending, undefined);
});

test('an adapter busy ok:false patrol response stays unknown and is never automatically replayed', async () => {
  const { store, service, adapter, advance } = setup();
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }],
  });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  store.updateTeam('alpha', { captainBusy: true });
  let reportSends = 0;
  adapter.send = async (input) => {
    if (String(input.message ?? '').includes('[Patrol Report]')) {
      reportSends += 1;
      return { ok: false, warning: 'A prompt is already running for this session' };
    }
    return { ok: true };
  };
  advance(INTERVAL);

  const results = await service.patrolTickAll();
  assert.equal(results[0].ran, false);
  assert.equal(results[0].reason, 'patrol-delivery-unknown');
  assert.equal(reportEvents(store, 'patrol.report_failed').length, 0);
  assert.equal(reportEvents(store, 'patrol.queued').length, 1);
  assert.equal(reportEvents(store, 'patrol.delivery_unknown').length, 1);
  assert.equal(store.listMessages('alpha').filter((message) => message.to === 'captain').length, 0);
  const pending = store.getTeam('alpha').patrolPending;
  assert.equal(pending.state, 'unknown');
  assert.match(pending.text, /[Patrol Report]/);
  assert.ok(pending.claimId);
  assert.equal(store.getTeam('alpha').needsCaptain, true);
  assert.equal(reportSends, 1);

  // A later daemon tick preserves the unknown claim instead of replaying it.
  advance(30000);
  const flushed = await service.patrolTickAll();
  assert.equal(flushed[0].reason, 'patrol-delivery-unknown');
  assert.equal(store.getTeam('alpha').patrolPending.reportId, pending.reportId);
  assert.equal(store.getTeam('alpha').patrolPending.claimId, pending.claimId);
  assert.equal(store.getTeam('alpha').needsCaptain, true);
  assert.equal(reportSends, 1);
});

test('an uncertain report is retained without an automatic duplicate send', async () => {
  const { store, service, adapter, advance } = setup();
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }],
  });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const originalSend = adapter.send.bind(adapter);
  let failures = 1;
  adapter.send = async (input) => {
    if (String(input.message ?? '').includes('[Patrol Report]') && failures > 0) {
      failures -= 1;
      return { ok: false, warning: 'provider unavailable' };
    }
    return originalSend(input);
  };

  advance(INTERVAL);
  const first = await service.patrolTickAll();
  assert.equal(first[0].ran, false);
  assert.equal(first[0].reason, 'patrol-delivery-unknown');
  assert.equal(store.getTeam('alpha').patrolPending.state, 'unknown');
  // The failed window still counts: no immediate retry storm.
  assert.deepEqual(await service.patrolTickAll(), []);

  advance(INTERVAL);
  const second = await service.patrolTickAll();
  assert.equal(second[0].reason, 'patrol-delivery-unknown');
  assert.equal(captainSends(adapter, store).length, 0);
  // Scheduling is unaffected by the failed report.
  assert.equal(store.getTask('t1').status, 'in_progress');
});

test('patrol retries a local control-cap rejection without creating or sending a session', async () => {
  const { config, store, service, adapter, advance } = setup();
  config.scheduler.maxControlSessions = 1;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }, { name: 'captain' }] });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const lead = service.addMember('alpha', { name: 'Lead 01', role: 'lead' });
  store.updateMember(lead.id, { sessionId: 'control-reservation' });
  advance(INTERVAL);

  const first = await service.patrolTickAll();
  assert.equal(first[0].reason, 'patrol-admission-deferred');
  assert.equal(store.getTeam('alpha').patrolPending.state, 'queued');
  assert.notEqual(store.getTeam('alpha').needsCaptain, true);
  assert.equal(adapter.calls.filter((call) => call.kind === 'create' && call.input.memberId === 'captain:alpha').length, 0);
  assert.equal(captainSends(adapter, store).length, 0);

  store.updateMember(lead.id, { sessionId: undefined });
  advance(30000);
  const second = await service.patrolTickAll();
  assert.equal(second[0].ran, true);
  assert.equal(captainSends(adapter, store).length, 1);
  assert.equal(store.getTeam('alpha').patrolPending, undefined);
});

test('patrol requeues a workspace-session-cap rejection before captain creation', async () => {
  const { config, store, service, adapter, advance } = setup();
  config.scheduler.maxTotalSessions = 1;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }, { name: 'captain' }] });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  store.updateTeam('alpha', { captainSessionId: undefined });
  const worker = store.listMembers('alpha').find((member) => member.name === 'Engineer 01');
  assert.ok(worker.sessionId);
  advance(INTERVAL);

  const first = await service.patrolTickAll();
  assert.equal(first[0].reason, 'patrol-admission-deferred');
  assert.equal(store.getTeam('alpha').patrolPending.state, 'queued');
  assert.equal(adapter.calls.filter((call) => call.kind === 'create' && call.input.memberId === 'captain:alpha').length, 0);
  assert.equal(captainSends(adapter, store).length, 0);

  store.updateMember(worker.id, { sessionId: undefined });
  advance(30000);
  const second = await service.patrolTickAll();
  assert.equal(second[0].ran, true);
  assert.equal(captainSends(adapter, store).length, 1);
});

test('patrol requeues only a Protocol session/send request rejected before write', async () => {
  const { store, service, advance } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }, { name: 'captain' }] });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  await service.ensureCaptainSession(store.getTeam('alpha'));
  let blocked = true;
  const protocol = new ProtocolSessionAdapter({ client: {
    async request(method) {
      if (method === 'session/send' && blocked) {
        const error = Object.assign(new Error('request limit'), { code: 'E_PROTOCOL_PENDING_LIMIT', method, requestWritten: false });
        throw error;
      }
      return { result: 'ok' };
    },
  } });
  protocol.sessions.set(store.getTeam('alpha').captainSessionId, { sessionId: store.getTeam('alpha').captainSessionId, ephemeral: true });
  service.adapter = protocol;
  advance(INTERVAL);
  const first = await service.patrolTickAll();
  assert.equal(first[0].reason, 'patrol-admission-deferred');
  assert.equal(store.getTeam('alpha').patrolPending.state, 'queued');
  assert.notEqual(store.getTeam('alpha').needsCaptain, true);

  blocked = false;
  advance(30000);
  const second = await service.patrolTickAll();
  assert.equal(second[0].ran, true);
  assert.equal(store.getTeam('alpha').patrolPending, undefined);
});

test('a written pending-limit error is still ambiguous and never replays the patrol report', async () => {
  const { store, service, advance } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }, { name: 'captain' }] });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  await service.ensureCaptainSession(store.getTeam('alpha'));
  const protocol = new ProtocolSessionAdapter({ client: {
    async request(method) {
      if (method === 'session/send') {
        throw Object.assign(new Error('other pending request failed'), { code: 'E_PROTOCOL_PENDING_LIMIT', method });
      }
      return { result: 'ok' };
    },
  } });
  protocol.sessions.set(store.getTeam('alpha').captainSessionId, { sessionId: store.getTeam('alpha').captainSessionId, ephemeral: true });
  service.adapter = protocol;
  advance(INTERVAL);
  assert.equal((await service.patrolTickAll())[0].reason, 'patrol-delivery-unknown');
  assert.equal(store.getTeam('alpha').patrolPending.state, 'unknown');
  advance(INTERVAL);
  assert.equal((await service.patrolTickAll())[0].reason, 'patrol-delivery-unknown');
  assert.equal(store.getTeam('alpha').patrolPending.state, 'unknown');
});

test('a missing captain session remains recorded until it can be reconciled', async () => {
  const { store, service, adapter, advance } = setup();
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }],
  });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  // Persisted from a previous daemon; the adapter no longer knows this id.
  store.updateTeam('alpha', { captainSessionId: 'sess_dead' });

  advance(INTERVAL);
  const results = await service.patrolTickAll();
  assert.equal(results[0].reason, 'patrol-delivery-unknown');
  assert.equal(store.getTeam('alpha').captainSessionId, 'sess_dead');
  assert.equal(store.getTeam('alpha').patrolPending.state, 'unknown');
  assert.equal(adapter.calls.filter((call) => call.kind === 'create' && call.input.memberId === 'captain:alpha').length, 0);
  assert.equal(reportEvents(store, 'patrol.report_failed').length, 0);
});

test('the report is read-only: no task is created, changed, or merged', async () => {
  const { store, service, advance } = setup();
  service.createTeam({
    id: 'alpha', name: 'Alpha', phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }],
  });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const before = store.listTasks('alpha').map((task) => ({
    id: task.id, status: task.status, assignee: task.assignee, mergeState: task.mergeState,
  }));

  advance(INTERVAL);
  await service.patrolTickAll();
  const after = store.listTasks('alpha').map((task) => ({
    id: task.id, status: task.status, assignee: task.assignee, mergeState: task.mergeState,
  }));
  assert.deepEqual(after, before);
});
