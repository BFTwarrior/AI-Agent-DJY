import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import {
  CONTINUE_MESSAGE,
  RED_REVIEW_KIND,
  redReviewKey,
  redReviewTaskId,
  nextReady,
  allocateSlots,
} from '../src/domain/scheduler.mjs';
import { createApp } from '../src/http/server.mjs';
import { listenForFetch } from './support/listen.mjs';

/**
 * Build a service whose turn-failure budget is 0 by default, so the very first
 * `onFailed` is a red box. The layering test switches the budget back to 3 to
 * prove a red box only appears after the turn retries are exhausted.
 */
function setup({ turnAttempts = 0, red, startClock = 1000 } = {}) {
  const { config } = loadConfig('config/example.v06.json');
  config.zcode.turnFailureRetry.maxAttempts = turnAttempts;
  if (red) Object.assign(config.zcode.redAutoReview, red);
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter({});
  let clock = startClock;
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter,
    config,
    cwd: process.cwd(),
    now: () => clock,
  });
  adapter.turnCursor = async () => 0;
  const watchers = [];
  adapter.watchTurn = (input) => {
    watchers.push(input);
    return { cancel() {} };
  };
  return {
    config,
    store,
    adapter,
    service,
    watchers,
    advance: (ms) => { clock += ms; },
    now: () => clock,
  };
}

function makeTeam(service, extraMembers = []) {
  service.createTeam({
    id: 'alpha',
    name: 'Alpha',
    phase: 'running',
    members: [{ name: 'impl', role: 'engineer' }, { name: 'reviewer', role: 'reviewer' }, ...extraMembers],
  });
  service.addTask('alpha', { id: 't1', subject: '报错任务', kind: 'work', assignee: 'impl' });
}

function reviews(store) {
  return store.listTasks('alpha').filter((task) => task.kind === RED_REVIEW_KIND);
}

function implementationTasks(store) {
  return store.listTasks('alpha').filter((task) => task.kind !== RED_REVIEW_KIND);
}

function continueSends(adapter) {
  // The literal word is still 继续; since repair-A-AUTO-RETRY F1 the prompt
  // also carries the new attempt id so the member can close the task.
  return adapter.calls.filter((call) => call.kind === 'send'
    && typeof call.input.message === 'string'
    && call.input.message.startsWith(CONTINUE_MESSAGE));
}

function failTurn(watchers, error = { message: 'read ECONNRESET', code: 'ECONNRESET' }) {
  watchers.at(-1).onFailed(error);
}

async function redBox(service, watchers, error) {
  failTurn(watchers, error);
  await service.awaitRedReviews();
  return service.store.getTask('t1');
}

test('a red task automatically creates one hidden review that only sends 继续', async () => {
  const { store, adapter, service, watchers } = setup();
  makeTeam(service);
  await service.tick('alpha');
  assert.equal(implementationTasks(store).length, 1);

  const failed = await redBox(service, watchers);
  assert.equal(failed.status, 'in_progress', 'the review continued the same task');
  assert.equal(failed.subject, '报错任务', 'the subject never changes');

  const rows = reviews(store);
  assert.equal(rows.length, 1, 'exactly one review task is created');
  const review = rows[0];
  assert.equal(review.subject, 'Automatic continue review');
  assert.equal(review.reviewedTaskId, 't1');
  assert.equal(review.hidden, true, 'the review stays out of the task tree');
  assert.equal(review.status, 'completed');
  assert.equal(review.outcome, 'continued');
  assert.equal(review.assignee, undefined, 'the review takes no member/worker slot');
  assert.equal(review.attemptId, undefined, 'the review never opens an attempt');

  // The review's only effect: one "继续" to the failed task's session.
  const sends = continueSends(adapter);
  assert.equal(sends.length, 1);
  assert.ok(sends[0].input.message.startsWith(CONTINUE_MESSAGE));
  assert.match(sends[0].input.message, /Attempt id: /);
  assert.equal(sends[0].input.sessionId, store.listMembers('alpha').find((member) => member.name === 'impl').sessionId);
  assert.equal(implementationTasks(store).length, 1, 'the review never creates an implementation task');
  assert.equal(failed.attempt, 2, 'continuing reuses the same task id and bumps the attempt');
  store.close();
});

test('the same failure event creates exactly one review, even across restarts and sweeps', async () => {
  const { store, adapter, service, watchers } = setup();
  makeTeam(service);
  await service.tick('alpha');
  await redBox(service, watchers);
  const task = store.getTask('t1');
  const key = redReviewKey(task);
  const id = redReviewTaskId(key);
  assert.equal(reviews(store).length, 1);
  assert.equal(reviews(store)[0].id, id);

  const sendsAfterFirst = continueSends(adapter).length;

  // The direct hook, the recovery sweep and a restarted service all resolve to
  // the same deterministic review id: no duplicate row, no duplicate continue.
  service.onTaskFailed('alpha', 't1');
  await service.awaitRedReviews();
  store.updateTask('t1', { status: 'failed' });
  service.sweepRedReviews('alpha');
  await service.awaitRedReviews();
  const restarted = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter, config: service.config, cwd: process.cwd(), now: () => 2000,
  });
  restarted.sweepRedReviews('alpha');
  await restarted.awaitRedReviews();

  assert.equal(reviews(store).length, 1, 'no duplicate review rows');
  assert.equal(continueSends(adapter).length, sendsAfterFirst, 'no duplicate continue');
  store.close();
});

test('after three automatic continues the review messages the captain and stops', async () => {
  const { store, adapter, service, watchers } = setup();
  makeTeam(service);
  await service.tick('alpha');

  for (let round = 1; round <= 3; round += 1) {
    const task = await redBox(service, watchers, { message: `read ECONNRESET round ${round}`, code: 'ECONNRESET' });
    assert.equal(task.status, 'in_progress', `round ${round} was continued`);
    assert.equal(task.redContinueCount, round);
    assert.equal(task.redReviewEscalated, false);
  }
  assert.equal(reviews(store).length, 3);
  const sendsBefore = continueSends(adapter).length;

  const failed = await redBox(service, watchers, { message: 'read ECONNRESET round 4', code: 'ECONNRESET' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.redReviewEscalated, true);
  assert.equal(failed.redContinueCount, 3, 'the automatic budget stays at three');
  assert.equal(continueSends(adapter).length, sendsBefore, 'no fourth automatic continue is sent');

  const last = reviews(store).at(-1);
  assert.equal(last.outcome, 'escalated');
  assert.equal(last.hidden, true);

  const captainMessages = store.listMessages('alpha').filter((message) => message.to === 'captain');
  assert.equal(captainMessages.length, 1, 'exactly one captain report');
  const text = captainMessages[0].content;
  assert.match(text, /t1/);
  assert.match(text, /\[自动继续审查上报\]/, 'the literal title stays for prompt/panel matching');
  assert.match(text, /automatic continues: 3/);
  assert.match(text, /sessionId: sess_fake_1/);
  assert.match(text, /round 4/);
  // The body reaches a captain model, so everything except the literal title
  // and user-supplied data (the task subject) must be English. The template
  // itself is covered by scheduler.test.mjs with ASCII-only input.
  assert.doesNotMatch(
    text.replace('[自动继续审查上报]', '').replace(/^- subject: .*$/mu, ''),
    /[\u3400-\u9fff]/u,
    'the escalation body must not contain Chinese prose',
  );

  // Further red boxes stay silent: no new review, no new message, no continue.
  const reviewCount = reviews(store).length;
  await redBox(service, watchers);
  assert.equal(reviews(store).length, reviewCount);
  assert.equal(store.listMessages('alpha').filter((message) => message.to === 'captain').length, 1);
  store.close();
});

test('a hidden legacy failure is never auto-reviewed', () => {
  const { store, service } = setup();
  makeTeam(service);
  service.addTask('alpha', {
    id: 'legacy', subject: '历史任务', kind: 'work', assignee: 'impl', hidden: true,
  });
  store.updateTask('legacy', { status: 'failed', hidden: true, closedAt: 1000 });

  assert.equal(service.onTaskFailed('alpha', 'legacy'), undefined);
  assert.equal(service.sweepRedReviews('alpha'), 0);
  assert.equal(reviews(store).length, 0, 'a restart sweep must not revive hidden history');
  store.close();
});

test('the layering is: turn retries first, red review only after the task is red', async () => {
  const wiring = setup({ turnAttempts: 3 });
  const { store, adapter, service, watchers, advance, now } = wiring;
  makeTeam(service);
  await service.tick('alpha');

  // Three retryable failures stay in the turn-retry layer: no review yet.
  for (let failure = 1; failure <= 3; failure += 1) {
    failTurn(watchers);
    const task = store.getTask('t1');
    assert.equal(task.status, 'in_progress');
    assert.equal(task.autoContinue, true);
    assert.equal(reviews(store).length, 0, 'no review while the turn retry budget lasts');
    advance(task.retryNotBefore - now());
    await service.tick('alpha');
    assert.equal(store.getTask('t1').autoContinue, false);
  }
  assert.equal(continueSends(adapter).length, 3, 'the turn layer sent three 继续');

  // The fourth failure exhausts the turn budget: the task turns red and the
  // review layer takes over with its own 继续.
  const red = await redBox(service, watchers);
  assert.equal(red.redContinueCount, 1);
  assert.equal(reviews(store).length, 1);
  assert.equal(reviews(store)[0].outcome, 'continued');
  assert.equal(continueSends(adapter).length, 4);
  store.close();
});

test('a contractor may run the automatic review, a plain member may not', async () => {
  const { store, adapter, service, watchers } = setup({ red: { enabled: false } });
  makeTeam(service);
  await service.tick('alpha');
  const failed = await redBox(service, watchers);
  assert.equal(failed.status, 'failed');
  assert.equal(reviews(store).length, 0, 'the automatic trigger is off for this test');

  const impl = store.listMembers('alpha').find((member) => member.name === 'impl');
  const engineerActor = { role: 'member', memberId: impl.id, teamId: 'alpha', name: impl.name };
  assert.equal(service.canContinueTask('alpha', engineerActor), false);
  await assert.rejects(
    () => service.continueTask('alpha', 't1', { actor: engineerActor, reason: 'sneak in' }),
    (error) => error.status === 403 && error.code === 'E_FORBIDDEN',
  );

  // A red-review contractor holds the purpose; a raw contractor row without a
  // purpose or the `task:continue` capability is refused.
  const contractor = store.addContractor({
    id: 'ctr_red_1', teamId: 'alpha', slot: 'main', purpose: 'red_auto_review',
    mode: 'read-only', prompt: 'send 继续 to the red task', status: 'queued', queuedAt: 1000, timeoutMs: 60000,
  });
  const other = store.addContractor({
    id: 'ctr_other', teamId: 'alpha', slot: 'main', purpose: 'task', mode: 'read-only',
    prompt: 'x', status: 'queued', queuedAt: 1000, timeoutMs: 60000,
  });
  const contractorActor = { role: 'contractor', contractorId: contractor.id, teamId: 'alpha', name: 'contractor:ctr_red_1' };
  assert.equal(service.canContinueTask('alpha', contractorActor), true);
  assert.equal(service.contractorCanRedReview(other), false, 'no purpose and no task:continue capability');
  assert.equal(service.contractorCanRedReview(contractor), true);
  store.updateContractor(other.id, { status: 'killed' });
  // A contractor spawned through the real entry point declares task:continue
  // (A-AUTO-RETRY), so it may continue a failed task in its own team.
  const spawned = store.addContractor({
    id: 'ctr_spawned', teamId: 'alpha', slot: 'main', purpose: 'task', mode: 'read-only',
    prompt: 'y', status: 'running', queuedAt: 1000, timeoutMs: 60000,
    capabilities: ['task:continue'],
  });
  assert.equal(
    service.canContinueTask('alpha', { role: 'contractor', contractorId: spawned.id, teamId: 'alpha' }),
    true,
    'a spawned contractor carries task:continue',
  );

  // The review row is created but not auto-run; a plain member cannot execute
  // it, a contractor can.
  service.redReview.enabled = true;
  const review = service.ensureRedReview('alpha', store.getTask('t1'), { autoRun: false });
  assert.equal(review.status, 'in_progress');

  const denied = await service.runRedReview('alpha', review.id, { actor: engineerActor, force: true });
  assert.equal(denied.outcome, 'denied');
  assert.equal(store.getTask('t1').status, 'failed');
  assert.equal(continueSends(adapter).length, 0, 'a plain member sends no continue');
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'red_review.denied'));

  // Reopen the same row and let the contractor run it.
  store.updateTask(review.id, { status: 'in_progress', outcome: undefined, closedAt: undefined });
  const done = await service.runRedReview('alpha', review.id, { contractorId: contractor.id, force: true });
  assert.equal(done.outcome, 'continued');
  assert.equal(continueSends(adapter).length, 1, 'the contractor sent exactly one 继续');
  assert.equal(store.getTask('t1').status, 'in_progress');
  assert.equal(store.getTask('t1').lastRedReviewBy, 'contractor:ctr_red_1');

  // The contractor slot runs the review without a model session.
  store.updateContractor(contractor.id, { status: 'killed' });
  store.updateContractor(spawned.id, { status: 'killed' });
  const createsBefore = adapter.calls.filter((call) => call.kind === 'create').length;
  const record = await service.submitContractor({
    teamId: 'alpha', purpose: 'red_auto_review', prompt: 'send 继续 to the red task', mode: 'read-only',
  });
  assert.equal(record.slot, 'main');
  for (let index = 0; index < 50; index += 1) {
    const current = store.getContractor(record.id);
    if (current && ['completed', 'failed', 'killed'].includes(current.status)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  const finished = store.getContractor(record.id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.match(String(finished.result), /red review/);
  assert.equal(
    adapter.calls.filter((call) => call.kind === 'create').length,
    createsBefore,
    'the red-review contractor never creates a model session',
  );
  // Let any remaining contractor pump work settle before the store closes.
  await Promise.allSettled([...service.contractorRuns.values()]);
  await service.awaitRedReviews();
  store.close();
});

test('review rows never appear in the task tree and never pile up red nodes', async () => {
  const { store, service, watchers } = setup();
  makeTeam(service);
  await service.tick('alpha');
  for (let round = 1; round <= 4; round += 1) await redBox(service, watchers);

  const app = createApp({ store, service, token: 'captain-secret' });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const get = (path) => fetch(`${base}${path}`, { headers: { authorization: 'Bearer captain-secret' } });
  try {
    const team = (await (await get('/teams/alpha')).json()).data;
    assert.equal(team.tasks.length, 1, 'only the real task is listed');
    assert.equal(team.tasks[0].id, 't1');
    assert.equal(team.redReviews.total, 4, 'reviews are summarized instead of listed');
    assert.equal(team.redReviews.escalated, 1);
    assert.equal(team.redReviews.running, 0);

    const listed = (await (await get('/teams/alpha/tasks')).json()).data;
    assert.equal(listed.length, 1);
    const all = (await (await get('/teams/alpha/tasks?includeHidden=1')).json()).data;
    assert.equal(all.length, 5, 'admin can still inspect the hidden review rows');
    assert.equal(all.every((task) => task.kind === RED_REVIEW_KIND || task.id === 't1'), true);
    assert.equal(all.filter((task) => task.kind === RED_REVIEW_KIND).every((task) => task.hidden === true), true);

    const snapshotResponse = await get('/ui/snapshot');
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()).data;
    assert.equal(snapshot.teams[0].tasks.length, 1, 'the panel tree shows no review node');
  } finally {
    await app.close();
    store.close();
  }
});

test('redAutoReview.enabled=false leaves red tasks alone', async () => {
  const { store, service, watchers } = setup({ red: { enabled: false } });
  makeTeam(service);
  await service.tick('alpha');
  const task = await redBox(service, watchers);
  assert.equal(task.status, 'failed');
  assert.equal(reviews(store).length, 0);
  store.close();
});

test('a member-reported failure is a red box and gets the same review', async () => {
  const { store, service } = setup();
  makeTeam(service);
  await service.tick('alpha');
  const dispatched = store.getTask('t1');
  const result = await service.completeTask({
    teamId: 'alpha', taskId: 't1', attemptId: dispatched.attemptId,
    update: { status: 'failed', output: 'build broke' },
  });
  assert.equal(result.ok, true, result.error);
  await service.awaitRedReviews();

  const after = store.getTask('t1');
  assert.equal(after.status, 'in_progress', 'the second failure path is continued too');
  assert.equal(after.redContinueCount, 1);
  assert.equal(reviews(store).length, 1);
  assert.equal(reviews(store)[0].outcome, 'continued');
  assert.equal(reviews(store)[0].hidden, true);
  store.close();
});

test('a manual captain continue after the escalation starts a new automatic cycle', async () => {
  const { store, service, watchers } = setup();
  makeTeam(service);
  await service.tick('alpha');
  for (let round = 1; round <= 4; round += 1) await redBox(service, watchers);
  assert.equal(store.getTask('t1').redReviewEscalated, true, 'the fourth red box escalated');

  // The captain takes over by hand: a manual continue clears the escalation and
  // the automatic budget so a later red box is reviewed again from one.
  await service.continueTask('alpha', 't1', {
    actor: { role: 'admin', name: 'captain' }, reason: 'manual takeover',
  });
  const resumed = store.getTask('t1');
  assert.equal(resumed.status, 'in_progress');
  assert.equal(resumed.redReviewEscalated, false);
  assert.equal(resumed.redContinueCount, 0);

  const continued = await redBox(service, watchers);
  assert.equal(continued.status, 'in_progress', 'the automatic review runs again');
  assert.equal(continued.redContinueCount, 1);
  assert.equal(store.listMessages('alpha').filter((message) => message.to === 'captain').length, 1,
    'no second report while the new cycle has budget left');
  store.close();
});

test('the continue budget belongs to the session and resets when the session changes', async () => {
  const { store, adapter, service, watchers } = setup();
  makeTeam(service);
  await service.tick('alpha');
  for (let round = 1; round <= 3; round += 1) await redBox(service, watchers);
  assert.equal(store.getTask('t1').redContinueCount, 3);

  // The recorded budget belongs to the session that produced it. Once the task
  // reports a different session (the member session was rebuilt), the next red
  // box starts a fresh budget instead of escalating on the old count.
  const impl = store.listMembers('alpha').find((member) => member.name === 'impl');
  store.updateTask('t1', { redContinueSessionId: 'sess_stale' });
  const continued = await redBox(service, watchers);
  assert.equal(continued.status, 'in_progress');
  assert.equal(continued.redContinueCount, 1, 'the counter restarted for the new session');
  assert.equal(continued.redReviewEscalated, false);
  assert.equal(continued.redContinueSessionId, impl.sessionId, 'the budget is re-bound to the live session');
  assert.equal(continueSends(adapter).length, 4, 'the fourth continue goes to the live session');
  assert.equal(store.listMessages('alpha').filter((message) => message.to === 'captain').length, 0);
  store.close();
});

test('a rebuilt member session requeues the full task instead of sending a bare continue', async () => {
  const { store, service, watchers } = setup();
  makeTeam(service);
  await service.tick('alpha');
  const first = await redBox(service, watchers);
  assert.equal(first.redContinueCount, 1);
  const impl = store.listMembers('alpha').find((member) => member.name === 'impl');
  const oldSession = impl.sessionId;
  // Simulate a member-session rebuild between the failure and the next review.
  store.updateMember(impl.id, { sessionId: 'sess_rebuilt' });
  store.updateTask('t1', { lastSessionId: oldSession });

  const failed = await redBox(service, watchers);
  assert.equal(failed.status, 'pending', 'the same task is requeued for a full prompt');
  assert.equal(failed.redContinueCount, 0, 'the new session starts a fresh budget');
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'task.continue_session_lost'
    && event.reason === 'session-changed'));
  const review = reviews(store).at(-1);
  assert.equal(review.status, 'in_progress');
  assert.equal(review.outcome, undefined);
  store.close();
});

test('a session replacement during red-review cursor wait consumes one deferral and never escalates early', async () => {
  const { store, adapter, service, watchers, advance, now } = setup({
    red: { maxAttempts: 2, retryDelayMs: 1000 },
  });
  makeTeam(service);
  await service.tick('alpha');
  const member = store.findMember('alpha', 'impl');
  const oldSessionId = member.sessionId;
  const replacement = await adapter.create({ model: 'test/model' });

  let cursorStarted;
  const started = new Promise((resolve) => { cursorStarted = resolve; });
  let rejectCursor;
  const cursorGate = new Promise((_, reject) => { rejectCursor = reject; });
  adapter.turnCursor = async ({ sessionId }) => {
    if (sessionId !== oldSessionId) return 0;
    cursorStarted();
    return cursorGate;
  };
  failTurn(watchers, { message: 'read ECONNRESET', code: 'ECONNRESET' });
  await started;

  store.updateMember(member.id, { sessionId: replacement.sessionId });
  rejectCursor(new Error('cursor unavailable'));
  await service.awaitRedReviews();

  const review = reviews(store)[0];
  assert.ok(review);
  assert.equal(store.getTask('t1').status, 'pending');
  assert.equal(store.getTask('t1').attemptId, undefined);
  assert.equal(review.status, 'in_progress', 'the review waits through its single not-sent backoff');
  assert.equal(review.outcome, undefined);
  assert.equal(review.redReviewAttempts, 1, 'one undelivered continue is counted once');
  assert.equal(store.getTask('t1').redReviewEscalated, false);
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'red_review.deferred').length, 1);
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'red_review.failed').length, 0);
  assert.equal(store.listMessages('alpha').filter((message) => message.to === 'captain').length, 0);
  assert.equal(continueSends(adapter).length, 0, 'no bare continue is sent to the replacement session');
  assert.ok(review.retryAt > now(), 'the single review retry uses the configured backoff');
  advance(review.retryAt - now() + 1);
  service.sweepRedReviews('alpha');
  await service.awaitRedReviews();
  assert.equal(reviews(store)[0].outcome, 'source-active', 'a retry cannot escalate an already requeued task');
  assert.equal(reviews(store)[0].redReviewAttempts, 1, 'the sweep does not consume a second attempt');
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'red_review.deferred').length, 1);
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'red_review.failed').length, 0);

  await service.tick('alpha');
  const sends = adapter.calls.filter((call) => call.kind === 'send');
  assert.equal(sends.at(-1).input.sessionId, replacement.sessionId);
  assert.match(sends.at(-1).input.message, /Task: t1 - 报错任务/);
  assert.equal(sends.at(-1).input.message.startsWith(CONTINUE_MESSAGE), false);
  assert.equal(store.getTask('t1').pendingRedReviewId, undefined);
  store.close();
});

test('a busy member defers the review instead of failing it and retries later', async () => {
  const { store, adapter, service, watchers, advance, now } = setup({ red: { retryDelayMs: 5000 } });
  makeTeam(service);
  await service.tick('alpha');
  // The same member already owns another open task, so continueTask answers
  // E_STATE. The review must wait and retry, not consume a continue or report.
  service.addTask('alpha', { id: 't2', subject: '占用成员', kind: 'work', assignee: 'impl' });
  store.updateTask('t2', { status: 'in_progress' });

  const failed = await redBox(service, watchers);
  assert.equal(failed.status, 'failed');
  assert.equal(continueSends(adapter).length, 0, 'nothing was sent while the member is busy');
  const deferred = reviews(store).at(-1);
  assert.equal(deferred.status, 'in_progress', 'the review row waits for the retry');
  assert.equal(deferred.outcome, undefined);
  assert.equal(typeof deferred.retryAt, 'number');
  assert.equal(failed.redContinueCount ?? 0, 0, 'a deferred review never consumes a continue');

  // The blocking task finishes; the daemon sweep retries after the delay.
  store.updateTask('t2', { status: 'completed' });
  advance(deferred.retryAt - now() + 1);
  service.sweepRedReviews('alpha');
  await service.awaitRedReviews();

  assert.equal(continueSends(adapter).length, 1, 'the deferred continue is sent exactly once');
  assert.equal(store.getTask('t1').status, 'in_progress');
  assert.equal(store.getTask('t1').redContinueCount, 1);
  assert.equal(reviews(store).at(-1).outcome, 'continued');
  assert.equal(store.listMessages('alpha').filter((message) => message.to === 'captain').length, 0);
  store.close();
});

test('one unbuildable row in the graph never blocks the red review', async () => {
  const { store, service, watchers } = setup();
  makeTeam(service);
  await service.tick('alpha');
  // The daemon's own gate builder can insert a repair row with an empty scope
  // and no verify commands (it writes through the store, not addTask). A whole
  // graph validation would then reject every later task, including the review.
  store.addTask({
    id: 'repair-t0-r1', teamId: 'alpha', kind: 'repair', subject: 'repair-round-1',
    status: 'pending', assignee: 'impl', dependencies: [], round: 1,
    objective: 'x', acceptance: ['y'], inScope: [], verify: [], sourceTaskId: 't0',
  });

  const failed = await redBox(service, watchers);
  assert.equal(reviews(store).length, 1, 'the review is created despite the invalid sibling row');
  assert.equal(reviews(store)[0].outcome, 'continued');
  assert.equal(failed.status, 'in_progress', 'the red task was actually continued');
  assert.equal(
    store.listEvents('alpha').filter((event) => event.type === 'red_review.create_failed').length,
    0,
  );
  assert.equal(service.redReviewSummary('alpha').createFailures, 0);
  store.close();
});

test('a review that cannot be created is visible and recovers', async () => {
  const { store, service, watchers, advance } = setup();
  makeTeam(service);
  await service.tick('alpha');
  const originalAddTask = store.addTask.bind(store);
  store.addTask = (task) => {
    if (task.kind === 'red-auto-review') throw new Error('store exploded');
    return originalAddTask(task);
  };

  const failed = await redBox(service, watchers);
  assert.equal(failed.status, 'failed');
  const summary = service.redReviewSummary('alpha');
  assert.equal(summary.total, 0);
  assert.equal(summary.createFailures, 1, 'a missing review is not silent');
  assert.match(String(summary.lastCreateError), /store exploded/);

  // The sweep keeps retrying, but the event is throttled instead of every tick.
  service.sweepRedReviews('alpha');
  advance(1000);
  service.sweepRedReviews('alpha');
  const events = () => store.listEvents('alpha').filter((event) => event.type === 'red_review.create_failed');
  assert.equal(events().length, 1, 'no event spam while the failure persists');

  // Once creation works again the review is built and the failure clears.
  store.addTask = originalAddTask;
  advance(61000);
  service.sweepRedReviews('alpha');
  await service.awaitRedReviews();
  assert.equal(reviews(store).length, 1);
  assert.equal(reviews(store)[0].outcome, 'continued');
  assert.equal(service.redReviewSummary('alpha').createFailures, 0);
  assert.equal(store.getTask('t1').status, 'in_progress');
  store.close();
});

test('a continue is counted only when the queued continue is actually delivered', async () => {
  const { store, adapter, service, watchers, advance } = setup({ red: { retryDelayMs: 5000 } });
  makeTeam(service);
  await service.tick('alpha');
  const realSend = adapter.send.bind(adapter);
  adapter.send = async () => { throw Object.assign(new Error('prompt is already running'), { code: 'E_BUSY' }); };

  const after = await redBox(service, watchers);
  // continueTask already reopened the attempt, but nothing reached the session:
  // the task-level continue is queued and must not be counted by the review.
  assert.equal(after.status, 'in_progress');
  assert.equal(after.redContinueCount ?? 0, 0, 'nothing reached the session, so nothing counts');
  const review = reviews(store).at(-1);
  assert.equal(review.status, 'in_progress', 'the review waits instead of pretending to be done');
  assert.equal(review.outcome, undefined);
  assert.equal(typeof review.retryAt, 'number');
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'red_review.deferred' && event.reason === 'not-sent'));
  assert.equal(continueSends(adapter).length, 0);
  assert.equal(store.listMessages('alpha').filter((message) => message.to === 'captain').length, 0,
    'an undelivered continue is never reported as three failed continues');

  // Once the session accepts it, the turn layer delivers exactly one continue,
  // and that delivery — not the earlier failed attempt — is what counts.
  adapter.send = realSend;
  advance(6000);
  await service.tick('alpha');
  await service.awaitRedReviews();
  assert.equal(continueSends(adapter).length, 1, 'the queued continue is delivered once');
  assert.equal(store.getTask('t1').redContinueCount ?? 0, 1);
  assert.equal(reviews(store).at(-1).outcome, 'continued');
  assert.equal(reviews(store).at(-1).continueCount, 1);
  store.close();
});

test('a failed gate task is left to the repair round instead of being continued', async () => {
  const { store, service } = setup();
  makeTeam(service);
  await service.tick('alpha');
  service.addTask('alpha', {
    id: 'r1', subject: 'review t1', kind: 'review', reviewedTaskId: 't1', assignee: 'reviewer',
    objective: 'review t1', acceptance: ['verdict recorded'],
  }, { internal: true });
  store.updateTask('r1', { status: 'failed', lastAttemptId: 'att_r1', verdict: 'fail' });
  service.onTaskFailed('alpha', 'r1');
  service.sweepRedReviews('alpha');
  await service.awaitRedReviews();

  assert.equal(reviews(store).filter((review) => review.reviewedTaskId === 'r1').length, 0,
    'SPEC 5.4 owns a failed gate task');
  assert.equal(store.getTask('r1').status, 'failed');
  assert.equal(store.getTask('r1').verdict, 'fail', 'the verdict is never re-run as a continue');
  store.close();
});

test('pending red reviews never enter worker readiness or allocation even when automatic review is disabled', (t) => {
  const { config, store, service } = setup({ red: { enabled: false } });
  t.after(() => store.close());
  makeTeam(service);
  store.addTask({
    id: 'pending-review', teamId: 'alpha', subject: 'Automatic continue review',
    kind: RED_REVIEW_KIND, status: 'pending', hidden: true, dependencies: [], assignee: 'reviewer',
  });
  const tasks = store.listTasks('alpha');
  assert.deepEqual(nextReady(tasks, 1000).map((task) => task.id), ['t1']);
  for (const dynamicTeams of [false, true]) {
    const plan = allocateSlots({
      config: { ...config, scheduler: { ...config.scheduler, dynamicTeams } }, tasks, active: [], now: 1000,
    });
    assert.deepEqual(plan.dispatch.map((item) => item.taskId), ['t1']);
  }
});

test('halt then resume restores a deferred review without allocating a worker or resetting its budget', async (t) => {
  const { store, adapter, service, watchers, advance, now } = setup({ red: { retryDelayMs: 5000 } });
  t.after(() => store.close());
  makeTeam(service);
  await service.tick('alpha');
  await redBox(service, watchers);
  service.addTask('alpha', { id: 'busy', subject: 'Busy member', kind: 'work', assignee: 'impl' });
  store.updateTask('busy', { status: 'in_progress' });
  await redBox(service, watchers);
  store.updateTask('busy', { status: 'completed' });
  const deferred = reviews(store).at(-1);
  assert.equal(deferred.redReviewAttempts, 1);
  assert.equal(store.getTask('t1').redContinueCount, 1);
  assert.equal(deferred.id, redReviewTaskId(redReviewKey(store.getTask('t1'))));

  // An unconfirmed stop retains the same session and therefore its continue budget.
  adapter.stop = async () => ({ ok: false, warning: 'stop not confirmed' });
  await service.halt('alpha', 'pause deferred review');
  assert.equal(store.getTask(deferred.id).status, 'pending', 'exercise the real halt transition');
  const sendsBefore = adapter.calls.filter((call) => call.kind === 'send').length;
  service.sweepRedReviews('alpha');
  await service.runRedReview('alpha', deferred.id, { force: true });
  await service.awaitRedReviews();
  assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, sendsBefore);
  assert.equal(store.listMessages('alpha').length, 0);

  await service.resume('alpha', 'resume deferred review');
  await service.awaitRedReviews();
  const restored = store.getTask(deferred.id);
  assert.equal(restored.status, 'in_progress', 'resume recovers the pending daemon review before dispatch');
  assert.equal(restored.redReviewAttempts, deferred.redReviewAttempts);
  assert.equal(restored.retryAt, deferred.retryAt, 'resume preserves retry backoff');
  assert.equal(store.getTask('t1').redContinueCount, 1);
  assert.equal(continueSends(adapter).length, 1, 'resume does not send before retryAt');
  assert.equal(restored.assignee, undefined);
  assert.equal(restored.attemptId, undefined);
  assert.equal(store.listAttempts('alpha').some((attempt) => attempt.taskId === deferred.id), false);

  advance(deferred.retryAt - now());
  await service.tick('alpha');
  await service.awaitRedReviews();
  assert.equal(store.getTask(deferred.id).outcome, 'continued');
  assert.equal(store.getTask('t1').redContinueCount, 2);
  assert.equal(continueSends(adapter).length, 2);
  assert.equal(reviews(store).length, 2, 'resume reuses the same failure review');
  service.sweepRedReviews('alpha');
  await service.awaitRedReviews();
  assert.equal(continueSends(adapter).length, 2);
});

test('ensure reopens a halted pending review under the same id only after the team is active', async (t) => {
  const { store, adapter, service, watchers } = setup({ red: { enabled: false } });
  t.after(() => store.close());
  makeTeam(service);
  await service.tick('alpha');
  const failed = await redBox(service, watchers);
  service.redReview.enabled = true;
  const review = service.ensureRedReview('alpha', failed, { autoRun: false });
  store.updateTask(review.id, { redReviewAttempts: 2, retryAt: 9000 });
  await service.halt('alpha', 'pause');
  const sendsBefore = adapter.calls.filter((call) => call.kind === 'send').length;
  service.ensureRedReview('alpha', store.getTask('t1'));
  await service.awaitRedReviews();
  assert.equal(store.getTask(review.id).status, 'pending');
  assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, sendsBefore);

  // Exercise the existing ensure facade independently of resume's sweep.
  store.updateTeam('alpha', { control: 'active' });
  const reopened = service.ensureRedReview('alpha', store.getTask('t1'), { autoRun: false });
  assert.equal(reopened.id, review.id);
  assert.equal(reopened.status, 'in_progress');
  assert.equal(reopened.redReviewAttempts, 2);
  assert.equal(reopened.retryAt, 9000);
  assert.equal(reopened.assignee, undefined);
  assert.equal(reopened.attemptId, undefined);
  assert.equal(reviews(store).length, 1);
});

test('a queued review cannot report to the captain after halt begins', async (t) => {
  const { store, adapter, service, watchers } = setup({ red: { enabled: false, maxContinues: 0 } });
  t.after(() => store.close());
  makeTeam(service);
  await service.tick('alpha');
  const failed = await redBox(service, watchers);
  service.redReview.enabled = true;
  const review = service.ensureRedReview('alpha', failed);
  const sendsBefore = adapter.calls.filter((call) => call.kind === 'send').length;
  await service.halt('alpha', 'halt before the scheduled review runs');
  await service.awaitRedReviews();
  assert.equal(store.getTask(review.id).status, 'pending');
  assert.equal(store.getTask('t1').redReviewEscalated, undefined);
  assert.equal(store.listMessages('alpha').length, 0);
  assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, sendsBefore);

  await service.resume('alpha', 'allow the report');
  await service.awaitRedReviews();
  assert.equal(store.getTask(review.id).outcome, 'escalated');
  assert.equal(store.listMessages('alpha').filter((message) => message.to === 'captain').length, 1);
  assert.equal(continueSends(adapter).length, 0);
});

for (const change of ['halt', 'halt then resume', 'session replacement']) {
  test(`a red continue waiting on its cursor does not send after ${change}`, async (t) => {
    const { store, adapter, service, watchers } = setup();
    t.after(() => store.close());
    makeTeam(service);
    await service.tick('alpha');
    const entered = Promise.withResolvers();
    const cursor = Promise.withResolvers();
    adapter.turnCursor = () => { entered.resolve(); return cursor.promise; };
    const pending = redBox(service, watchers);
    await entered.promise;
    const attemptId = store.getTask('t1').attemptId;
    const member = store.findMember('alpha', 'impl');

    if (change === 'session replacement') {
      store.updateMember(member.id, { sessionId: 'sess_replacement' });
    } else {
      await service.halt('alpha', 'halt while continue cursor is pending');
      assert.equal(store.getAttempt(attemptId).status, 'halted');
      if (change === 'halt then resume') {
        adapter.turnCursor = async () => 0;
        await service.resume('alpha', 'resume with a new attempt');
        assert.notEqual(store.getTask('t1').attemptId, attemptId);
      }
    }
    const sendsBeforeRelease = adapter.calls.filter((call) => call.kind === 'send').length;
    const countBeforeRelease = store.getTask('t1').redContinueCount ?? 0;
    cursor.resolve(0);
    await pending;
    await service.awaitRedReviews();

    assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, sendsBeforeRelease,
      'a stale cursor must not send to the old session');
    assert.equal(continueSends(adapter).length, 0);
    assert.equal(store.getTask('t1').redContinueCount ?? 0, countBeforeRelease);
    assert.equal(store.listEvents('alpha').some((event) => event.type === 'red_review.continued'), false);
    if (change !== 'session replacement') assert.equal(store.getAttempt(attemptId).status, 'halted');
  });
}

test('the creation failure injection remains on the existing addRedReviewTask facade', async (t) => {
  const { store, service, watchers, advance } = setup();
  t.after(() => store.close());
  makeTeam(service);
  await service.tick('alpha');
  const original = service.addRedReviewTask.bind(service);
  service.addRedReviewTask = () => { throw new Error('facade creation failed'); };
  await redBox(service, watchers);
  assert.equal(reviews(store).length, 0);
  assert.equal(service.redReviewSummary('alpha').createFailures, 1);
  assert.match(service.redReviewSummary('alpha').lastCreateError, /facade creation failed/u);
  service.sweepRedReviews('alpha');
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'red_review.create_failed').length, 1);

  service.addRedReviewTask = original;
  advance(61000);
  service.sweepRedReviews('alpha');
  await service.awaitRedReviews();
  assert.equal(reviews(store).length, 1);
  assert.equal(reviews(store)[0].outcome, 'continued');
  assert.equal(service.redReviewSummary('alpha').createFailures, 0);
});

for (const mode of ['busy member', 'undelivered continue']) {
  test(`${mode} escalates at the defer limit without counting an unsent continue`, async (t) => {
    const { store, adapter, service, watchers, advance, now } = setup({ red: { maxAttempts: 3, retryDelayMs: 5000 } });
    t.after(() => store.close());
    makeTeam(service);
    await service.tick('alpha');
    if (mode === 'busy member') {
      service.addTask('alpha', { id: 'busy', subject: 'Busy member', kind: 'work', assignee: 'impl' });
      store.updateTask('busy', { status: 'in_progress' });
    } else {
      service.continueTask = async () => ({ sent: false, warning: 'prompt is already running' });
    }
    await redBox(service, watchers);
    const review = reviews(store)[0];
    for (let attempt = 1; attempt < 3; attempt += 1) {
      const deferred = store.getTask(review.id);
      assert.equal(deferred.status, 'in_progress');
      assert.equal(deferred.redReviewAttempts, attempt);
      assert.equal(store.listMessages('alpha').length, 0);
      advance(deferred.retryAt - now());
      service.sweepRedReviews('alpha');
      await service.awaitRedReviews();
    }
    assert.equal(store.getTask(review.id).outcome, 'escalated');
    assert.equal(store.getTask('t1').redReviewEscalated, true);
    assert.equal(store.getTask('t1').redContinueCount ?? 0, 0);
    assert.equal(continueSends(adapter).length, 0);
    const report = store.listMessages('alpha').filter((message) => message.to === 'captain');
    assert.equal(report.length, 1);
    assert.match(report[0].content, /automatic continues: 0/u);
    assert.ok(store.listEvents('alpha').some((event) => event.type === 'red_review.failed' && event.attempts === 3));
    service.sweepRedReviews('alpha');
    await service.awaitRedReviews();
    assert.equal(store.listMessages('alpha').filter((message) => message.to === 'captain').length, 1);
  });
}

test('a captain report send failure is recorded without claiming a delivered message or sending another continue', async (t) => {
  const { store, adapter, service, watchers } = setup({ red: { maxContinues: 0 } });
  t.after(() => store.close());
  makeTeam(service);
  await service.tick('alpha');
  let reports = 0;
  service.sendMessage = () => { reports += 1; throw new Error('captain mailbox unavailable'); };
  await redBox(service, watchers);
  const failed = store.getTask('t1');
  const review = reviews(store)[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.redReviewEscalated, true);
  assert.equal(failed.redEscalatedMessageId, undefined);
  assert.equal(review.outcome, 'escalated');
  assert.equal(review.escalationMessageId, undefined);
  assert.equal(continueSends(adapter).length, 0);
  assert.equal(store.listMessages('alpha').length, 0);
  const events = store.listEvents('alpha').filter((event) => event.type === 'red_review.report_failed');
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, 't1');
  assert.equal(events[0].reviewTaskId, review.id);
  assert.match(events[0].error, /captain mailbox unavailable/u);
  service.sweepRedReviews('alpha');
  await service.awaitRedReviews();
  assert.equal(reports, 1, 'preserve the existing terminal escalation behavior');
});

test('audit never reports a hidden review row as a deliverable', async () => {
  const { store, service, watchers } = setup();
  makeTeam(service);
  await service.tick('alpha');
  for (let round = 1; round <= 2; round += 1) await redBox(service, watchers);
  const audit = service.audit('alpha');
  assert.equal(JSON.stringify(audit).includes('redreview_'), false);
  assert.equal(JSON.stringify(audit).includes('red-auto-review'), false);
  store.close();
});
