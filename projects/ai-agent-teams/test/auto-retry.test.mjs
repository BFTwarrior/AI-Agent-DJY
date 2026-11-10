import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { CONTINUE_MESSAGE, isRetryableTurnError } from '../src/domain/scheduler.mjs';
import { TEAM_TOOL_NAMES, contractorContinueDenylist } from '../src/domain/team-tools.mjs';
import { TOOL_DEFINITIONS, createMcpHandler } from '../src/mcp/handler.mjs';
import { createApp } from '../src/http/server.mjs';
import { listenForFetch } from './support/listen.mjs';

function setup({ startClock = 1000, patch, handler } = {}) {
  const { config } = loadConfig('config/example.v06.json');
  // These tests pin the turn-retry layer: after the turn budget is exhausted
  // the task must be `failed`. The automatic red-box review that continues a
  // failed task is covered separately in test/red-auto-review.test.mjs.
  config.zcode.redAutoReview.enabled = false;
  patch?.(config);
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter({ handler });
  let clock = startClock;
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter,
    config,
    cwd: process.cwd(),
    now: () => clock,
  });
  return { config, store, adapter, service, advance: (ms) => { clock += ms; }, now: () => clock };
}

function failedTurnWiring(adapter) {
  adapter.turnCursor = async () => 0;
  const watchers = [];
  adapter.watchTurn = (input) => {
    watchers.push(input);
    return { cancel() {} };
  };
  return watchers;
}

function workTask(id, subject, assignee) {
  return { id, subject, kind: 'work', assignee };
}

function makeTeam(service) {
  service.createTeam({
    id: 'alpha',
    name: 'Alpha',
    phase: 'running',
    members: [{ name: 'impl', role: 'engineer' }, { name: 'reviewer', role: 'reviewer' }],
  });
  service.addTask('alpha', workTask('t1', '报错任务', 'impl'));
}

function continueSends(adapter) {
  return adapter.calls.filter((call) => call.kind === 'send'
    && (call.input.message === CONTINUE_MESSAGE
      || String(call.input.message).startsWith(`${CONTINUE_MESSAGE}\n`)));
}

async function failTurn({ store, service, advance, now, watchers }) {
  // Flush a continue that is already scheduled before failing the next turn.
  let task = store.getTask('t1');
  if (task.status === 'in_progress' && task.autoContinue === true) {
    advance(task.retryNotBefore - now());
    await service.tick('alpha');
  }
  watchers.at(-1).onFailed({ message: 'read ECONNRESET', code: 'ECONNRESET' });
  task = store.getTask('t1');
  if (task.status === 'in_progress' && task.autoContinue === true) {
    advance(task.retryNotBefore - now());
    await service.tick('alpha');
  }
  return store.getTask('t1');
}

async function exhaustTurns(wiring, count = 4) {
  for (let index = 0; index < count; index += 1) await failTurn(wiring);
  return wiring.store.getTask('t1');
}

test('retryable turn errors are classified without retrying hard quota or explicit non-retryable errors', () => {
  assert.equal(isRetryableTurnError({ message: 'read ECONNRESET', code: 'ECONNRESET' }), true);
  assert.equal(isRetryableTurnError({ message: 'request timed out' }), true);
  assert.equal(isRetryableTurnError({ message: 'provider returned HTTP 503' }), true);
  assert.equal(isRetryableTurnError({ message: 'too many requests', code: '429' }), true);
  assert.equal(isRetryableTurnError({ message: 'anything', code: 'rate_limit_exceeded' }), true);
  assert.equal(isRetryableTurnError({ message: 'insufficient_quota: hard quota exhausted' }), false);
  assert.equal(isRetryableTurnError({ message: 'bad input', code: 'invalid_request', retryable: false }), false);
});

test('consecutive ECONNRESET continues the same task/session three times, then fails without a new task', async () => {
  const wiring = setup();
  const { store, adapter, service, advance, now } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');

  const initial = store.getTask('t1');
  const sessionId = store.listMembers('alpha').find((member) => member.name === 'impl').sessionId;
  assert.ok(initial.attemptId);
  assert.ok(sessionId);
  const delays = [];

  for (let failure = 1; failure <= 4; failure += 1) {
    const before = store.getTask('t1');
    assert.equal(watchers.length, failure);
    watchers.at(-1).onFailed({ message: 'read ECONNRESET', code: 'ECONNRESET' });
    const task = store.getTask('t1');
    assert.equal(task.id, 't1');
    assert.equal(task.subject, '报错任务');
    assert.equal(store.listTasks('alpha').length, 1, 'no retry copy task is created');
    assert.equal(store.listTasks('alpha').some((item) => /（重试）/.test(item.subject)), false);
    if (failure < 4) {
      assert.equal(task.status, 'in_progress');
      assert.ok(task.attemptId);
      assert.equal(task.attempt, before.attempt + 1, 'the attempt counter only increases');
      assert.equal(task.autoContinue, true);
      const delay = task.retryNotBefore - now();
      delays.push(delay);
      advance(delay);
      await service.tick('alpha');
      assert.equal(continueSends(adapter).length, failure);
      assert.equal(continueSends(adapter).at(-1).input.sessionId, sessionId, 'same session is reused');
      assert.equal(store.getTask('t1').autoContinue, false);
    } else {
      assert.equal(task.status, 'failed');
      assert.equal(task.attemptId, undefined);
      assert.match(task.error, /ECONNRESET/);
      assert.equal(task.lastSessionId, sessionId);
    }
  }

  assert.deepEqual(delays, [3000, 6000, 12000], 'automatic continues use exponential backoff');
  const attempts = store.listAttempts('alpha');
  assert.equal(attempts.length, 4, 'one attempt per turn, never a new task');
  assert.equal(attempts.every((attempt) => attempt.status === 'failed'), true);
  store.close();
});

test('only a reviewer or captain may continue a failed task; a plain engineer is denied', async () => {
  const wiring = setup();
  const { store, adapter, service } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');
  const failed = await exhaustTurns({ ...wiring, watchers });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.includes('ECONNRESET'), true);

  const impl = store.listMembers('alpha').find((member) => member.name === 'impl');
  const reviewer = store.listMembers('alpha').find((member) => member.name === 'reviewer');
  assert.equal(reviewer.license.capabilities.includes('task:continue'), true);
  assert.equal(impl.license.capabilities.includes('task:continue'), false);

  const engineerActor = { role: 'member', memberId: impl.id, teamId: 'alpha', name: impl.name };
  await assert.rejects(
    () => service.continueTask('alpha', 't1', { actor: engineerActor, reason: 'sneak in' }),
    (error) => error.status === 403 && error.code === 'E_FORBIDDEN',
  );
  assert.equal(store.getTask('t1').status, 'failed');

  const reviewerActor = { role: 'member', memberId: reviewer.id, teamId: 'alpha', name: reviewer.name };
  const failedAttempt = store.getTask('t1').attempt;
  // Simulate a task that was reopened or halted before the failure: the next
  // attempt must carry the current epoch or completeTask rejects it as stale.
  store.updateTask('t1', { taskEpoch: 2 });
  const sendsBefore = continueSends(adapter).length;
  const resumed = await service.continueTask('alpha', 't1', { actor: reviewerActor, reason: 'reviewer resumes' });
  assert.equal(resumed.ok, true);
  const resumedAttempt = store.listAttempts('alpha').at(-1);
  assert.equal(resumedAttempt.taskEpoch, 2);
  assert.equal(resumedAttempt.controlEpoch, store.getTeam('alpha').controlEpoch ?? 0);
  const task = store.getTask('t1');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.subject, '报错任务');
  assert.equal(task.attempt, failedAttempt + 1);
  assert.equal(task.turnFailureCount, 0);
  assert.equal(task.error, undefined);
  assert.equal(task.lastContinueBy, 'reviewer');
  assert.equal(continueSends(adapter).length, sendsBefore + 1);
  assert.equal(continueSends(adapter).at(-1).input.sessionId, impl.sessionId);

  // A continued task gets a fresh three-continue budget instead of failing at once.
  watchers.at(-1).onFailed({ message: 'read ECONNRESET', code: 'ECONNRESET' });
  const retried = store.getTask('t1');
  assert.equal(retried.status, 'in_progress');
  assert.equal(retried.turnFailureCount, 1);
  assert.equal(retried.attempt, failedAttempt + 2);
  assert.equal(store.listAttempts('alpha').at(-1).taskEpoch, 2,
    'automatic continues must stamp the current task epoch too');

  // Exhaust the fresh budget again, then the captain continues it.
  const failedAgain = await exhaustTurns({ ...wiring, watchers }, 3);
  assert.equal(failedAgain.status, 'failed');
  const captain = await service.continueTask('alpha', 't1', { actor: { role: 'admin', name: 'captain' }, reason: 'captain resumes' });
  assert.equal(captain.ok, true);
  assert.equal(store.getTask('t1').status, 'in_progress');
  assert.equal(store.getTask('t1').lastContinueBy, 'captain');
  store.close();
});

test('a stale-session turn failure requeues the full task without consuming the new session budget', async () => {
  const wiring = setup();
  const { store, adapter, service } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');

  const task = store.getTask('t1');
  const member = store.findMember('alpha', 'impl');
  const oldSessionId = member.sessionId;
  const replacement = await adapter.create({ model: 'test/model' });
  store.updateMember(member.id, { sessionId: replacement.sessionId });

  const order = [];
  const updateAttempt = store.updateAttempt.bind(store);
  store.updateAttempt = (id, patch) => {
    if (store.inTransaction && patch.status === 'failed') order.push('attempt:failed');
    return updateAttempt(id, patch);
  };
  const updateTask = store.updateTask.bind(store);
  store.updateTask = (id, patch) => {
    if (store.inTransaction && patch.status === 'pending') order.push('task:pending');
    return updateTask(id, patch);
  };
  const addEvent = store.addEvent.bind(store);
  store.addEvent = (teamId, type, data) => {
    if (teamId === 'alpha') order.push(`event:${type}`);
    return addEvent(teamId, type, data);
  };
  const updateMember = store.updateMember.bind(store);
  store.updateMember = (id, patch) => {
    if (store.inTransaction && patch.status === 'idle') order.push('member:idle');
    return updateMember(id, patch);
  };
  const refreshMemberState = service.refreshMemberState.bind(service);
  service.refreshMemberState = (...args) => {
    order.push('member:refresh');
    return refreshMemberState(...args);
  };

  watchers[0].onFailed({ message: 'read ECONNRESET', code: 'ECONNRESET' });
  const requeued = store.getTask('t1');
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.attemptId, undefined);
  assert.equal(requeued.autoContinue, false);
  assert.equal(requeued.turnFailureCount, 0);
  assert.equal(requeued.autoContinueCount, 0);
  assert.equal(requeued.lastSessionId, oldSessionId);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'task.continue_session_lost'
    && event.reason === 'session-changed'
    && event.previousSessionId === oldSessionId
    && event.sessionId === replacement.sessionId));
  assert.deepEqual(order.slice(0, 5), [
    'attempt:failed', 'task:pending', 'event:task.turn_failed',
    'event:task.continue_session_lost', 'member:idle',
  ]);
  assert.equal(order[5], 'member:refresh');

  await service.tick('alpha');
  const sends = adapter.calls.filter((call) => call.kind === 'send');
  const resent = sends.at(-1);
  assert.equal(resent.input.sessionId, replacement.sessionId);
  assert.match(resent.input.message, /Task: t1 - 报错任务/);
  assert.match(resent.input.message, new RegExp(`Attempt id: ${store.getTask('t1').attemptId}`));
  assert.equal(resent.input.message.startsWith('继续'), false);
  assert.equal(store.getTask('t1').status, 'in_progress');
  assert.equal(store.getTask('t1').turnFailureCount, 0);
  assert.equal(watchers.length, 2);
  assert.equal(task.status, 'in_progress', 'the original task snapshot remains unchanged');
  store.close();
});

test('a non-retryable turn failure stays terminal after the member session changes', async () => {
  const wiring = setup();
  const { store, adapter, service } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');
  const member = store.findMember('alpha', 'impl');
  const replacement = await adapter.create({ model: 'test/model' });
  store.updateMember(member.id, { sessionId: replacement.sessionId });

  watchers[0].onFailed({
    message: 'invalid request', code: 'invalid_request', retryable: false,
  });

  const task = store.getTask('t1');
  assert.equal(task.status, 'failed');
  assert.equal(task.attemptId, undefined);
  assert.equal(task.autoContinue, false);
  assert.equal(store.listEvents('alpha').some((event) => event.type === 'task.continue_session_lost'), false);
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'task.turn_failed').at(-1).exhausted, true);
  store.close();
});

test('a session replacement during the turn-cursor wait requeues before sending continue', async () => {
  const wiring = setup();
  const { store, adapter, service, advance, now } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');
  watchers[0].onFailed({ message: 'read ECONNRESET', code: 'ECONNRESET' });
  const scheduled = store.getTask('t1');
  advance(scheduled.retryNotBefore - now());

  let cursorStarted;
  const started = new Promise((resolve) => { cursorStarted = resolve; });
  let releaseCursor;
  const cursorGate = new Promise((resolve) => { releaseCursor = resolve; });
  adapter.turnCursor = async () => {
    cursorStarted();
    await cursorGate;
    return 0;
  };
  const continuing = service.continueDueTurns('alpha', now());
  await started;

  const member = store.findMember('alpha', 'impl');
  const replacement = await adapter.create({ model: 'test/model' });
  store.updateMember(member.id, { sessionId: replacement.sessionId });
  releaseCursor();
  assert.equal(await continuing, 0);

  const requeued = store.getTask('t1');
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.attemptId, undefined);
  assert.equal(requeued.autoContinue, false);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'task.continue_session_lost'
    && event.sessionId === replacement.sessionId));
  assert.equal(continueSends(adapter).length, 0);

  await service.tick('alpha');
  const sends = adapter.calls.filter((call) => call.kind === 'send');
  assert.equal(sends.at(-1).input.sessionId, replacement.sessionId);
  assert.match(sends.at(-1).input.message, /Task: t1 - 报错任务/);
  assert.equal(sends.at(-1).input.message.startsWith('继续'), false);
  store.close();
});

test('a session replacement during a failed turn-cursor wait requeues before deferring', async () => {
  const wiring = setup();
  const { store, adapter, service, advance, now } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');
  watchers[0].onFailed({ message: 'read ECONNRESET', code: 'ECONNRESET' });
  const scheduled = store.getTask('t1');
  advance(scheduled.retryNotBefore - now());

  const member = store.findMember('alpha', 'impl');
  const oldSessionId = member.sessionId;
  let cursorStarted;
  const started = new Promise((resolve) => { cursorStarted = resolve; });
  let rejectCursor;
  const cursorGate = new Promise((_, reject) => { rejectCursor = reject; });
  adapter.turnCursor = async ({ sessionId }) => {
    if (sessionId !== oldSessionId) return 0;
    cursorStarted();
    return cursorGate;
  };
  const continuing = service.continueDueTurns('alpha', now());
  await started;

  const replacement = await adapter.create({ model: 'test/model' });
  store.updateMember(member.id, { sessionId: replacement.sessionId });
  rejectCursor(new Error('cursor unavailable'));
  assert.equal(await continuing, 0);

  const requeued = store.getTask('t1');
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.attemptId, undefined);
  assert.equal(requeued.continueDeferCount, 0, 'the stale cursor error does not consume a defer');
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'task.continue_deferred').length, 0);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'task.continue_session_lost'
    && event.sessionId === replacement.sessionId));
  assert.equal(continueSends(adapter).length, 0);

  await service.tick('alpha');
  const sends = adapter.calls.filter((call) => call.kind === 'send');
  assert.equal(sends.at(-1).input.sessionId, replacement.sessionId);
  assert.match(sends.at(-1).input.message, /Task: t1 - 报错任务/);
  assert.equal(sends.at(-1).input.message.startsWith('继续'), false);
  store.close();
});

test('a continue with no live session requeues the same task for a fresh session', async () => {
  const wiring = setup();
  const { store, adapter, service } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');
  await exhaustTurns({ ...wiring, watchers });

  const impl = store.listMembers('alpha').find((member) => member.name === 'impl');
  const reviewer = store.listMembers('alpha').find((member) => member.name === 'reviewer');
  store.updateMember(impl.id, { sessionId: undefined, residency: 'cold' });
  const taskCount = store.listTasks('alpha').length;
  const result = await service.continueTask('alpha', 't1', {
    actor: { role: 'member', memberId: reviewer.id, teamId: 'alpha', name: reviewer.name },
    reason: 'resume without a session',
  });
  assert.equal(result.sent, false);
  assert.match(result.warning, /requeued/);
  assert.equal(store.listTasks('alpha').length, taskCount, 'the task is requeued, not copied');
  const task = store.getTask('t1');
  assert.equal(task.id, 't1');
  assert.equal(task.subject, '报错任务');
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'task.continue_session_lost'));
  assert.ok(store.getMember(impl.id).sessionId, 'dispatch created a fresh session for the same task');
  assert.equal(task.status, 'in_progress');
  store.close();
});

test('HTTP continue endpoint allows the reviewer token, rejects a plain member, and accepts captain', async () => {
  const wiring = setup();
  const { store, adapter, service } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');
  const failed = await exhaustTurns({ ...wiring, watchers });
  assert.equal(failed.status, 'failed');

  const impl = store.listMembers('alpha').find((member) => member.name === 'impl');
  const reviewer = store.listMembers('alpha').find((member) => member.name === 'reviewer');
  const app = createApp({ store, service, token: 'captain-secret' });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const post = (token, body = { reason: 'http resume' }) => fetch(`${base}/teams/alpha/tasks/t1/continue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await post(store.getMemberToken(impl.id))).status, 403);
    assert.equal(store.getTask('t1').status, 'failed');

    const reviewerResponse = await post(store.getMemberToken(reviewer.id));
    assert.equal(reviewerResponse.status, 200);
    const reviewerBody = await reviewerResponse.json();
    assert.equal(reviewerBody.ok, true);
    assert.equal(reviewerBody.data.sent, true);
    assert.equal(reviewerBody.data.task.status, 'in_progress');

    const failedAgain = await exhaustTurns({ ...wiring, watchers });
    assert.equal(failedAgain.status, 'failed');
    const captainResponse = await post('captain-secret');
    assert.equal(captainResponse.status, 200);
    const captainBody = await captainResponse.json();
    assert.equal(captainBody.data.task.status, 'in_progress');
    assert.equal(captainBody.data.task.lastContinueBy, 'captain');
  } finally {
    await app.close();
    store.close();
  }
});

test('a contractor with task:continue can continue a failed task; a plain member still cannot', async () => {
  const wiring = setup();
  const { store, adapter, service, now } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');
  const failed = await exhaustTurns({ ...wiring, watchers });
  assert.equal(failed.status, 'failed');

  const impl = store.listMembers('alpha').find((member) => member.name === 'impl');
  const contractor = store.addContractor({
    id: 'ctr_auto_retry',
    teamId: 'alpha',
    slot: 'main',
    purpose: 'audit',
    mode: 'read-only',
    prompt: 'audit',
    status: 'running',
    queuedAt: now(),
    timeoutMs: 60000,
    capabilities: ['task:continue'],
  });
  const contractorToken = service.ensureMemberToken(contractor);
  assert.ok(contractorToken);
  const app = createApp({ store, service, token: 'captain-secret' });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const post = (token, body = { reason: 'contractor resume' }) => fetch(`${base}/teams/alpha/tasks/t1/continue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await post(store.getMemberToken(impl.id))).status, 403);
    assert.equal(store.getTask('t1').status, 'failed');

    const response = await post(contractorToken);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.sent, true);
    assert.equal(body.data.task.status, 'in_progress');
    assert.equal(body.data.task.lastContinueBy, 'contractor:ctr_auto_retry');

    // A contractor token is limited to the continue route.
    const other = await fetch(`${base}/teams/alpha`, {
      headers: { authorization: `Bearer ${contractorToken}` },
    });
    assert.equal(other.status, 403);
    store.updateContractor(contractor.id, { status: 'completed', endedAt: now() });
    assert.equal(service.canContinueTask('alpha', { role: 'contractor', contractorId: contractor.id }), false);
  } finally {
    await app.close();
    store.close();
  }
});

test('MCP exposes agent_teams_continue_task to members and proxies it to the daemon route', async () => {
  assert.equal(TOOL_DEFINITIONS.some((tool) => tool.name === 'agent_teams_continue_task'), true);
  assert.equal(TEAM_TOOL_NAMES.includes('agent_teams_continue_task'), true);
  const contractorDeny = contractorContinueDenylist();
  assert.equal(contractorDeny.includes('mcp__agent-teams-member__agent_teams_continue_task'), false);
  assert.equal(contractorDeny.includes('agent_teams_continue_task'), false);
  assert.equal(contractorDeny.includes('mcp__agent-teams-member__agent_teams_reassign_task'), true);
  assert.equal(contractorDeny.includes('agent_teams_reassign_task'), true);
  assert.equal(contractorDeny.includes('mcp__plugin_ai-agent-teams_agent-teams__agent_teams_continue_task'), true);

  const calls = [];
  const handle = createMcpHandler({
    baseUrl: 'http://127.0.0.1:9',
    token: 'captain-secret',
    defaultTeam: 'alpha',
    defaultMember: 'reviewer',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { sent: true }, error: null }) };
    },
  });
  const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(listed.result.tools.some((tool) => tool.name === 'agent_teams_continue_task'), true);
  const response = await handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'agent_teams_continue_task',
      arguments: { team_id: 'alpha', task_id: 't1', reason: 'resume from MCP' },
    },
  });
  assert.equal(response.result.isError, false);
  assert.match(calls[0].url, /\/api\/v1\/teams\/alpha\/tasks\/t1\/continue$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { reason: 'resume from MCP' });
});

function contractorSetup() {
  return setup({
    patch: (config) => {
      config.zcode.turnFailureRetry.baseDelayMs = 0;
      config.zcode.turnFailureRetry.maxDelayMs = 0;
    },
  });
}

function contractorSends(adapter) {
  return adapter.calls
    .filter((call) => call.kind === 'send')
    .map((call) => ({ sessionId: call.input.sessionId, message: call.input.message }));
}

test('a contractor turn failure continues the same contractor session three times before failing', async () => {
  const { store, adapter, service } = contractorSetup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const seen = [];
  adapter.send = async ({ sessionId, message }) => {
    seen.push({ sessionId, message });
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  };
  const contractor = await service.spawnContractor({
    teamId: 'alpha', purpose: 'audit', prompt: 'audit this', mode: 'read-only',
  });
  assert.equal(contractor.status, 'failed');
  assert.match(contractor.error, /ECONNRESET/);
  assert.deepEqual(seen.map((item) => item.message), ['audit this', CONTINUE_MESSAGE, CONTINUE_MESSAGE, CONTINUE_MESSAGE]);
  assert.equal(new Set(seen.map((item) => item.sessionId)).size, 1, 'the same contractor session is reused');
  assert.equal(contractor.sessionId, undefined, 'the contractor session is cleaned up after the final failure');
  assert.equal(store.listContractors('alpha').length, 1, 'no extra contractor record is created');
  const scheduled = store.listEvents('alpha').filter((event) => event.type === 'contractor.continue_scheduled');
  assert.equal(scheduled.length, 3);
  assert.deepEqual(scheduled.map((event) => event.attempt), [1, 2, 3]);
  store.close();
});

test('a contractor recovers when a declined turn result is followed by a successful continue', async () => {
  const { store, adapter, service } = contractorSetup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  let declines = 2;
  adapter.send = async ({ sessionId, message }) => {
    adapter.calls.push({ kind: 'send', input: { sessionId, message } });
    if (declines > 0) {
      declines -= 1;
      return { ok: false, warning: 'provider error: read ECONNRESET', error: { message: 'read ECONNRESET', code: 'ECONNRESET' } };
    }
    return { ok: true, response: 'verdict: pass', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  };
  const contractor = await service.spawnContractor({
    teamId: 'alpha', purpose: 'post_merge_review:t1', prompt: 'post-merge review this patch',
  });
  assert.equal(contractor.status, 'completed');
  assert.equal(contractor.result, 'verdict: pass');
  assert.deepEqual(contractorSends(adapter).map((item) => item.message), ['post-merge review this patch', CONTINUE_MESSAGE, CONTINUE_MESSAGE]);
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'contractor.continue_scheduled').length, 2);
  store.close();
});

test('a non-retryable contractor failure is not continued', async () => {
  const { store, adapter, service } = contractorSetup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  adapter.send = async () => {
    adapter.calls.push({ kind: 'send', input: { message: 'bad request' } });
    throw Object.assign(new Error('provider rejected the request'), { code: 'invalid_request', retryable: false });
  };
  const contractor = await service.spawnContractor({
    teamId: 'alpha', purpose: 'audit', prompt: 'audit this', mode: 'read-only',
  });
  assert.equal(contractor.status, 'failed');
  assert.equal(contractorSends(adapter).length, 1);
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'contractor.continue_scheduled').length, 0);
  store.close();
});

function memberActor(store, name) {
  const member = store.listMembers('alpha').find((item) => item.name === name);
  return { role: 'member', memberId: member.id, teamId: 'alpha', name: member.name };
}

async function failOnceAndContinue(wiring) {
  const { store, adapter, service, advance, now } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');
  const firstAttemptId = store.getTask('t1').attemptId;
  watchers.at(-1).onFailed({ message: 'read ECONNRESET', code: 'ECONNRESET' });
  const scheduled = store.getTask('t1');
  advance(scheduled.retryNotBefore - now());
  await service.tick('alpha');
  return { watchers, firstAttemptId, scheduled, current: store.getTask('t1') };
}

// A continue opens a new attempt; both missing and stale IDs must be rejected.
test('after an automatic continue the assignee must use the new attempt id', async () => {
  const wiring = setup();
  const { store, adapter, service } = wiring;
  const { firstAttemptId, scheduled } = await failOnceAndContinue(wiring);
  assert.equal(store.getTask('t1').status, 'in_progress');
  assert.ok(scheduled.attemptId && scheduled.attemptId !== firstAttemptId, 'the continue opened a new attempt');

  const sent = continueSends(adapter).at(-1);
  assert.ok(sent, 'the continue message was sent');
  assert.match(sent.input.message, new RegExp(`Attempt id: ${scheduled.attemptId}`),
    'the continue prompt carries the freshly opened attempt id');
  assert.doesNotMatch(sent.input.message, /omit attempt_id/);

  const impl = store.listMembers('alpha').find((member) => member.name === 'impl');
  const memberToken = store.getMemberToken(impl.id);
  const app = createApp({ store, service, token: 'captain-secret' });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}`;
  const updateHttp = (token, body) => fetch(`${base}/api/v1/teams/alpha/tasks/t1/update`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    // The id the member was told before the continue is stale and stays stale.
    const stale = await updateHttp(memberToken, { attemptId: firstAttemptId, status: 'completed', output: 'stale id' });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'E_STALE_ATTEMPT');
    assert.equal(store.getTask('t1').status, 'in_progress');
    const missing = await updateHttp(memberToken, { status: 'completed', output: 'late response without id' });
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).error.code, 'E_STALE_ATTEMPT');
    assert.equal(store.getTask('t1').attemptId, scheduled.attemptId);

    const handle = createMcpHandler({
      baseUrl: base, token: memberToken, defaultTeam: 'alpha', defaultMember: impl.name,
    });
    const claim = await handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'agent_teams_claim_task', arguments: { team_id: 'alpha', task_id: 't1' } },
    });
    assert.equal(claim.result.isError, true);

    const done = await handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'agent_teams_update_task',
        arguments: { team_id: 'alpha', task_id: 't1', status: 'completed', output: 'done after continue' },
      },
    });
    assert.equal(done.result.isError, true);
    assert.equal(store.getTask('t1').status, 'in_progress');
    const doneWithAttempt = await handle({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'agent_teams_update_task',
        arguments: { team_id: 'alpha', task_id: 't1', attempt_id: scheduled.attemptId, status: 'completed', output: 'done after continue' },
      },
    });
    assert.equal(doneWithAttempt.result.isError, false, doneWithAttempt.result.content?.[0]?.text);

    const task = store.getTask('t1');
    assert.equal(task.status, 'completed');
    assert.equal(task.lastAttemptId, scheduled.attemptId, 'the resolved attempt is the one the continue opened');
    const attempt = store.listAttempts('alpha').find((item) => item.id === scheduled.attemptId);
    assert.equal(attempt.status, 'completed');
  } finally {
    await app.close();
    store.close();
  }
});

test('missing attempt ids are rejected even for the current assignee', async () => {
  const wiring = setup();
  const { store, service } = wiring;
  const { firstAttemptId, current } = await failOnceAndContinue(wiring);
  const implActor = memberActor(store, 'impl');
  const reviewerActor = memberActor(store, 'reviewer');

  // Heartbeat uses the same resolution as claim/update.
  assert.throws(() => service.heartbeatTask('alpha', 't1', undefined, implActor), /stale attempt/);
  const beat = service.heartbeatTask('alpha', 't1', current.attemptId, implActor);
  assert.equal(beat.attemptId, current.attemptId);
  assert.ok(beat.leaseExpiresAt > 0);

  // Another member cannot borrow the assignee's shortcut, with or without an id.
  await assert.rejects(
    () => service.updateTask('alpha', 't1', undefined, { status: 'completed', output: 'x' }, reviewerActor),
    (error) => error.status === 403 && error.code === 'E_FORBIDDEN',
  );
  await assert.rejects(
    () => service.updateTask('alpha', 't1', current.attemptId, { status: 'completed', output: 'x' }, reviewerActor),
    (error) => error.status === 403 && error.code === 'E_FORBIDDEN',
  );

  // The captain has no assignee shortcut either: an omitted id is stale.
  await assert.rejects(
    () => service.updateTask('alpha', 't1', undefined, { status: 'completed', output: 'x' }, { role: 'admin', name: 'captain' }),
    /stale attempt/,
  );

  // The HTTP route agrees: a reviewer token cannot write the task.
  const app = createApp({ store, service, token: 'captain-secret' });
  const port = await listenForFetch(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/teams/alpha/tasks/t1/update`, {
      method: 'POST',
      headers: { authorization: `Bearer ${store.getMemberToken(reviewerActor.memberId)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed', output: 'sneak in' }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'E_FORBIDDEN');
    assert.equal(store.getTask('t1').status, 'in_progress');
  } finally {
    await app.close();
  }

  // The assignee still cannot replay the pre-continue id.
  await assert.rejects(
    () => service.updateTask('alpha', 't1', firstAttemptId, { status: 'completed', output: 'x' }, implActor),
    /stale attempt/,
  );

  // A task without an open attempt is rejected even for the assignee.
  service.addTask('alpha', workTask('t2', 'second task', 'impl'));
  store.updateTask('t2', { status: 'in_progress', assignee: 'impl', attemptId: undefined });
  await assert.rejects(
    () => service.updateTask('alpha', 't2', undefined, { status: 'failed', output: 'x' }, implActor),
    /stale attempt: the task has no open attempt/,
  );

  // A terminal task is rejected before any resolution and maps to 409 E_STATE.
  const live = store.getTask('t1');
  await service.updateTask('alpha', 't1', live.attemptId, { status: 'failed', output: 'stop' }, implActor);
  assert.equal(store.getTask('t1').status, 'failed');
  await assert.rejects(
    () => service.updateTask('alpha', 't1', undefined, { status: 'completed', output: 'x' }, implActor),
    /already terminal/,
  );
  const terminalApp = createApp({ store, service, token: 'captain-secret' });
  const terminalPort = await listenForFetch(terminalApp);
  try {
    const response = await fetch(`http://127.0.0.1:${terminalPort}/api/v1/teams/alpha/tasks/t1/update`, {
      method: 'POST',
      headers: { authorization: `Bearer ${store.getMemberToken(implActor.memberId)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed', output: 'after the end' }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'E_STATE');
  } finally {
    await terminalApp.close();
    store.close();
  }
});

// F2: a contractor record must declare `capabilities: ['task:continue']`.
// A missing list used to fail open.
test('a contractor without a declared capabilities list cannot continue', () => {
  const { store, service, now } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const contractor = store.addContractor({
    id: 'ctr_without_caps',
    teamId: 'alpha',
    slot: 'main',
    purpose: 'audit',
    mode: 'read-only',
    prompt: 'audit',
    status: 'running',
    queuedAt: now(),
    timeoutMs: 60000,
  });
  assert.equal(service.canContinueTask('alpha', { role: 'contractor', contractorId: contractor.id }), false);
  store.updateContractor(contractor.id, { capabilities: ['task:continue'] });
  assert.equal(service.canContinueTask('alpha', { role: 'contractor', contractorId: contractor.id }), true);
  store.close();
});

// F4: member-unavailable/cursor-unavailable/prompt-already-running used to
// retry every 5s until the two-hour lease expired, writing an event per tick.
test('continue deferrals are bounded and end the attempt instead of spinning', async () => {
  const wiring = setup();
  const { store, adapter, service, advance, now } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');
  watchers.at(-1).onFailed({ message: 'read ECONNRESET', code: 'ECONNRESET' });
  // The session cursor stays unavailable: the continue can never be sent.
  adapter.turnCursor = async () => { throw new Error('cursor is unavailable'); };
  let guard = 0;
  while (store.getTask('t1').status === 'in_progress' && guard < 80) {
    guard += 1;
    const task = store.getTask('t1');
    advance(Math.max(0, (task.retryNotBefore ?? now()) - now()));
    await service.tick('alpha');
  }
  const task = store.getTask('t1');
  assert.equal(task.status, 'failed');
  assert.match(task.error, /continue deferred too many times/);
  assert.equal(task.attemptId, undefined);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'task.continue_abandoned'));
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'task.continue_deferred').length, 60);
  store.close();
});

// F5: one continue-send failure must be pair-able, not double counted.
test('a failed continue send pairs its derived failure events with one correlation id', async () => {
  const wiring = setup();
  const { store, adapter, service, advance, now } = wiring;
  const watchers = failedTurnWiring(adapter);
  makeTeam(service);
  await service.tick('alpha');
  watchers.at(-1).onFailed({ message: 'read ECONNRESET', code: 'ECONNRESET' });
  const scheduled = store.getTask('t1');
  const send = adapter.send.bind(adapter);
  adapter.send = async (input) => {
    if (String(input.message).startsWith(CONTINUE_MESSAGE)) {
      throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    }
    return send(input);
  };
  advance(scheduled.retryNotBefore - now());
  await service.tick('alpha');

  const events = store.listEvents('alpha');
  const primary = events.find((event) => event.type === 'task.continue_failed');
  assert.ok(primary, 'the continue send failure is recorded');
  assert.equal(primary.primary, true);
  assert.ok(primary.correlationId);
  const derived = events.filter((event) => event.correlationId === primary.correlationId
    && ['task.turn_failed', 'task.continue_scheduled'].includes(event.type));
  assert.deepEqual(derived.map((event) => event.type).sort(), ['task.continue_scheduled', 'task.turn_failed']);
  for (const event of derived) {
    assert.equal(event.primary, false);
    assert.equal(event.causedBy, 'task.continue_failed');
  }
  store.close();
});
