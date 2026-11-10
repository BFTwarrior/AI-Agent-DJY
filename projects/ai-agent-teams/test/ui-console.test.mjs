import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/server.mjs';
import { buildUiConsole } from '../src/http/ui-console.mjs';
import { loadConfig } from '../src/config.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { Store } from '../src/store.mjs';
import { listenForFetch } from './support/listen.mjs';

const CONFIG_PATH = 'config/example.v06.json';
const VERSION = '9.9.9';
// Build the sample home paths at runtime so the fixture does not itself look
// like a disclosed user profile to secret/PII scanners.
const FAKE_HOME = ['C:', 'Users', 'BOT'].join('/');
const FAKE_SPACED_HOME = ['C:', 'Users', 'Operator Name'].join('/');

/**
 * One realistic team with:
 * - a running worker with an active session and a license,
 * - a settled idle worker,
 * - an open reviewer row,
 * - an active shadow,
 * - a task carrying merge/review/command/hold evidence,
 * - a plain completed task and an in-progress task that must stay out of the
 *   merge queue,
 * - one open and one closed finding,
 * - a pending mailbox message and an already approved one,
 * - a running merge contractor,
 * - a patrol timestamp/backlog.
 */
function makeFixture({ hostModel } = {}) {
  const { config } = loadConfig(CONFIG_PATH);
  const store = new Store(':memory:');
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter: new FakeSessionAdapter(),
    config,
    cwd: process.cwd(),
    now: () => 1000,
    ...(hostModel ? { hostModel } : {}),
  });
  service.createTeam({
    id: 'alpha',
    name: 'Alpha',
    phase: 'running',
    control: 'active',
    members: [{ name: 'a1' }, { name: 'a2' }, { name: 'rev', role: 'reviewer' }, { name: 'shadow', role: 'shadow' }],
  });

  service.addTask('alpha', { id: 't1', subject: 'deliver console', assignee: 'a1', kind: 'work' });
  service.addTask('alpha', { id: 't2', subject: 'plain in-progress work', assignee: 'a1', kind: 'work' });
  service.addTask('alpha', { id: 't3', subject: 'completed without merge fields', assignee: 'a2', kind: 'work' });
  service.addTask('alpha', {
    id: 't4', subject: 'review t1', assignee: 'rev', kind: 'review', reviewedTaskId: 't1',
    objective: 'review the delivered console projection', acceptance: ['the projection is checked'],
  });
  service.addTask('alpha', { id: 't5', subject: 'merge-state only', assignee: 'a1', kind: 'work' });
  service.addTask('alpha', { id: 't6', subject: 'hidden merge history', assignee: 'a1', kind: 'work' });

  store.updateTask('t1', {
    status: 'completed',
    priority: 'high',
    round: 2,
    assigneeRole: 'engineer',
    objective: 'build the read-only console projection',
    acceptance: ['shape is stable'],
    inScope: ['src/http'],
    outOfScope: ['assets'],
    verify: ['node --test'],
    output: 'implemented',
    lastError: '',
    mergeState: 'merged',
    mergeCommit: 'commit-merge-1',
    mergedCommit: 'commit-merge-1',
    integrationCommit: 'commit-integration-1',
    integrationBranch: 'integration/alpha/t1',
    reviewResult: { verdict: 'pass', overall: 4.5, code: 4.25, evidence: 'review evidence' },
    commandsRun: [{ command: 'node --test', status: 'passed', exitCode: 0, evidence: 'tests green' }],
    hold: { reason: 'awaiting merge', since: 2000 },
    findings: [{
      id: 'task-finding-1',
      severity: 'P2',
      problem: 'task problem',
      requiredFix: 'task fix',
      memberId: 'member-fixture',
      status: 'open',
      createdAt: 3000,
    }],
    worktree: 'C:/repo/.agent-teams-worktrees/alpha/t1',
    attempts: 2,
    attemptId: 'attempt-1',
    prompt: 'task-prompt-secret',
  });
  store.updateTask('t2', {
    status: 'in_progress',
    reviewResult: {
      verdict: 'pass',
      overall: 4,
      code: 4,
      evidence: 'review done',
      findings: [{
        id: 'review-finding-1',
        severity: 'P3',
        problem: 'review problem',
        requiredFix: 'review fix',
        memberId: 'member-review',
        status: 'open',
        createdAt: 3200,
      }],
      commandsRun: [{ command: 'review-node-test', status: 'passed', exitCode: 0, evidence: 'review commands' }],
    },
    prompt: 'task-prompt-secret-2',
  });
  store.updateTask('t3', { status: 'completed', objective: 'plain completed delivery' });
  store.updateTask('t4', { status: 'in_progress' });
  store.updateTask('t5', { status: 'completed', mergeState: 'review_pending', reviewVerdict: 'pass' });
  store.updateTask('t6', { status: 'completed', mergeState: 'merged', mergeCommit: 'hidden-commit', hidden: true });

  const a1 = store.findMember('alpha', 'a1');
  store.updateMember(a1.id, {
    sessionId: 'sess-a1-secret',
    status: 'working',
    residency: 'warm',
    workState: 'busy',
    workerSessionStart: { state: 'active' },
    model: 'deepseek-v4',
    reasoning: 'high',
    mode: 'bound',
    prompt: 'member-prompt-secret',
  });
  const a2 = store.findMember('alpha', 'a2');
  // Drop the member license snapshot: the projection must fall back to the
  // active license row instead of rendering an empty license.
  store.updateMember(a2.id, { status: 'unspawned', residency: 'hot', workState: 'available', license: null });
  const rev = store.findMember('alpha', 'rev');
  const shadow = store.findMember('alpha', 'shadow');
  store.updateMember(shadow.id, {
    sessionId: 'shadow-session-secret',
    shadowState: 'active',
    shadowStartedAt: 4000,
    shadowLastActiveAt: 4500,
  });

  store.updateTeam('alpha', {
    lastPatrolAt: 5000,
    patrolPending: false,
    patrolBacklog: ['patrol-1', 'patrol-2'],
    token: 'team-token-secret',
    prompt: 'team-prompt-secret',
  });
  service.patrolInFlight.add('alpha');

  store.addFinding({
    id: 'finding-open',
    teamId: 'alpha',
    severity: 'P1',
    problem: 'open problem',
    requiredFix: 'fix it',
    memberId: a1.id,
    status: 'open',
    createdAt: 3000,
    token: 'finding-token-secret',
  });
  store.addFinding({
    id: 'finding-closed',
    teamId: 'alpha',
    severity: 'P2',
    problem: 'closed problem',
    requiredFix: 'none',
    memberId: a1.id,
    status: 'closed',
    createdAt: 3100,
  });

  store.addMessage({
    id: 'message-1',
    teamId: 'alpha',
    from: 'a1',
    to: 'captain',
    content: 'pending approval',
    approvalState: 'pending_captain',
    urgent: true,
    createdAt: 6000,
    token: 'message-token-secret',
    sessionId: 'message-session-secret',
    licenseId: 'message-license-secret',
  });
  store.addMessage({
    id: 'message-2',
    teamId: 'alpha',
    from: 'a1',
    to: 'captain',
    content: 'already approved',
    approvalState: 'approved',
  });

  store.addEvent('alpha', 'console.probe', {
    taskId: 't1',
    message: 'event payload',
    count: 2,
    token: 'event-token-secret',
    uiToken: 'event-ui-token-secret',
    adminToken: 'event-admin-token-secret',
  });

  store.addContractor({
    id: 'contractor-1',
    teamId: 'alpha',
    slot: 'merge',
    purpose: 'post_merge_review',
    status: 'running',
    createdAt: 700,
    updatedAt: 800,
    errorCode: 'E_PROBE',
    lastError: 'contractor failed once',
    result: 'verdict: pass',
    token: 'contractor-token-secret',
  });

  return {
    config,
    store,
    service,
    ids: {
      a1: a1.id,
      a2: a2.id,
      rev: rev.id,
      shadow: shadow.id,
      license: a1.license.id,
      memberToken: store.getMemberToken(a1.id),
    },
  };
}

function findForbiddenKeys(value, forbidden, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, forbidden, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) found.push(`${path}.${key}`);
    findForbiddenKeys(child, forbidden, `${path}.${key}`, found);
  }
  return found;
}

function consoleFor(fixture, overrides = {}) {
  return buildUiConsole({
    store: fixture.store,
    service: fixture.service,
    version: VERSION,
    ...overrides,
  });
}

test('buildUiConsole projects version, health, capacity, limits, model and shadow', () => {
  const fixture = makeFixture();
  try {
    const data = consoleFor(fixture, {
      workspace: 'C:/fixture/workspace', instanceId: 'instance-1', pid: 4242,
    });
    assert.equal(data.version, VERSION);
    assert.equal(typeof data.generatedAt, 'number');
    assert.deepEqual(data.health, {
      status: 'ok',
      version: VERSION,
    }, 'the console health block never exposes workspace, instanceId or pid');

    const { config } = fixture;
    assert.deepEqual(data.capacity, {
      workerSlots: config.scheduler.activeWorkerSlots,
      maxActivePerTeam: config.scheduler.maxActivePerTeam,
      maxControlSessions: config.scheduler.maxControlSessions,
      maxTotalSessions: config.scheduler.maxTotalSessions,
      contractorMaxConcurrent: config.contractors.maxConcurrent,
    });
    assert.deepEqual(data.limits, {
      maxTurnsPerTask: config.scheduler.maxTurnsPerTask,
      taskTimeoutMinutes: config.scheduler.taskTimeoutMinutes,
      idleSessionMinutes: config.scheduler.idleSessionMinutes,
      maxRequestsPerMinute: config.zcode.maxRequestsPerMinute,
      patrolTimeoutMinutes: config.patrol.timeoutMinutes,
    });

    assert.equal(data.model.policy.mode, 'follow-host');
    assert.deepEqual(data.model.defaults, {
      model: config.zcode.defaultModel ?? null,
      reasoning: config.zcode.defaultReasoning ?? null,
    });
    assert.ok(data.model.host && typeof data.model.host === 'object');

    assert.equal(data.shadow.exists, true);
    assert.equal(data.shadow.status, 'active');
    assert.equal(data.shadow.active, true);
    assert.equal(data.shadow.memberId, fixture.ids.shadow);
    assert.equal(data.shadow.teamId, 'alpha');
    assert.equal(data.shadow.name, 'shadow');
    assert.equal(data.shadow.startedAt, 4000);
    assert.equal(data.shadow.stoppedAt, null);
    assert.equal(data.shadow.lastActiveAt, 4500);
    assert.equal(data.shadow.lastError, null);
    assert.equal(data.teams.length, 1);

    const bare = buildUiConsole({ store: fixture.store, service: fixture.service, version: VERSION });
    assert.deepEqual(bare.health, { status: 'ok', version: VERSION });
  } finally {
    fixture.store.close();
  }
});

test('buildUiConsole projects the resolved localization and falls back to detection', () => {
  const fixture = makeFixture();
  try {
    const data = consoleFor(fixture);
    assert.deepEqual(data.localization, {
      locale: fixture.config.zcode.locale,
      timeZone: fixture.config.zcode.timezone,
    });

    const missing = buildUiConsole({
      store: fixture.store,
      service: { config: { zcode: { locale: 'auto', timezone: 'auto' } } },
      version: VERSION,
    });
    assert.match(missing.localization.locale, /^(zh-CN|ja-JP|ko-KR|en-US)$/);
    assert.ok(missing.localization.timeZone.length > 0);

    const unsupported = buildUiConsole({
      store: fixture.store,
      service: { config: { zcode: { locale: 'de-DE', timezone: 'Not/AZone' } } },
      version: VERSION,
    });
    assert.match(unsupported.localization.locale, /^(zh-CN|ja-JP|ko-KR|en-US)$/);
    assert.ok(unsupported.localization.timeZone.length > 0);
  } finally {
    fixture.store.close();
  }
});

test('buildUiConsole projects team phase/control, capacity, slots, members, tasks, findings, patrol, mailbox and events', () => {
  const fixture = makeFixture();
  try {
    const data = consoleFor(fixture);
    const team = data.teams[0];
    assert.equal(team.id, 'alpha');
    assert.equal(team.name, 'Alpha');
    assert.equal(team.phase, 'running');
    assert.equal(team.control, 'active');

    assert.deepEqual(team.capacity, {
      workerSlots: fixture.config.scheduler.activeWorkerSlots,
      maxActivePerTeam: fixture.config.scheduler.maxActivePerTeam,
      maxControlSessions: fixture.config.scheduler.maxControlSessions,
      maxTotalSessions: fixture.config.scheduler.maxTotalSessions,
      activeWorkers: 1,
      activeContractors: 1,
      sessions: 3,
      hot: 1,
      warm: 1,
      cold: 2,
      archived: 0,
    });

    assert.deepEqual(team.contractorSlots, [
      { slot: 'merge', cap: 1, active: 1, queued: 0 },
      { slot: 'main', cap: 1, active: 0, queued: 0 },
    ]);

    const members = new Map(team.members.map((member) => [member.name, member]));
    assert.deepEqual([...members.keys()].sort(), ['a1', 'a2', 'rev', 'shadow']);

    const a1 = members.get('a1');
    assert.equal(a1.id, fixture.ids.a1);
    assert.equal(a1.label, 'a1');
    assert.equal(a1.role, 'engineer');
    assert.equal(a1.status, 'working');
    assert.equal(a1.residency, 'warm');
    assert.equal(a1.workState, 'busy');
    assert.equal(a1.currentTask, 't2');
    assert.equal(a1.taskCount, 3);
    assert.equal(a1.doneCount, 2);
    assert.equal(a1.hasSession, true);
    assert.equal(a1.sessionState, 'active');
    assert.equal(a1.mode, 'bound');
    assert.equal(a1.model, 'deepseek-v4');
    assert.equal(a1.reasoning, 'high');
    assert.deepEqual(a1.license, { label: 'a1', roleKey: 'engineer', status: 'active' });
    assert.equal(a1.settlement.settled, false);
    assert.equal(a1.settlement.blockerCount, a1.settlement.blockers.length);
    assert.ok(a1.settlement.blockers.length > 0);

    const a2 = members.get('a2');
    assert.equal(a2.hasSession, false);
    assert.equal(a2.sessionState, 'none');
    assert.equal(a2.residency, 'hot');
    assert.equal(a2.currentTask, null);
    assert.equal(a2.taskCount, 1);
    assert.equal(a2.doneCount, 1);
    assert.deepEqual(a2.license, { label: 'a2', roleKey: 'engineer', status: 'active' });
    assert.deepEqual(a2.settlement, { settled: true, blockerCount: 0, blockers: [] });

    const rev = members.get('rev');
    assert.equal(rev.role, 'reviewer');
    assert.equal(rev.currentTask, 't4');
    assert.equal(rev.taskCount, 1);
    assert.equal(rev.doneCount, 0);
    assert.equal(rev.hasSession, false);
    assert.equal(rev.settlement.settled, false);

    const shadow = members.get('shadow');
    assert.equal(shadow.role, 'shadow');
    assert.equal(shadow.hasSession, true);
    assert.equal(shadow.sessionState, 'active');
    assert.equal(shadow.taskCount, 0);

    const tasks = new Map(team.tasks.map((task) => [task.id, task]));
    assert.deepEqual([...tasks.keys()], ['t1', 't2', 't3', 't4', 't5'], 'hidden tasks are filtered out');

    const t1 = tasks.get('t1');
    assert.equal(t1.subject, 'deliver console');
    assert.equal(t1.status, 'completed');
    assert.equal(t1.kind, 'work');
    assert.equal(t1.deliveryState, 'completed');
    assert.equal(t1.visual, 'completed');
    assert.equal(t1.priority, 'high');
    assert.equal(t1.round, 2);
    assert.deepEqual(t1.dependencies, []);
    assert.equal(t1.assignee, 'a1');
    assert.equal(t1.assigneeRole, 'engineer');
    assert.equal(t1.objective, 'build the read-only console projection');
    assert.deepEqual(t1.acceptance, ['shape is stable']);
    assert.deepEqual(t1.inScope, ['src/http']);
    assert.deepEqual(t1.outOfScope, ['assets']);
    assert.deepEqual(t1.verify, ['node --test']);
    assert.equal(t1.output, 'implemented');
    assert.equal(t1.lastError, '');
    assert.equal(t1.mergeState, 'merged');
    assert.equal(t1.mergeCommit, 'commit-merge-1');
    assert.equal(t1.mergedCommit, 'commit-merge-1');
    assert.equal(t1.integrationCommit, 'commit-integration-1');
    assert.equal(t1.integrationBranch, 'integration/alpha/t1');
    assert.deepEqual(t1.review, { verdict: 'pass', overall: 4.5, code: 4.25, evidence: 'review evidence' });
    assert.deepEqual(t1.findings, [{
      id: 'task-finding-1',
      severity: 'P2',
      problem: 'task problem',
      requiredFix: 'task fix',
      memberId: 'member-fixture',
      status: 'open',
      createdAt: 3000,
    }]);
    assert.deepEqual(t1.commandsRun, [{
      command: 'node --test', status: 'passed', exitCode: 0, evidence: 'tests green',
    }]);
    assert.deepEqual(t1.hold, { reason: 'awaiting merge', since: 2000 });
    assert.equal(t1.attemptCount, 2);
    assert.equal(t1.hasActiveAttempt, true);
    assert.equal(t1.worktree, '<path>', 'absolute worktree paths are redacted');
    assert.equal(t1.hidden, false);
    assert.equal(t1.createdAt, 1000);
    assert.equal(typeof t1.updatedAt, 'number');

    const t2 = tasks.get('t2');
    assert.equal(t2.status, 'in_progress');
    assert.equal(t2.deliveryState, 'running');
    assert.equal(t2.visual, 'running');
    assert.equal(t2.review.verdict, 'pass');
    assert.equal(t2.mergeState, null);
    assert.equal(t2.mergeCommit, null);
    assert.deepEqual(t2.findings, [{
      id: 'review-finding-1',
      severity: 'P3',
      problem: 'review problem',
      requiredFix: 'review fix',
      memberId: 'member-review',
      status: 'open',
      createdAt: 3200,
    }]);
    assert.deepEqual(t2.commandsRun, [{
      command: 'review-node-test', status: 'passed', exitCode: 0, evidence: 'review commands',
    }], 'commandsRun falls back to the review evidence');
    assert.equal(t2.hold, null);
    assert.equal(t2.attemptCount, null);
    assert.equal(t2.hasActiveAttempt, false);

    assert.equal(tasks.get('t4').kind, 'review');
    assert.equal(tasks.get('t4').status, 'in_progress');
    assert.equal(tasks.get('t5').mergeState, 'review_pending');
    assert.equal(tasks.get('t5').mergeCommit, null);
    assert.deepEqual(tasks.get('t5').review, { verdict: 'pass' }, 'reviewVerdict is the shallow fallback');

    assert.deepEqual(team.findings, [{
      id: 'finding-open',
      severity: 'P1',
      problem: 'open problem',
      requiredFix: 'fix it',
      memberId: fixture.ids.a1,
      status: 'open',
      createdAt: 3000,
    }]);

    const patrolInterval = fixture.config.patrol.intervalMinutes;
    assert.deepEqual(team.patrol, {
      enabled: true,
      intervalMinutes: patrolInterval,
      lastAt: 5000,
      nextAt: 5000 + patrolInterval * 60000,
      inFlight: true,
      pending: true,
      backlogCount: 2,
    });

    assert.deepEqual(team.mailbox, [{
      id: 'message-1',
      from: 'a1',
      to: 'captain',
      fromTeamId: 'alpha',
      toTeamId: 'alpha',
      taskId: null,
      urgent: true,
      approvalState: 'pending_captain',
      content: 'pending approval',
      createdAt: 6000,
    }]);

    assert.deepEqual(team.contractors, [{
      id: 'contractor-1',
      slot: 'merge',
      purpose: 'post_merge_review',
      status: 'running',
      createdAt: 700,
      updatedAt: 800,
      errorCode: 'E_PROBE',
      lastError: 'contractor failed once',
      result: 'verdict: pass',
    }]);

    assert.ok(team.events.length > 0);
    for (const event of team.events) {
      assert.equal(typeof event.id, 'number');
      assert.equal(typeof event.type, 'string');
      assert.equal(typeof event.data, 'object');
      assert.equal('createdAt' in event, true);
      assert.equal('teamId' in event, true);
    }
    const probe = team.events.find((event) => event.type === 'console.probe');
    assert.ok(probe, 'the probe event is part of the event tail');
    assert.deepEqual(probe.data, { taskId: 't1', message: 'event payload', count: 2 });

    assert.equal(typeof team.redReviews, 'object');
    assert.equal(team.redReviews.enabled, true);
    assert.equal(team.redReviews.total, 0);
  } finally {
    fixture.store.close();
  }
});

test('buildUiConsole keeps team projections free of tokens, license ids, session ids and prompts', () => {
  const fixture = makeFixture();
  try {
    const data = consoleFor(fixture);
    const team = data.teams[0];

    const forbidden = new Set(['token', 'uiToken', 'adminToken', 'licenseId', 'sessionId', 'prompt']);
    assert.deepEqual(findForbiddenKeys(team, forbidden), []);
    for (const section of ['health', 'capacity', 'limits', 'shadow']) {
      assert.deepEqual(findForbiddenKeys(data[section], forbidden), [], `${section} must stay credential-free`);
    }
    assert.deepEqual(findForbiddenKeys(data.model, forbidden), [], 'the whitelisted model block must stay credential-free');
    assert.deepEqual(findForbiddenKeys(data.model.policy, forbidden), []);
    assert.deepEqual(findForbiddenKeys(data.model.defaults, forbidden), []);
    assert.deepEqual(findForbiddenKeys(data, forbidden), [], 'the whole console projection must stay credential-free');

    const serialized = JSON.stringify(data);
    const markers = [
      fixture.ids.memberToken,
      fixture.ids.license,
      'sess-a1-secret',
      'shadow-session-secret',
      'member-prompt-secret',
      'task-prompt-secret',
      'message-token-secret',
      'message-session-secret',
      'message-license-secret',
      'event-token-secret',
      'event-ui-token-secret',
      'event-admin-token-secret',
      'finding-token-secret',
      'contractor-token-secret',
      'team-token-secret',
      'team-prompt-secret',
    ];
    for (const marker of markers) {
      assert.equal(serialized.includes(marker), false, `console leaked ${marker}`);
    }

    for (const member of team.members) {
      assert.equal('sessionId' in member, false);
      assert.equal('licenseId' in member, false);
      assert.equal('prompt' in member, false);
    }
    const a1 = team.members.find((member) => member.name === 'a1');
    assert.equal(a1.id, fixture.ids.a1, 'the internal member id is allowed');
    assert.deepEqual(Object.keys(a1.license).sort(), ['label', 'roleKey', 'status']);

    const t1 = team.tasks.find((task) => task.id === 't1');
    assert.equal('prompt' in t1, false);
    assert.equal(t1.findings[0].memberId, 'member-fixture');

    const message = team.mailbox[0];
    assert.equal('token' in message, false);
    assert.equal('sessionId' in message, false);
    assert.equal('licenseId' in message, false);

    const probe = team.events.find((event) => event.type === 'console.probe');
    assert.equal('token' in probe.data, false);
    assert.equal('uiToken' in probe.data, false);
    assert.equal('adminToken' in probe.data, false);
  } finally {
    fixture.store.close();
  }
});

test('buildUiConsole mergeQueue only carries merge state/commit or completed deliveries', () => {
  const fixture = makeFixture();
  try {
    const data = consoleFor(fixture);
    const team = data.teams[0];
    const queue = team.mergeQueue;

    assert.deepEqual(queue.map((task) => task.id), ['t1', 't3', 't5']);

    const t1 = queue.find((task) => task.id === 't1');
    assert.equal(t1.mergeState, 'merged');
    assert.equal(t1.mergeCommit, 'commit-merge-1');

    const t3 = queue.find((task) => task.id === 't3');
    assert.equal(t3.mergeState, null);
    assert.equal(t3.mergeCommit, null);
    assert.equal(t3.status, 'completed');
    assert.equal(t3.deliveryState, 'completed');

    const t5 = queue.find((task) => task.id === 't5');
    assert.equal(t5.mergeState, 'review_pending');

    assert.equal(queue.some((task) => task.id === 't2'), false, 'an in-progress reviewed task is not a merge candidate');
    assert.equal(queue.some((task) => task.id === 't4'), false, 'an open review task is not a merge candidate');
    assert.equal(queue.some((task) => task.id === 't6'), false, 'a hidden task stays out of the live projection');
    assert.equal(team.tasks.some((task) => task.id === 't6'), false);

    for (const task of queue) {
      const qualifies = Boolean(task.mergeState)
        || Boolean(task.mergeCommit)
        || Boolean(task.mergedCommit)
        || Boolean(task.integrationCommit)
        || (task.status === 'completed' && task.deliveryState === 'completed');
      assert.equal(qualifies, true, `${task.id} does not qualify for the merge queue`);
    }
  } finally {
    fixture.store.close();
  }
});

test('GET /api/v1/ui/console is read-only for the ui/admin token and keeps the snapshot available', async () => {
  const fixture = makeFixture();
  const { store, service } = fixture;
  const app = createApp({
    store,
    service,
    token: 'admin-secret-token',
    uiToken: 'ui-view-token',
    uiAccessKey: '',
    version: VERSION,
  });
  const port = await listenForFetch(app);
  const base = `http://127.0.0.1:${port}/api/v1`;
  try {
    const anonymous = await fetch(`${base}/ui/console`);
    assert.equal(anonymous.status, 401);
    const anonymousBody = await anonymous.json();
    assert.equal(anonymousBody.ok, false);
    assert.equal(anonymousBody.error.code, 'E_AUTH');

    const response = await fetch(`${base}/ui/console`, {
      headers: { authorization: 'Bearer ui-view-token' },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.error, null);
    const data = payload.data;
    assert.deepEqual(Object.keys(data).sort(), [
      'capacity', 'generatedAt', 'health', 'limits', 'localization', 'model', 'shadow', 'teams', 'version',
    ]);
    assert.equal(data.version, VERSION);
    assert.equal(data.health.status, 'ok');
    assert.equal(data.health.version, VERSION);
    assert.equal(data.capacity.workerSlots, fixture.config.scheduler.activeWorkerSlots);

    const team = data.teams[0];
    assert.equal(team.id, 'alpha');
    assert.equal(team.phase, 'running');
    assert.equal(team.control, 'active');
    assert.equal(team.members.find((member) => member.name === 'a1').hasSession, true);
    assert.deepEqual(team.mergeQueue.map((task) => task.id), ['t1', 't3', 't5']);
    assert.equal(team.patrol.intervalMinutes, fixture.config.patrol.intervalMinutes);
    assert.equal(team.mailbox[0].id, 'message-1');
    assert.ok(team.events.some((event) => event.type === 'console.probe'));

    const raw = JSON.stringify(payload);
    assert.equal(raw.includes(fixture.ids.memberToken), false);
    assert.equal(raw.includes(fixture.ids.license), false);
    assert.equal(raw.includes('sess-a1-secret'), false);
    assert.equal(raw.includes('ui-view-token'), false);
    assert.equal(raw.includes('admin-secret-token'), false);

    const memberResponse = await fetch(`${base}/ui/console`, {
      headers: { authorization: `Bearer ${fixture.ids.memberToken}` },
    });
    assert.equal(memberResponse.status, 403, 'a member token cannot read the aggregate console');
    const memberBody = await memberResponse.json();
    assert.equal(memberBody.error.code, 'E_FORBIDDEN');

    const adminResponse = await fetch(`${base}/ui/console`, {
      headers: { authorization: 'Bearer admin-secret-token' },
    });
    assert.equal(adminResponse.status, 200);

    const snapshot = await fetch(`${base}/ui/snapshot`, {
      headers: { authorization: 'Bearer ui-view-token' },
    });
    assert.equal(snapshot.status, 200);
    const snapshotData = (await snapshot.json()).data;
    assert.equal(snapshotData.version, VERSION);
    assert.equal(snapshotData.teams[0].id, 'alpha');
    assert.equal(snapshotData.teams[0].tasks.some((task) => task.id === 't6'), false);

    assert.equal((await fetch(`${base}/ui/snapshot`)).status, 401);
    assert.equal((await fetch(`${base}/ui/snapshot`, {
      headers: { authorization: `Bearer ${fixture.ids.memberToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/teams/alpha`, {
      headers: { authorization: 'Bearer ui-view-token' },
    })).status, 403, 'the ui token is limited to snapshot/console/stream');
  } finally {
    await app.close();
    store.close();
  }
});

test('buildUiConsole whitelists the host model and never leaks the host session id', () => {
  const fixture = makeFixture({
    hostModel: () => ({
      model: 'host-model-7',
      reasoning: 'max',
      source: 'host',
      sessionId: 'secret-session',
      sessionSource: 'env',
    }),
  });
  try {
    const data = consoleFor(fixture);
    assert.deepEqual(data.model.host, {
      model: 'host-model-7',
      reasoning: 'max',
      source: 'host',
      sessionSource: 'env',
    });
    assert.equal('sessionId' in data.model.host, false);
    assert.equal(data.model.host.sessionId, undefined);
    assert.equal('members' in data.model, false, 'modelStatus.members is not part of the read-only model block');
    assert.equal(JSON.stringify(data).includes('secret-session'), false, 'the host session id leaked into the console');

    const forbidden = new Set(['token', 'uiToken', 'adminToken', 'licenseId', 'sessionId', 'prompt']);
    assert.deepEqual(findForbiddenKeys(data, forbidden), []);
  } finally {
    fixture.store.close();
  }
});

test('buildUiConsole strips session/token keys from events while keeping createdAt, teamId and ids', () => {
  const fixture = makeFixture();
  try {
    fixture.store.addEvent('alpha', 'member.session_reset', {
      sessionId: 'event-secret',
      token: 'tok',
      message: 'visible payload',
      nested: { sessionId: 'nested-event-secret', token: 'nested-tok', note: 'keep-me' },
    });
    const data = consoleFor(fixture);
    const events = data.teams[0].events;
    const reset = events.find((event) => event.type === 'member.session_reset');
    assert.ok(reset, 'the new event is part of the console event tail');
    assert.equal(typeof reset.id, 'number');
    assert.ok(reset.id > 0);
    assert.equal(typeof reset.createdAt, 'number');
    assert.ok(reset.createdAt > 0, 'createdAt must come from the store row');
    assert.equal(reset.teamId, 'alpha');
    assert.deepEqual(Object.keys(reset).sort(), ['createdAt', 'data', 'id', 'teamId', 'type']);
    assert.equal('sessionId' in reset, false);
    assert.equal('token' in reset, false);
    assert.deepEqual(reset.data, {
      message: 'visible payload',
      nested: { note: 'keep-me' },
    });

    const forbidden = new Set(['token', 'uiToken', 'adminToken', 'licenseId', 'sessionId', 'prompt']);
    assert.deepEqual(findForbiddenKeys(reset, forbidden), []);

    const serialized = JSON.stringify(events);
    for (const marker of ['event-secret', 'nested-event-secret', '"tok"', '"nested-tok"']) {
      assert.equal(serialized.includes(marker), false, `event tail leaked ${marker}`);
    }
  } finally {
    fixture.store.close();
  }
});

test('buildUiConsole truncates deeply nested event payloads instead of stringifying secrets', () => {
  const fixture = makeFixture();
  try {
    fixture.store.addEvent('alpha', 'probe', {
      shallow: { keep: 'visible' },
      deep: { deeper: { sessionId: 'deep-secret', token: 'deep-token' } },
      list: [{ one: { two: { licenseId: 'deep-license' } } }],
    });
    const data = consoleFor(fixture);
    const events = data.teams[0].events;
    const probe = events.find((event) => event.type === 'probe');
    assert.ok(probe, 'the deep event is part of the console event tail');
    assert.equal(probe.data.shallow.keep, 'visible');
    assert.deepEqual(probe.data.deep.deeper, {}, 'private keys are stripped at every level');
    assert.equal(probe.data.list[0].one, '[truncated]');

    const serialized = JSON.stringify(events);
    for (const marker of ['deep-secret', 'deep-token', 'deep-license']) {
      assert.equal(serialized.includes(marker), false, `deep event payload leaked ${marker}`);
    }
  } finally {
    fixture.store.close();
  }
});

test('buildUiConsole keeps explicit null review scores null instead of zero', () => {
  const fixture = makeFixture();
  try {
    fixture.store.updateTask('t1', {
      reviewResult: { verdict: 'pass', overall: null, code: null, evidence: '' },
    });
    const data = consoleFor(fixture);
    const tasks = new Map(data.teams[0].tasks.map((task) => [task.id, task]));

    const t1 = tasks.get('t1');
    assert.deepEqual(t1.review, { verdict: 'pass', overall: null, code: null, evidence: '' });
    assert.strictEqual(t1.review.overall, null);
    assert.strictEqual(t1.review.code, null);

    const t2 = tasks.get('t2');
    assert.equal(t2.review.overall, 4, 'real review scores survive the projection');
    assert.equal(t2.review.code, 4);

    const t5 = tasks.get('t5');
    assert.equal(t5.review.verdict, 'pass');
    assert.equal('overall' in t5.review, false, 'the shallow reviewVerdict fallback does not invent scores');
    assert.equal('code' in t5.review, false);
  } finally {
    fixture.store.close();
  }
});

test('buildUiConsole redacts home and absolute paths inside event payloads', () => {
  const fixture = makeFixture();
  try {
    fixture.store.addEvent('alpha', 'member.home_cleanup_failed', {
      home: `${FAKE_HOME}/.agent-teams-homes/alpha/m1`,
      spacedHome: `${FAKE_SPACED_HOME}/.agent-teams-homes/alpha/m1`,
      from: 'D:/repo/.agent-teams-worktrees/alpha/t1',
      to: 'D:/repo/.agent-teams-worktrees/alpha/t2',
      license: { id: 'license-inner-secret', label: 'A-01' },
      note: 'keep-me',
    });
    const data = consoleFor(fixture);
    const event = data.teams[0].events.find((item) => item.type === 'member.home_cleanup_failed');
    assert.ok(event, 'the cleanup event is in the tail');
    assert.equal(event.data.home, '<path>');
    assert.equal(event.data.spacedHome, '<path>', 'a user folder with a space is redacted whole');
    assert.equal(event.data.from, '<path>');
    assert.equal(event.data.to, '<path>');
    assert.deepEqual(event.data.license, { label: 'A-01' }, 'nested license ids are stripped');
    assert.equal(event.data.note, 'keep-me');

    const serialized = JSON.stringify(data);
    for (const marker of ['BOT', 'D:/repo', '.agent-teams-homes', '.agent-teams-worktrees', 'license-inner-secret']) {
      assert.equal(serialized.includes(marker), false, `console leaked ${marker}`);
    }
  } finally {
    fixture.store.close();
  }
});

test('buildUiConsole keeps the newest tasks and resolves dependencies against the full set', () => {
  const fixture = makeFixture();
  try {
    for (let index = 0; index < 205; index += 1) {
      fixture.service.addTask('alpha', {
        id: `bulk-${String(index).padStart(3, '0')}`,
        subject: `bulk task ${index}`,
        kind: 'work',
        assignee: 'a1',
      });
    }
    fixture.store.updateTask('bulk-204', { status: 'in_progress' });
    fixture.store.updateTask('bulk-203', {
      status: 'completed', deliveryState: 'completed', mergeState: 'merged', mergedCommit: 'bulk-commit',
    });
    const data = consoleFor(fixture);
    const team = data.teams.find((item) => item.id === 'alpha');
    assert.equal(team.tasks.length, 200);
    assert.equal(team.tasks.at(-1).id, 'bulk-204', 'the newest task is inside the window');
    assert.equal(team.tasks.some((task) => task.id === 't1'), false, 'the oldest tasks fall out first');
    assert.ok(team.mergeQueue.some((task) => task.id === 'bulk-203'), 'a recent merge stays in the queue');

    const a1 = team.members.find((member) => member.name === 'a1');
    assert.equal(a1.taskCount, 208, 'member counters use the untruncated task set');
    assert.equal(a1.doneCount, 3);
  } finally {
    fixture.store.close();
  }
});

test('buildUiConsole assigns a cross-team message only to the receiving team', () => {
  const fixture = makeFixture();
  try {
    fixture.service.createTeam({ id: 'beta', name: 'Beta' });
    fixture.store.addMessage({
      id: 'cross-team-1',
      teamId: 'beta',
      fromTeamId: 'alpha',
      from: 'a1',
      to: 'captain',
      content: 'contract change',
      crossTeam: true,
      approvalState: 'pending_captain',
      createdAt: 6100,
    });
    const data = consoleFor(fixture);
    const alpha = data.teams.find((team) => team.id === 'alpha');
    const beta = data.teams.find((team) => team.id === 'beta');
    assert.equal(alpha.mailbox.some((message) => message.id === 'cross-team-1'), false);
    assert.equal(beta.mailbox.filter((message) => message.id === 'cross-team-1').length, 1);
  } finally {
    fixture.store.close();
  }
});

