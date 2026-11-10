import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import {
  closedLoopRepairTaskId,
  closedLoopReviewTaskId,
  evidenceBackedCompletion,
  planCompletionFanOut,
  planCompletionReview,
  planFailedReviewFollowUp,
  planFollowUp,
  reviewScoresSatisfied,
  validateCompletion,
} from '../src/domain/gates.mjs';
import {
  nextReady,
  orderReadyTasks,
  planPreemption,
  taskDeliveryState,
  taskPriority,
} from '../src/domain/scheduler.mjs';

const VERIFY = 'node -e "process.exit(0)"';

function setup({ patch } = {}) {
  const { config } = loadConfig('config/example.v06.json');
  config.scheduler.dynamicTeams = false;
  patch?.(config);
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  let clock = 1000;
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter,
    config,
    cwd: process.cwd(),
    now: () => clock,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  return { config, store, adapter, service, advance: (ms) => { clock += ms; } };
}

function implementationTask(id = 't1') {
  return {
    id,
    subject: id,
    kind: 'implementation',
    assigneeRole: 'engineer',
    objective: 'works',
    acceptance: ['works'],
    inScope: ['src/', 'test/'],
    verify: [VERIFY],
  };
}

function implEvidence(paths = ['src/a.js']) {
  return {
    status: 'completed',
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    changedPaths: paths,
  };
}

test('concurrent closed-loop steps on a team serialize until asynchronous work finishes', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('first'));
  service.addTask('alpha', implementationTask('second'));
  let active = 0;
  let peak = 0;
  const seen = [];
  service.applyClosedLoopUnlocked = async (_teamId, task) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    seen.push(task.id);
    active -= 1;
    return { created: [], escalated: 0 };
  };
  await Promise.all([service.applyClosedLoop('alpha', store.getTask('first')),
    service.applyClosedLoop('alpha', store.getTask('second'))]);
  assert.equal(peak, 1);
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(service.closedLoopLocks.size, 0);
  store.close();
});

test('new implementation roots own their unit and manual repairs are not legacy-unbound', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const root = service.addTask('alpha', { ...implementationTask('root-unit'), deliveryUnitId: 'other', deliverySeq: 99 });
  assert.equal(root.deliveryUnitId, root.id);
  assert.equal(root.deliverySeq, 0);
  store.updateTask(root.id, { status: 'completed' });
  const repair = service.addTask('alpha', {
    id: 'manual-repair', subject: 'repair', kind: 'repair', objective: 'repair root',
    acceptance: ['fixed'], inScope: ['src/'], verify: [VERIFY],
    sourceTaskId: root.id, dependencies: [root.id], legacyUnbound: true,
  });
  assert.notEqual(repair.legacyUnbound, true);
  store.close();
});

function finding(round, overrides = {}) {
  return {
    id: `f${round}`,
    severity: 'high',
    file: 'src/a.js',
    problem: `problem ${round}`,
    requiredFix: `fix src/a.js (round ${round}) and cover test/a.test.mjs`,
    ...overrides,
  };
}

function reviews(store, teamId = 'alpha') {
  return store.listTasks(teamId).filter((task) => task.kind === 'review');
}

function repairs(store, teamId = 'alpha') {
  return store.listTasks(teamId).filter((task) => task.kind === 'repair');
}

async function startImplementation(service, store, id = 't1') {
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask(id));
  await service.tick('alpha');
  const task = store.getTask(id);
  const done = await service.completeTask({
    teamId: 'alpha', taskId: id, attemptId: task.attemptId, update: implEvidence(),
  });
  assert.equal(done.ok, true, done.error);
  return store.getTask(id);
}

async function dispatchAndFailReview(service, store, reviewId, round) {
  await service.tick('alpha');
  const review = store.getTask(reviewId);
  assert.equal(review.status, 'in_progress', `${reviewId} should be dispatched`);
  assert.equal(review.round, round);
  const failed = await service.completeTask({
    teamId: 'alpha',
    taskId: reviewId,
    attemptId: review.attemptId,
    update: { status: 'failed', verdict: 'needs_revision', findings: [finding(round)] },
  });
  assert.equal(failed.ok, true, failed.error);
  return store.getTask(reviewId);
}

async function dispatchAndCompleteRepair(service, store, repairId, round) {
  await service.tick('alpha');
  const repair = store.getTask(repairId);
  assert.equal(repair.status, 'in_progress', `${repairId} should be dispatched`);
  const done = await service.completeTask({
    teamId: 'alpha',
    taskId: repairId,
    attemptId: repair.attemptId,
    update: {
      status: 'completed',
      acceptanceResults: [{ criterion: `fix src/a.js (round ${round}) and cover test/a.test.mjs`, status: 'passed' }],
      changedPaths: ['src/a.js', 'test/a.test.mjs'],
    },
  });
  assert.equal(done.ok, true, done.error);
  return store.getTask(repairId);
}

test('completed implementation creates exactly one deterministic review assigned outside the implementer', async () => {
  const { store, service } = setup();
  const impl = await startImplementation(service, store);
  const created = reviews(store);
  assert.equal(created.length, 1);
  const [review] = created;
  assert.equal(review.id, 'review-t1');
  assert.equal(review.reviewedTaskId, 't1');
  assert.deepEqual(review.dependencies, ['t1']);
  assert.equal(review.round, 1);
  assert.equal(review.assigneeRole, 'reviewer');
  assert.equal(review.closedLoop?.origin, 'closed-loop');
  assert.notEqual(review.assignee, impl.assignee);
  assert.notEqual(review.assigneeId, impl.assigneeId);

  await service.tick('alpha');
  const dispatched = store.getTask('review-t1');
  assert.equal(dispatched.status, 'in_progress');
  assert.equal(dispatched.assignee, 'Reviewer 01');
  assert.notEqual(dispatched.assignee, impl.assignee);

  // Repeated scans and ticks do not create a second review.
  await service.tick('alpha');
  await service.tick('alpha');
  assert.equal(reviews(store).length, 1);
});

test('structured negative review creates a repair and malformed result escalates', async () => {
  for (const malformed of [false, true]) {
    const { store, service } = setup();
    await startImplementation(service, store);
    await service.tick('alpha');
    const review = store.getTask('review-t1');
    const result = await service.completeTask({ teamId: 'alpha', taskId: review.id, attemptId: review.attemptId,
      update: { status: 'completed', reviewResult: malformed ? { verdict: 'pass' } : {
        verdict: 'needs_revision', evidence: 'found defect',
        findings: [{ severity: 'P1', file: 'src/a.js', line: 1, problem: 'bug', requiredFix: 'fix src/a.js' }],
      } } });
    assert.equal(result.ok, true, result.error);
    const closed = store.getTask(review.id);
    assert.equal(closed.status, 'failed');
    assert.equal(closed.reviewResultValid, !malformed);
    assert.equal(repairs(store).length, malformed ? 0 : 1);
    if (malformed) {
      assert.equal(closed.disposition, 'contract_error');
      assert.equal(closed.needsCaptain, true);
    }
    store.close();
  }
});

test('complete -> review -> needs_revision -> repair -> review -> pass closes the chain', async () => {
  const { store, service } = setup();
  await startImplementation(service, store);

  await dispatchAndFailReview(service, store, 'review-t1', 1);
  const createdRepairs = repairs(store);
  assert.equal(createdRepairs.length, 1);
  const [repair] = createdRepairs;
  assert.equal(repair.id, 'repair-review-t1');
  assert.equal(repair.sourceTaskId, 't1');
  assert.deepEqual(repair.findingSourceTaskIds, ['review-t1']);
  assert.deepEqual([...repair.inScope].sort(), ['src/a.js', 'test/a.test.mjs'].sort());
  assert.match(repair.objective, /problem 1/);
  assert.match(repair.objective, /fix src\/a\.js \(round 1\)/);
  assert.equal(repair.assigneeRole, 'engineer');
  assert.equal(repair.assignee, store.getTask('t1').assignee);

  await dispatchAndCompleteRepair(service, store, repair.id, 1);
  const reReview = store.getTask('review-repair-review-t1');
  assert.ok(reReview, 'repair completion creates the re-review');
  assert.equal(reReview.reviewedTaskId, 'repair-review-t1');
  assert.equal(reReview.round, 2);
  assert.deepEqual(reReview.dependencies, ['repair-review-t1']);

  await service.tick('alpha');
  const dispatchedReReview = store.getTask('review-repair-review-t1');
  assert.equal(dispatchedReReview.status, 'in_progress');
  const passed = await service.completeTask({
    teamId: 'alpha',
    taskId: dispatchedReReview.id,
    attemptId: dispatchedReReview.attemptId,
    update: { status: 'completed', verdict: 'pass', findings: [], scores: { overall: 4.6, code: 4.1 } },
  });
  assert.equal(passed.ok, true, passed.error);
  assert.equal(reviews(store).length, 2);
  assert.equal(repairs(store).length, 1);
  const afterPass = store.listTasks('alpha').length;
  await service.tick('alpha');
  assert.equal(store.listTasks('alpha').length, afterPass, 'a pass terminates the chain');
  assert.equal(store.getTask('review-repair-review-t1').verdict, 'pass');
  assert.equal(store.listEvents('alpha').some((event) => event.type === 'loop.passed'), true);
});

test('a restart and a crash window keep exactly one review and one repair', async () => {
  const { config, store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  // Crash window: the task is already completed but the review row was never
  // written (the daemon died between close and loop step).
  store.addTask({
    id: 'impl1',
    teamId: 'alpha',
    subject: 'impl1',
    kind: 'implementation',
    status: 'completed',
    assignee: 'Engineer 01',
    assigneeRole: 'engineer',
    dependencies: [],
    objective: 'x',
    acceptance: ['works'],
    inScope: ['src/', 'test/'],
    verify: [VERIFY],
    changedPaths: ['src/a.js'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: VERIFY, status: 'passed' }],
  });
  await service.tick('alpha');
  assert.equal(reviews(store).length, 1);

  const restarted = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter: new FakeSessionAdapter(),
    config,
    cwd: process.cwd(),
    now: () => 5000,
  });
  const recovered = await restarted.reconcileAfterRestart();
  assert.ok(Array.isArray(recovered.loops));
  await restarted.tick('alpha');
  await restarted.tick('alpha');
  assert.equal(reviews(store).length, 1, 'restart does not duplicate the review');

  // The interrupted review remains held; simulate a separately established
  // persisted negative verdict to test repair reconciliation without replay.
  const review = store.getTask('review-impl1');
  assert.equal(review.status, 'pending');
  assert.equal(review.hold.class, 'restart_session_unknown');
  store.updateTask(review.id, { status: 'failed', hold: undefined, verdict: 'needs_revision', findings: [finding(1)] });
  await restarted.reconcileClosedLoop('alpha');
  assert.equal(repairs(store).length, 1);

  const second = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter: new FakeSessionAdapter(),
    config,
    cwd: process.cwd(),
    now: () => 9000,
  });
  await second.reconcileAfterRestart();
  await second.tick('alpha');
  await second.tick('alpha');
  assert.equal(repairs(store).length, 1, 'restart does not duplicate the repair');
  assert.equal(reviews(store).length, 1, 'a failed review is not re-created as a new review');
});

test('three failed rounds stop automatic repair and report to the captain once', async () => {
  const { store, service } = setup();
  await startImplementation(service, store);

  let reviewId = 'review-t1';
  for (let round = 1; round <= 3; round += 1) {
    await dispatchAndFailReview(service, store, reviewId, round);
    if (round < 3) {
      assert.equal(repairs(store).length, round);
      const repair = repairs(store).find((task) => task.round === round);
      assert.ok(repair, `round ${round} repair exists`);
      await dispatchAndCompleteRepair(service, store, repair.id, round);
      reviewId = closedLoopReviewTaskId(repair.id);
      assert.equal(store.getTask(reviewId).round, round + 1);
    }
  }

  assert.equal(reviews(store).length, 3);
  assert.equal(repairs(store).length, 2, 'the third failed round creates no repair');
  const lastReview = store.getTask(reviewId);
  assert.equal(lastReview.status, 'failed');
  assert.equal(lastReview.closedLoop?.state, 'escalated');
  assert.equal(lastReview.needsCaptain, true);
  assert.equal(store.getTeam('alpha').needsCaptain, true);
  assert.match(lastReview.closedLoop.reason, /ceiling/);

  const messages = store.listMessages('alpha').filter((message) => message.to === 'captain' && message.from === 'closed-loop');
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, new RegExp(`taskId: ${reviewId}`));
  assert.match(messages[0].content, /round: 3/);
  assert.match(messages[0].content, /problem 3/);
  assert.match(messages[0].content, /sessionId: /);
  assert.match(messages[0].content, /findings \(1\)/);

  await service.tick('alpha');
  await service.tick('alpha');
  assert.equal(repairs(store).length, 2, 'repeated ticks do not restart the loop');
  assert.equal(
    store.listMessages('alpha').filter((message) => message.from === 'closed-loop').length,
    1,
    'the captain is reported once',
  );
});

test('an auto review never goes to the implementer', async () => {
  const completed = {
    id: 'impl',
    teamId: 'alpha',
    kind: 'implementation',
    status: 'completed',
    assignee: 'e1',
    assigneeId: 'm1',
    subject: 'impl',
    acceptance: ['works'],
    inScope: ['src/'],
    verify: [VERIFY],
  };
  const engineer = {
    id: 'm1',
    name: 'e1',
    role: 'engineer',
    status: 'idle',
    license: { roleKey: 'engineer', allowedTaskKinds: ['work', 'implementation', 'repair'] },
  };
  const onlyImplementer = planCompletionReview({
    task: completed, tasks: [completed], members: [engineer], policy: {},
  });
  assert.equal(onlyImplementer.action, 'create');
  assert.equal(onlyImplementer.task.assignee, undefined);

  // Even after the implementer is relicensed as a reviewer, the planner will
  // not hand them the review of their own work.
  const relicensed = {
    ...engineer,
    role: 'reviewer',
    license: { roleKey: 'reviewer', allowedTaskKinds: ['review'] },
  };
  const selfPlan = planCompletionReview({
    task: completed, tasks: [completed], members: [relicensed], policy: {},
  });
  assert.equal(selfPlan.task.assignee, undefined);

  const { store, service } = setup();
  await startImplementation(service, store);
  await service.tick('alpha');
  const review = store.getTask('review-t1');
  const impl = store.getTask('t1');
  assert.notEqual(review.assignee, impl.assignee);
  assert.notEqual(review.assigneeId, impl.assigneeId);
});

test('manual reviews and manual repairs are not duplicated by the loop', async () => {
  const first = setup();
  first.service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  first.service.addTask('alpha', implementationTask('t1'));
  first.service.addTask('alpha', {
    id: 'manual-review',
    subject: 'manual review',
    kind: 'review',
    assigneeRole: 'reviewer',
    objective: 'review',
    acceptance: ['quality'],
    reviewedTaskId: 't1',
    dependencies: ['t1'],
  }, { internal: true });
  await first.service.tick('alpha');
  const impl = first.store.getTask('t1');
  const done = await first.service.completeTask({
    teamId: 'alpha', taskId: 't1', attemptId: impl.attemptId, update: implEvidence(),
  });
  assert.equal(done.ok, true, done.error);
  assert.deepEqual(reviews(first.store).map((task) => task.id), ['manual-review']);

  // A manual repair opened before the review fails is linked, not duplicated.
  const second = setup();
  await startImplementation(second.service, second.store);
  second.service.addTask('alpha', {
    id: 'manual-repair',
    subject: 'manual repair',
    kind: 'repair',
    assigneeRole: 'engineer',
    objective: 'fix by hand',
    acceptance: ['fixed'],
    inScope: ['src/a.js'],
    verify: [VERIFY],
    sourceTaskId: 't1',
    dependencies: ['t1'],
  }, { internal: true });
  await dispatchAndFailReview(second.service, second.store, 'review-t1', 1);
  assert.equal(repairs(second.store).length, 1);
  assert.equal(repairs(second.store)[0].id, 'manual-repair');
  assert.equal(second.store.getTask('review-t1').closedLoop?.state, 'manual-repair');
  await second.service.tick('alpha');
  assert.equal(repairs(second.store).length, 1);
});

test('a failed implementation is left to the retry/red-review layer', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const impl = store.getTask('t1');
  const failed = await service.completeTask({
    teamId: 'alpha', taskId: 't1', attemptId: impl.attemptId, update: { status: 'failed', output: 'boom' },
  });
  assert.equal(failed.ok, true, failed.error);
  await service.tick('alpha');
  assert.equal(reviews(store).length, 0);
  assert.equal(repairs(store).length, 0);
});

test('a review pass below the score bar is rejected before it closes the chain', () => {
  const reviewed = { id: 'impl', status: 'completed', assignee: 'e1', kind: 'implementation' };
  const review = {
    id: 'review-impl', kind: 'review', status: 'in_progress', assignee: 'r1',
    reviewedTaskId: 'impl', acceptance: ['quality'], round: 1,
  };
  const low = validateCompletion(review, {
    status: 'completed', verdict: 'pass', scores: { overall: 4.4, code: 4.6 },
  }, reviewed);
  assert.equal(low.ok, false);
  assert.match(low.error, /4\.5/);
  const lowCode = validateCompletion(review, {
    status: 'completed', verdict: 'pass', scores: { overall: 4.6, code: 3.9 },
  }, reviewed);
  assert.equal(lowCode.ok, false);
  const atBar = validateCompletion(review, {
    status: 'completed', verdict: 'pass', scores: { overall: 4.5, code: 4.0 },
  }, reviewed);
  assert.equal(atBar.ok, true, atBar.error);
  const noScores = validateCompletion(review, { status: 'completed', verdict: 'pass' }, reviewed);
  assert.equal(noScores.ok, true, 'scores stay optional for legacy reviews');
  assert.equal(reviewScoresSatisfied({ overall: 'high', code: 4.1 }), false);
});

test('evidence recovery checks every allowed and excluded path pattern', () => {
  const task = {
    kind: 'implementation', status: 'in_progress', acceptance: ['works'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    changedPaths: ['src/a.mjs', 'test/a.test.mjs'],
    inScope: ['src/', 'test/'], outOfScope: ['src/private/'],
  };
  assert.equal(evidenceBackedCompletion(task).ok, true);
  assert.equal(evidenceBackedCompletion({ ...task, inScope: [] }).ok, false);
  assert.equal(evidenceBackedCompletion({ ...task, inScope: undefined }).ok, false);
  assert.equal(evidenceBackedCompletion({ ...task, changedPaths: ['src/private/a.mjs'] }).ok, false);
  assert.equal(evidenceBackedCompletion({ ...task, changedPaths: ['src/a.mjs', '../escape'] }).ok, false);
  assert.equal(evidenceBackedCompletion({ ...task, changedPaths: ['.env'] }).ok, false);
});

test('closed-loop ids are deterministic and stay inside the task-id limit', () => {
  assert.equal(closedLoopReviewTaskId('t1'), 'review-t1');
  assert.equal(closedLoopRepairTaskId('review-t1'), 'repair-review-t1');
  const long = closedLoopReviewTaskId(`t${'x'.repeat(300)}`);
  assert.ok(long.length <= 128);
  assert.match(long, /^review-tx/);
  assert.equal(long, closedLoopReviewTaskId(`t${'x'.repeat(300)}`));
});

test('planner escalation reasons are explicit for reject and empty findings', () => {
  const source = {
    id: 'impl', teamId: 'alpha', kind: 'implementation', status: 'completed',
    assignee: 'e1', acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY],
  };
  const baseReview = {
    id: 'review-impl', teamId: 'alpha', kind: 'review', status: 'failed',
    assignee: 'r1', reviewedTaskId: 'impl', round: 1,
  };
  const reject = planFailedReviewFollowUp({
    task: { ...baseReview, verdict: 'reject', findings: [finding(1)] },
    tasks: [source, baseReview],
    policy: {},
  });
  assert.equal(reject.action, 'escalate');
  assert.match(reject.reason, /reject/);
  const empty = planFailedReviewFollowUp({
    task: { ...baseReview, verdict: 'needs_revision', findings: [] },
    tasks: [source, baseReview],
    policy: {},
  });
  assert.equal(empty.action, 'escalate');
  assert.match(empty.reason, /finding/);
  const excluded = planFailedReviewFollowUp({
    task: { ...baseReview, verdict: 'needs_revision', findings: [finding(1, { file: '.env', requiredFix: 'edit .env' })] },
    tasks: [source, baseReview],
    policy: {},
  });
  assert.equal(excluded.action, 'escalate');
  assert.match(excluded.reason, /file path/);
});

test('reject escalates even with a prior repair and an unfinished source never unlocks repair', () => {
  const source = {
    id: 'impl', teamId: 'alpha', kind: 'implementation', status: 'completed',
    acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY],
  };
  const review = {
    id: 'review-impl', teamId: 'alpha', kind: 'review', status: 'failed',
    verdict: 'reject', reviewedTaskId: source.id, findings: [finding(1)],
  };
  const prior = { id: closedLoopRepairTaskId(review.id), kind: 'repair', status: 'completed' };
  assert.equal(planFailedReviewFollowUp({ task: review, tasks: [source, review, prior] }).action, 'escalate');
  const revised = { ...review, verdict: 'needs_revision' };
  const cancelled = { ...prior, status: 'cancelled' };
  const cancelledPlan = planFailedReviewFollowUp({ task: revised, tasks: [source, revised, cancelled] });
  assert.equal(cancelledPlan.action, 'escalate');
  assert.match(cancelledPlan.reason, /cancelled/);
  const failedRepair = { ...prior, status: 'failed' };
  assert.equal(planFailedReviewFollowUp({ task: revised, tasks: [source, revised, failedRepair] }).action, 'escalate');
  const unfinished = { ...source, status: 'failed' };
  const result = planFailedReviewFollowUp({ task: revised, tasks: [unfinished, revised] });
  assert.equal(result.action, 'escalate');
  assert.match(result.reason, /not completed/);
  const activeRepair = { ...prior, status: 'pending' };
  const existingWithFailedSource = planFailedReviewFollowUp({ task: revised, tasks: [unfinished, revised, activeRepair] });
  assert.equal(existingWithFailedSource.action, 'escalate');
  assert.equal(planFailedReviewFollowUp({ task: revised, tasks: [{ ...source, teamId: 'beta' }, revised] }).action, 'escalate');
});

test('completed legacy negative review plans a runnable repair; unknown verdict escalates', () => {
  const source = {
    id: 'legacy-source', teamId: 'alpha', kind: 'implementation', status: 'completed',
    acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY],
  };
  const review = {
    id: 'legacy-review', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'needs_revision', reviewedTaskId: source.id, findings: [finding(1)],
  };
  const plan = planFailedReviewFollowUp({ task: review, tasks: [source, review] });
  assert.equal(plan.action, 'repair');
  assert.deepEqual(plan.task.dependencies, [source.id]);
  assert.deepEqual(plan.task.findingSourceTaskIds, [review.id]);
  assert.equal(nextReady([source, review, plan.task]).some((task) => task.id === plan.task.id), true);
  const unknown = { ...review, status: 'failed', verdict: undefined };
  assert.equal(planFailedReviewFollowUp({ task: unknown, tasks: [source, unknown] }).action, 'escalate');
});

test('automatic repair cannot expand or override the source authorization', () => {
  const source = {
    id: 'scoped-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    acceptance: ['works'], inScope: ['src/'], outOfScope: ['src/private/'], verify: [VERIFY],
  };
  const review = {
    id: 'scoped-review', teamId: 'alpha', kind: 'review', status: 'failed',
    verdict: 'needs_revision', reviewedTaskId: source.id,
  };
  for (const path of ['test/fix.test.mjs', 'src/private/key.js']) {
    const attempt = { ...review, findings: [finding(1, { file: path, requiredFix: `fix ${path}` })] };
    const plan = planFailedReviewFollowUp({ task: attempt, tasks: [source, attempt] });
    assert.equal(plan.action, 'escalate');
    assert.match(plan.reason, /authorized scope/);
  }
  const allowed = { ...review, findings: [finding(1, { requiredFix: 'fix src/a.js' })] };
  const plan = planFailedReviewFollowUp({ task: allowed, tasks: [source, allowed] });
  assert.equal(plan.action, 'repair');
  assert.deepEqual(plan.task.outOfScope, source.outOfScope);
});

test('bound repair depends on unit root and sequences include review bindings', () => {
  const root = {
    id: 'root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    deliveryUnitId: 'root', deliverySeq: 0, taskEpoch: 2, sourceCommit: 'root-commit',
    acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY],
  };
  const previousRepair = {
    id: 'previous', teamId: 'alpha', kind: 'repair', status: 'completed',
    sourceTaskId: root.id, deliveryUnitId: root.id, deliverySeq: 3,
    deliveryGeneration: 2, sourceCommit: 'repair-commit',
  };
  const review = {
    id: 'current-review', teamId: 'alpha', kind: 'review', status: 'failed',
    reviewMode: 'bound', reviewedTaskId: previousRepair.id, verdict: 'needs_revision',
    binding: { sourceTaskId: previousRepair.id, deliveryUnitId: root.id, deliverySeq: 3, sourceCommit: previousRepair.sourceCommit },
    deliveryGeneration: 2, unitReviewSeq: 2, findings: [finding(1)],
  };
  const archived = {
    id: 'old-review', teamId: 'alpha', kind: 'review', status: 'failed', archived: true,
    reviewedTaskId: root.id, binding: { deliveryUnitId: root.id, deliverySeq: 9, sourceCommit: root.sourceCommit },
    deliveryGeneration: 2, unitReviewSeq: 1,
  };
  const tasks = [root, previousRepair, archived, review];
  const plan = planFailedReviewFollowUp({ task: review, tasks });
  assert.equal(plan.action, 'repair');
  assert.deepEqual(plan.task.dependencies, [root.id]);
  assert.equal(plan.task.sourceTaskId, root.id);
  assert.equal(plan.task.parentReviewTaskId, review.id);
  assert.equal(plan.task.deliverySeq, 10);
  assert.equal(plan.task.mode, 'bound');
  assert.equal(plan.task.sourceBase, previousRepair.sourceCommit);
  assert.ok(plan.task.acceptance.includes('works'));
  assert.equal(nextReady([...tasks, plan.task]).some((task) => task.id === plan.task.id), true);
  assert.equal(nextReady([root, previousRepair, archived, { ...review, archived: true }, plan.task])
    .some((task) => task.id === plan.task.id), false);
  assert.equal(nextReady([root, { ...previousRepair, sourceCommit: 'changed' }, archived, review, plan.task])
    .some((task) => task.id === plan.task.id), false);
  const invalid = { ...review, binding: { ...review.binding, sourceCommit: 'wrong' } };
  assert.equal(planFailedReviewFollowUp({ task: invalid, tasks: [root, previousRepair, archived, invalid] }).action, 'escalate');
});

test('bound review planning freezes the artifact and advances beyond archived epochs', () => {
  const source = { id: 'bound-source', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'bound', deliveryUnitId: 'bound-source', deliverySeq: 0, taskEpoch: 2,
    sourceBase: 'base', sourceCommit: 'commit', diffHash: 'digest', acceptance: ['works'] };
  const archived = { id: 'old', kind: 'review', reviewedTaskId: source.id, archived: true,
    reviewEpoch: 7, unitReviewSeq: 9, binding: { deliveryUnitId: source.id, sourceCommit: 'commit' } };
  const result = planCompletionReview({ task: source, tasks: [source, archived] });
  assert.equal(result.action, 'create');
  assert.equal(result.task.reviewEpoch, 8);
  assert.equal(result.task.unitReviewSeq, 10);
  assert.equal(result.task.binding.sourceCommit, source.sourceCommit);
  assert.equal(result.task.binding.diffHash, source.diffHash);
  assert.equal(nextReady([source, archived, result.task]).some((item) => item.id === result.task.id), true);
  assert.equal(nextReady([source, archived, { ...result.task, teamId: 'other' }]).some((item) => item.id === result.task.id), false);
  assert.equal(nextReady([source, archived, { ...result.task, binding: { ...result.task.binding, sourceTaskId: 'other' } }])
    .some((item) => item.id === result.task.id), false);
  assert.equal(planCompletionReview({ task: { ...source, diffHash: undefined }, tasks: [] }).needsCaptain, true);
});

test('legacy review planning creates a new epoch after an archived review', () => {
  const source = { id: 'legacy-source-epoch', teamId: 'alpha', kind: 'implementation', status: 'completed',
    sourceCommit: 'commit', legacyReviewEpoch: 2, acceptance: ['works'] };
  const archived = { id: 'old-legacy', kind: 'review', reviewedTaskId: source.id,
    archived: true, reviewEpoch: 7, legacyReviewEpoch: 3 };
  const result = planCompletionReview({ task: source, tasks: [source, archived] });
  assert.equal(result.action, 'create');
  assert.equal(result.task.legacyReviewEpoch, 8);
  assert.equal(result.task.reviewedSourceCommit, source.sourceCommit);
  assert.notEqual(result.task.id, archived.id);
  const stale = { ...archived, archived: false, status: 'pending', reviewedSourceCommit: 'old' };
  // V15 §11.10.1: an active review of the old commit is superseded, not left
  // for a human. applyClosedLoop closes its attempt and replans.
  const stalePlan = planCompletionReview({ task: source, tasks: [source, stale] });
  assert.equal(stalePlan.action, 'supersede_legacy_reviews');
  assert.deepEqual(stalePlan.staleReviewIds, [stale.id]);
});

test('legacy review selection prefers the current pass over an older failed row regardless of order', () => {
  const source = { id: 'legacy-current', teamId: 'alpha', kind: 'implementation', status: 'completed',
    sourceCommit: 'new-commit', legacyReviewEpoch: 2, acceptance: ['works'] };
  const oldFail = { id: 'a-old-failed', kind: 'review', reviewedTaskId: source.id, status: 'completed',
    verdict: 'needs_revision', reviewedSourceCommit: 'old-commit', legacyReviewEpoch: 1 };
  const newPass = { id: 'z-new-pass', kind: 'review', reviewedTaskId: source.id, status: 'completed',
    verdict: 'pass', reviewedSourceCommit: 'new-commit', legacyReviewEpoch: 2 };
  // The failed row sorts first lexicographically; the plan must still choose
  // the current passing review and not escalate.
  const plan = planCompletionReview({ task: source, tasks: [source, oldFail, newPass] });
  assert.equal(plan.action, 'none');
  assert.equal(plan.reason, 'review-exists');
  assert.equal(plan.existingTaskId, newPass.id);
  assert.notEqual(plan.needsCaptain, true);
});

test('reconciliation persists bound repair metadata and makes the repair ready', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const root = {
    id: 'bound-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    subject: 'root', objective: 'works', dependencies: [], acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY],
    deliveryUnitId: 'bound-root', deliverySeq: 0, taskEpoch: 1, sourceCommit: 'commit-a',
  };
  const review = {
    id: 'bound-review', teamId: 'alpha', kind: 'review', status: 'failed', subject: 'review',
    objective: 'review', acceptance: ['reviewed'], reviewedTaskId: root.id, dependencies: [root.id],
    reviewMode: 'bound', verdict: 'needs_revision', findings: [finding(1)],
    binding: { sourceTaskId: root.id, deliveryUnitId: root.id, deliverySeq: 0, sourceCommit: root.sourceCommit },
    deliveryGeneration: 1, unitReviewSeq: 1,
  };
  store.addTask(root);
  store.addTask(review);
  await service.reconcileClosedLoop('alpha');
  await service.reconcileClosedLoop('alpha');
  const tasks = store.listTasks('alpha');
  const repairs = tasks.filter((task) => task.kind === 'repair');
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].deliveryUnitId, root.id);
  assert.equal(repairs[0].deliveryGeneration, 1);
  assert.equal(repairs[0].deliverySeq, 1);
  assert.equal(repairs[0].parentReviewTaskId, review.id);
  assert.equal(repairs[0].sourceBase, root.sourceCommit);
  assert.equal(repairs[0].mode, 'bound');
  assert.deepEqual(repairs[0].dependencies, [root.id]);
  assert.equal(nextReady(tasks).some((task) => task.id === repairs[0].id), true);
  store.close();
});

test('bound repair without worktree isolation is held and escalated instead of dispatched', async () => {
  const { store, service, adapter } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01', role: 'engineer' }] });
  const root = { id: 'bound-no-tree', teamId: 'alpha', kind: 'implementation', status: 'completed',
    subject: 'root', objective: 'works', dependencies: [],
    assignee: 'Engineer 01', deliveryUnitId: 'bound-no-tree', deliverySeq: 0, taskEpoch: 0,
    sourceCommit: 'source', acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY] };
  const review = { id: 'bound-no-tree-review', teamId: 'alpha', kind: 'review', status: 'failed',
    subject: 'review', objective: 'review', acceptance: ['reviewed'], dependencies: [root.id],
    reviewMode: 'bound', verdict: 'needs_revision', reviewedTaskId: root.id, findings: [finding(1)],
    binding: { sourceTaskId: root.id, deliveryUnitId: root.id, deliverySeq: 0, sourceCommit: root.sourceCommit },
    deliveryGeneration: 0, unitReviewSeq: 1 };
  store.addTask(root);
  store.addTask(review);
  await service.reconcileClosedLoop('alpha');
  const repair = store.listTasks('alpha').find((item) => item.kind === 'repair');
  assert.ok(repair);
  await service.tick('alpha');
  assert.equal(store.getTask(repair.id).hold?.class, 'bound_task_requires_worktree');
  assert.equal(store.getTask(repair.id).needsCaptain, true);
  assert.equal(store.getTeam('alpha').needsCaptain, true);
  assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, 0);
  await service.tick('alpha');
  assert.equal(store.getTask(repair.id).status, 'pending');
  store.close();
});

test('reconciliation recovers a completed legacy negative review without duplicate repair', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const source = {
    id: 'legacy-source', teamId: 'alpha', kind: 'implementation', status: 'completed',
    subject: 'legacy source', objective: 'works', dependencies: [], acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY],
  };
  const review = {
    id: 'legacy-review', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'needs_revision', reviewedTaskId: source.id, dependencies: [source.id], objective: 'review', acceptance: ['reviewed'],
    findings: [finding(1)], round: 1,
  };
  store.addTask(source);
  store.addTask(review);
  await service.reconcileClosedLoop('alpha');
  await service.reconcileClosedLoop('alpha');
  const tasks = store.listTasks('alpha');
  const repairs = tasks.filter((task) => task.kind === 'repair');
  assert.equal(repairs.length, 1);
  assert.deepEqual(repairs[0].dependencies, [source.id]);
  assert.equal(nextReady(tasks).some((task) => task.id === repairs[0].id), true);
  store.close();
});

test('failed historical and unbound reviews never create repairs or escalate', () => {
  const source = {
    id: 'impl', teamId: 'alpha', kind: 'implementation', status: 'completed',
    assignee: 'e1', acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY],
  };
  const baseReview = {
    id: 'review-impl', teamId: 'alpha', kind: 'review', status: 'failed',
    verdict: 'needs_revision', assignee: 'r1', reviewedTaskId: 'impl', round: 1,
    findings: [finding(1)],
  };
  const archivedVariants = [
    { archived: true },
    { historical: true },
    { superseded: true },
    { cancelReason: 'superseded' },
    { legacyUnbound: true },
    { historyState: 'archived' },
    { historyState: 'historical' },
    { historyState: 'superseded' },
  ];

  for (const marker of archivedVariants) {
    const review = { ...baseReview, ...marker };
    const plan = planFailedReviewFollowUp({ task: review, tasks: [source, review], policy: {} });
    assert.equal(plan.action, 'none', `marker ${Object.keys(marker).join(',')} must stop the loop`);
    assert.equal(plan.task, undefined, 'a historical review must not produce a repair task');
    assert.equal(plan.escalated, undefined, 'a historical review must not escalate');
    const legacy = planFollowUp(review, [source, review], {});
    assert.deepEqual(legacy.created, []);
    assert.equal(legacy.reason, 'review-is-historical-or-unbound');
  }

  const activePlan = planFailedReviewFollowUp({
    task: baseReview, tasks: [source, baseReview], policy: {},
  });
  assert.equal(activePlan.action, 'repair', 'an active failed review remains eligible for repair');
  assert.equal(activePlan.task.id, 'repair-review-impl');
});

test('historical completed work never fans out a new review or repair', () => {
  const completed = {
    id: 'old', teamId: 'alpha', kind: 'implementation', status: 'completed',
    acceptance: ['works'], inScope: ['src/'], verify: [VERIFY],
    findings: [finding(1)], requiresVerification: true,
  };
  for (const marker of [
    { archived: true }, { historical: true }, { superseded: true },
    { historyState: 'archived' }, { legacyUnbound: true }, { legacyRepair: true },
  ]) {
    const task = { ...completed, ...marker };
    assert.equal(planCompletionReview({ task, tasks: [task] }).action, 'none');
    assert.deepEqual(planCompletionFanOut({ task, tasks: [task] }).created, []);
  }
});

/* -------------------------------------------------------------------------- */
/* Fan-out, least-loaded dispatch, priority, delivery state, evidence recovery */
/* -------------------------------------------------------------------------- */

test('closed-loop reconciliation waits for each asynchronous step before reporting results', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  // service.addTask forces pending; seed the completed row directly.
  store.addTask({ ...implementationTask('done'), teamId: 'alpha', status: 'completed' });

  let release;
  let entered;
  const reachedStep = new Promise((resolve) => { entered = resolve; });
  const delay = new Promise((resolve) => { release = resolve; });
  const apply = service.applyClosedLoopUnlocked.bind(service);
  service.applyClosedLoopUnlocked = async (...args) => {
    entered();
    await delay;
    return apply(...args);
  };

  let settled = false;
  const reconciliation = service.reconcileClosedLoop('alpha').then((result) => {
    settled = true;
    return result;
  });
  await reachedStep;
  await Promise.resolve();
  assert.equal(settled, false, 'reconciliation must remain pending while a loop step is pending');
  assert.equal(store.getTask('review-done'), undefined, 'follow-ups are not created before the step resolves');

  release();
  const result = await reconciliation;
  assert.equal(result.created, 1);
  assert.equal(store.getTask('review-done')?.kind, 'review');
});

test('one completion fans out review, verification and a known repair that run in parallel', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const e1 = service.materializeMember('alpha', { role: 'engineer' });
  const e2 = service.materializeMember('alpha', { role: 'engineer' });
  const r1 = service.materializeMember('alpha', { role: 'reviewer' });
  const a1 = service.materializeMember('alpha', { role: 'analyst' });
  service.addTask('alpha', {
    ...implementationTask('t1'),
    requiresVerification: true,
    findings: [finding(1)],
  }, { internal: true });
  await service.tick('alpha');
  const impl = store.getTask('t1');
  assert.equal(impl.status, 'in_progress');
  assert.equal(impl.assignee, e1.name);

  const done = await service.completeTask({
    teamId: 'alpha', taskId: 't1', attemptId: impl.attemptId, update: implEvidence(),
  });
  assert.equal(done.ok, true, done.error);
  assert.equal(done.closedLoop.created.length, 3, 'one completion creates all three follow-ups');

  const followUps = store.listTasks('alpha')
    .filter((task) => task.id !== 't1' && (task.dependencies ?? []).includes('t1'));
  assert.deepEqual(followUps.map((task) => task.id).sort(), ['repair-known-t1', 'review-t1', 'verify-t1']);
  for (const task of followUps) {
    assert.deepEqual(task.dependencies, ['t1'], `${task.id} depends only on the completed task`);
    assert.equal(task.closedLoop?.origin, 'closed-loop');
  }
  const review = store.getTask('review-t1');
  const verify = store.getTask('verify-t1');
  const repair = store.getTask('repair-known-t1');
  assert.equal(review.assignee, r1.name);
  assert.equal(verify.assignee, a1.name);
  assert.equal(repair.assignee, e2.name);
  assert.notEqual(repair.assignee, impl.assignee, 'the known repair does not bounce back to the implementer');
  assert.equal(repair.closedLoop.role, 'known-repair');
  assert.equal(verify.closedLoop.role, 'verify');

  // A single tick dispatches all three in parallel on three different members.
  await service.tick('alpha');
  const live = ['review-t1', 'verify-t1', 'repair-known-t1'].map((id) => store.getTask(id));
  assert.deepEqual(live.map((task) => task.status), ['in_progress', 'in_progress', 'in_progress']);
  assert.equal(new Set(live.map((task) => task.assignee)).size, 3, 'different members run in parallel');

  // Repeated scans and ticks do not duplicate any of them.
  await service.tick('alpha');
  await service.tick('alpha');
  for (const id of ['review-t1', 'verify-t1', 'repair-known-t1']) {
    assert.equal(store.listTasks('alpha').filter((task) => task.id === id).length, 1);
  }
});

test('the fan-out planner is deterministic and honours manual rows', () => {
  const completed = {
    id: 'impl', teamId: 'alpha', kind: 'implementation', status: 'completed',
    assignee: 'e1', assigneeId: 'm1', acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY],
    requiresVerification: true, findings: [finding(1)],
  };
  const members = [
    { id: 'm2', name: 'e2', role: 'engineer', license: { roleKey: 'engineer', allowedTaskKinds: ['repair'] } },
    { id: 'r1', name: 'r1', role: 'reviewer', license: { roleKey: 'reviewer', allowedTaskKinds: ['review'] } },
    { id: 'a1', name: 'a1', role: 'analyst', license: { roleKey: 'analyst', allowedTaskKinds: ['verification'] } },
  ];
  const first = planCompletionFanOut({ task: completed, tasks: [completed], members, policy: {} });
  assert.equal(first.action, 'create');
  assert.deepEqual(first.created.map((task) => task.id).sort(), ['repair-known-impl', 'review-impl', 'verify-impl']);
  const second = planCompletionFanOut({
    task: completed, tasks: [completed, ...first.created], members, policy: {},
  });
  assert.equal(second.action, 'none');
  assert.deepEqual(second.created, [], 'existing rows are never re-created');

  // A manual review still allows the verification and known-repair rows.
  const manual = [{ id: 'manual-review', teamId: 'alpha', kind: 'review', reviewedTaskId: 'impl', status: 'pending', dependencies: ['impl'] }];
  const withManual = planCompletionFanOut({ task: completed, tasks: [completed, ...manual], members, policy: {} });
  assert.deepEqual(withManual.created.map((task) => task.id).sort(), ['repair-known-impl', 'verify-impl']);
});

test('known finding fan-out escalates out of scope paths and preserves exclusions', () => {
  const source = {
    id: 'known-source', teamId: 'alpha', kind: 'implementation', status: 'completed',
    acceptance: ['works'], inScope: ['src/'], outOfScope: ['src/private/'], verify: [VERIFY],
    findings: [finding(1, { file: undefined, path: 'test/outside.js', requiredFix: 'fix it' })],
  };
  const rejected = planCompletionFanOut({ task: source, tasks: [source] });
  assert.equal(rejected.action, 'escalate');
  assert.equal(rejected.needsCaptain, true);
  assert.deepEqual(rejected.created, []);
  const allowed = { ...source, findings: [finding(1, { file: undefined, path: 'src/a.js', requiredFix: 'fix it' })] };
  const plan = planCompletionFanOut({ task: allowed, tasks: [allowed] });
  const repair = plan.created.find((row) => row.kind === 'repair');
  assert.deepEqual(repair.inScope, ['src/a.js']);
  assert.deepEqual(repair.outOfScope, ['src/private/']);
});

test('a pending follow-up is 待交付 (queued) and never red', async () => {
  assert.equal(taskDeliveryState({ id: 'q', status: 'pending', dependencies: [] }, []), 'queued');
  assert.equal(taskDeliveryState(
    { id: 'q', status: 'pending', dependencies: ['p'] },
    [{ id: 'p', status: 'completed' }],
  ), 'queued');
  assert.equal(taskDeliveryState(
    { id: 'b', status: 'pending', dependencies: ['p'] },
    [{ id: 'p', status: 'in_progress' }],
  ), 'blocked');
  assert.equal(taskDeliveryState({ id: 'r', status: 'in_progress' }, []), 'running');
  assert.equal(taskDeliveryState({ id: 'f', status: 'failed' }, []), 'failed');
  assert.equal(taskDeliveryState({ id: 'd', status: 'completed' }, []), 'completed');

  const { store, service } = setup();
  await startImplementation(service, store);
  const review = store.getTask('review-t1');
  assert.equal(review.status, 'pending');
  assert.equal(taskDeliveryState(review, store.listTasks('alpha')), 'queued');
  await service.tick('alpha');
  assert.equal(taskDeliveryState(store.getTask('review-t1'), store.listTasks('alpha')), 'running');
});

test('restart holds evidenced work until the previous session termination is proven', async () => {
  const { config, store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const e1 = service.materializeMember('alpha', { role: 'engineer' });
  service.addTask('alpha', implementationTask('t1'));
  service.addTask('alpha', implementationTask('t2'));
  await service.tick('alpha');
  const t1 = store.getTask('t1');
  assert.equal(t1.status, 'in_progress');
  // The member recorded evidence, then the session went idle without a completion.
  store.updateTask('t1', {
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    changedPaths: ['src/a.js'],
    commandsRun: [{ command: VERIFY, status: 'passed' }],
  });
  store.updateMember(e1.id, { sessionId: undefined, status: 'idle' });

  assert.equal(evidenceBackedCompletion(store.getTask('t1')).ok, true);
  assert.equal(evidenceBackedCompletion(store.getTask('t2')).ok, false, 'no evidence means no recovery');

  const restarted = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter: new FakeSessionAdapter(),
    config,
    cwd: process.cwd(),
    now: () => 5000,
  });
  const recovered = await restarted.reconcileAfterRestart();
  assert.deepEqual(recovered.recovered, []);
  assert.equal(store.getTask('t1').status, 'pending');
  assert.equal(store.getTask('t1').hold.class, 'restart_session_unknown');
  assert.equal(store.getTask('review-t1'), undefined);
  assert.equal(store.listEvents('alpha').some((event) => event.type === 'loop.recovered'), false);
  assert.equal(recovered.tasks.includes('t2'), true);
  assert.equal(store.getTask('t2').status, 'pending');
  assert.equal(store.getTask('t2').hold.class, 'restart_session_unknown');
  assert.notEqual(store.getTask('t2').status, 'completed');

  // A repeated restart must not release either held task.
  await restarted.reconcileAfterRestart();
  await restarted.tick('alpha');
  await restarted.tick('alpha');
  assert.equal(reviews(store).filter((task) => task.reviewedTaskId === 't1').length, 0);
});

test('a busy or second-round implementer is replaced instead of queued', () => {
  const source = {
    id: 'impl', teamId: 'alpha', kind: 'implementation', status: 'completed',
    assignee: 'e1', assigneeId: 'm1', acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY],
    repairContinuity: true,
  };
  const members = [
    { id: 'm1', name: 'e1', role: 'engineer', workState: 'busy', license: { roleKey: 'engineer', allowedTaskKinds: ['implementation', 'repair'] } },
    { id: 'm2', name: 'e2', role: 'engineer', workState: 'available', license: { roleKey: 'engineer', allowedTaskKinds: ['implementation', 'repair'] } },
    { id: 'm3', name: 'e3', role: 'engineer', workState: 'available', license: { roleKey: 'engineer', allowedTaskKinds: ['implementation', 'repair'] } },
    { id: 'm4', name: 'r1', role: 'reviewer', workState: 'available', license: { roleKey: 'reviewer', allowedTaskKinds: ['review'] } },
  ];
  const review = {
    id: 'review-impl', teamId: 'alpha', kind: 'review', status: 'failed', verdict: 'needs_revision',
    reviewedTaskId: 'impl', round: 1, assignee: 'r1', findings: [finding(1)],
  };
  const busy = { id: 'open-on-e1', teamId: 'alpha', status: 'in_progress', assignee: 'e1', assigneeId: 'm1', dependencies: [] };
  const plan = planFailedReviewFollowUp({ task: review, tasks: [source, review, busy], members, policy: {} });
  assert.equal(plan.action, 'repair');
  assert.equal(plan.task.assignee, 'e2', 'a busy original implementer is not re-tasked');
  assert.equal(plan.task.assignee === 'e1', false);

  // Least-loaded: e2 already holds open work, so the free e3 wins.
  const busy2 = { id: 'open-on-e2', teamId: 'alpha', status: 'in_progress', assignee: 'e2', assigneeId: 'm2', dependencies: [] };
  const plainSource = { ...source, repairContinuity: false };
  const plainReview = { ...review, id: 'review-impl-plain' };
  const least = planFailedReviewFollowUp({
    task: plainReview, tasks: [plainSource, plainReview, busy2], members, policy: {},
  });
  assert.equal(least.task.assignee, 'e3');
  // When every engineer is busy the row stays unassigned so the pool can grow.
  const busy3 = { id: 'open-on-e3', teamId: 'alpha', status: 'in_progress', assignee: 'e3', assigneeId: 'm3', dependencies: [] };
  const allBusy = planFailedReviewFollowUp({
    task: plainReview, tasks: [plainSource, plainReview, busy, busy2, busy3], members, policy: {},
  });
  assert.equal(allBusy.task.assignee, undefined, 'no engineer is queued behind a busy one');

  // A second round switches away even when the original is free again.
  const secondRound = { ...review, id: 'review-round-2', round: 2 };
  const roundTwo = planFailedReviewFollowUp({
    task: secondRound,
    tasks: [source, secondRound],
    members: members.map((member) => ({ ...member, workState: 'available' })),
    policy: {},
  });
  assert.equal(roundTwo.task.assignee, 'e2', 'two failed rounds switch the engineer');
});

test('critical-chain work orders first and preempts the low-priority task holding the only member', async () => {
  const tasks = [
    { id: 'low-old', status: 'pending', dependencies: [], createdAt: 1, priority: 'low' },
    { id: 'retry-old', status: 'pending', dependencies: [], createdAt: 2, turnFailureCount: 2 },
    { id: 'normal-old', status: 'pending', dependencies: [], createdAt: 3 },
    { id: 'critical-new', status: 'pending', dependencies: [], createdAt: 10, priority: 'critical' },
    { id: 'chain-old', status: 'pending', dependencies: [], createdAt: 4 },
    { id: 'downstream', status: 'pending', dependencies: ['chain-old'] },
  ];
  const ordered = orderReadyTasks(tasks.filter((task) => task.id !== 'downstream'), tasks);
  assert.deepEqual(ordered.map((task) => task.id), [
    'critical-new', 'chain-old', 'normal-old', 'low-old', 'retry-old',
  ]);
  assert.equal(taskPriority({ priority: 'high' }), 'critical');
  assert.equal(taskPriority({}), 'normal');

  const members = [{
    id: 'm1', name: 'Engineer 01', role: 'engineer', workState: 'busy',
    license: { roleKey: 'engineer', allowedTaskKinds: ['work', 'implementation', 'repair'] },
  }];
  const preemption = planPreemption({
    tasks: [
      { id: 'low', status: 'in_progress', attemptId: 'a1', assignee: 'Engineer 01', assigneeId: 'm1', dependencies: [], priority: 'low' },
      { id: 'crit', status: 'pending', dependencies: [], priority: 'critical' },
    ],
    members,
    slots: 1,
  });
  assert.equal(preemption.length, 1);
  assert.equal(preemption[0].taskId, 'low');
  assert.equal(preemption[0].forTaskId, 'crit');
  // Even with free slots, the only eligible member cannot stay pinned to low work.
  const memberHeld = planPreemption({
    tasks: [
      { id: 'low', status: 'in_progress', attemptId: 'a1', assignee: 'Engineer 01', assigneeId: 'm1', dependencies: [], priority: 'low' },
      {
        id: 'crit', status: 'pending', dependencies: [], kind: 'implementation',
        assigneeRole: 'engineer', priority: 'critical',
      },
    ],
    members,
    slots: 4,
  });
  assert.equal(memberHeld.length, 1);
  assert.equal(memberHeld[0].taskId, 'low');
  assert.equal(memberHeld[0].reason, 'member-held-by-low-priority');

  const { store, service } = setup({
    patch: (config) => {
      config.scheduler.activeWorkerSlots = 1;
      config.scheduler.maxActivePerTeam = 1;
      config.scheduler.dynamicTeams = false;
    },
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const engineer = service.materializeMember('alpha', { role: 'engineer' });
  service.addTask('alpha', { ...implementationTask('low'), priority: 'low' });
  await service.tick('alpha');
  assert.equal(store.getTask('low').status, 'in_progress');

  service.addTask('alpha', { ...implementationTask('crit'), priority: 'critical' });
  const result = await service.tick('alpha');
  assert.ok(result.preempted >= 1);
  const paused = store.getTask('low');
  assert.equal(paused.status, 'pending', 'the low-priority task yields without failing');
  assert.equal(paused.preempted, true);
  assert.equal(paused.preemptedBy, 'crit');
  assert.equal(store.getTask('crit').status, 'in_progress', 'the critical task uses the freed member');
  assert.equal(store.getTask('crit').assignee, engineer.name);
  assert.equal(store.listEvents('alpha').some((event) => event.type === 'task.preempted'), true);
  assert.equal(store.listEvents('alpha').some((event) => event.type === 'task.stalled'), false);
});

test('follow-ups pick the least-loaded member of the pool', () => {
  const completed = {
    id: 'impl', teamId: 'alpha', kind: 'implementation', status: 'completed',
    assignee: 'e1', assigneeId: 'm1', acceptance: ['works'], inScope: ['src/'], verify: [VERIFY],
  };
  const members = [
    { id: 'r1', name: 'r1', role: 'reviewer', workState: 'available', license: { roleKey: 'reviewer', allowedTaskKinds: ['review'] } },
    { id: 'r2', name: 'r2', role: 'reviewer', workState: 'available', license: { roleKey: 'reviewer', allowedTaskKinds: ['review'] } },
  ];
  const busyReviewer = { id: 'open-r1', teamId: 'alpha', status: 'in_progress', assignee: 'r1', dependencies: [] };
  const plan = planCompletionReview({ task: completed, tasks: [completed, busyReviewer], members, policy: {} });
  assert.equal(plan.action, 'create');
  assert.equal(plan.task.assignee, 'r2', 'the busy reviewer is skipped');
  // With no free reviewer the review is left unassigned for the daemon pool.
  const bothBusy = { ...busyReviewer, id: 'open-r2', assignee: 'r2' };
  const full = planCompletionReview({ task: completed, tasks: [completed, busyReviewer, bothBusy], members, policy: {} });
  assert.equal(full.task.assignee, undefined, 'an unassigned row is queued, not failed');
});
