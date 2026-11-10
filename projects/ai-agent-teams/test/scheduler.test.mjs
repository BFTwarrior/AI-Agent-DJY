import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import {
  allocateSlots,
  isLeaseExpired,
  memberPermissionMode,
  nextReady,
  priorityBand,
  taskVisualState,
  validateTaskGraph,
} from '../src/domain/scheduler.mjs';
import { deriveRepairScope, findingsFingerprint, planFollowUp } from '../src/domain/gates.mjs';

const config = JSON.parse(readFileSync('config/example.two-teams.json', 'utf8'));
const tasks = JSON.parse(readFileSync('examples/tasks.sample.json', 'utf8')).tasks;
const roster = JSON.parse(readFileSync('config/roster.two-teams.json', 'utf8'));
const rosterMembers = Object.entries(roster.teams).flatMap(([teamId, list]) => list.map((member) => ({ ...member, teamId })));
const teamIds = config.teams.map((team) => team.id);

function countByTeam(dispatch) {
  return dispatch.reduce((acc, item) => {
    acc[item.teamId] = (acc[item.teamId] ?? 0) + 1;
    return acc;
  }, {});
}

test('nextReady excludes archived, historical, superseded and held tasks', () => {
  const base = { kind: 'review', status: 'pending', dependencies: [] };
  const rows = [
    { ...base, id: 'current' },
    { ...base, id: 'archived', archived: true },
    { ...base, id: 'historical', historical: true },
    { ...base, id: 'superseded', cancelReason: 'superseded' },
    { ...base, id: 'held', hold: { class: 'legacy_unbound' } },
    { ...base, id: 'old-red', legacyRedReview: true },
  ];
  assert.deepEqual(nextReady(rows).map((task) => task.id), ['current']);
});

test('a preempted task is not demoted to the retry band', () => {
  const task = { id: 'p1', kind: 'work', status: 'pending', priority: 'normal', attempt: 2, preempted: true };
  assert.equal(priorityBand(task, [task]), 1, 'preemption is not a retry');
  assert.equal(priorityBand({ ...task, preempted: false }, [{ ...task, preempted: false }]), 0);
});

test('sample task graph is valid', () => {
  assert.deepEqual(validateTaskGraph(tasks), []);
});

test('duplicate task ids are rejected', () => {
  const bad = [...tasks, { ...tasks[0], subject: 'duplicate' }];
  assert.match(validateTaskGraph(bad).join('\n'), /duplicate task id/);
});

test('dependency cycles are rejected', () => {
  const bad = [
    { id: 'a', teamId: 'alpha', subject: 'a', dependencies: ['b'], status: 'pending', kind: 'work' },
    { id: 'b', teamId: 'alpha', subject: 'b', dependencies: ['a'], status: 'pending', kind: 'work' },
  ];
  assert.match(validateTaskGraph(bad).join('\n'), /dependency cycle/);
});

test('initial ready set is six tasks', () => {
  const ready = nextReady(tasks);
  assert.equal(ready.length, 6);
  assert.equal(ready.filter((task) => task.teamId === 'alpha').length, 3);
  assert.equal(ready.filter((task) => task.teamId === 'beta').length, 3);
});

test('six slots are split 3/3 across two ready teams', () => {
  const plan = allocateSlots({ config, tasks });
  assert.equal(plan.dispatch.length, 6);
  assert.deepEqual(countByTeam(plan.dispatch), { alpha: 3, beta: 3 });
  assert.equal(plan.freeSlots, 0);
});

test('active workers reduce free slots', () => {
  const plan = allocateSlots({ config, tasks, active: [{ teamId: 'alpha' }, { teamId: 'alpha' }] });
  assert.equal(plan.dispatch.length, 4);
  const counts = countByTeam(plan.dispatch);
  assert.equal(counts.alpha, 1);
  assert.equal(counts.beta, 3);
});

test('a single team can borrow all free slots', () => {
  const single = Array.from({ length: 8 }, (_, index) => ({
    id: `alpha-${index}`,
    teamId: 'alpha',
    subject: `alpha ${index}`,
    dependencies: [],
    status: 'pending',
    kind: 'work',
  }));
  const plan = allocateSlots({ config, tasks: single });
  assert.equal(plan.dispatch.length, 6);
  assert.deepEqual(countByTeam(plan.dispatch), { alpha: 6 });
});

test('lease expiry is detected', () => {
  assert.equal(isLeaseExpired({ leaseExpiresAt: 1000 }, 1001), true);
  assert.equal(isLeaseExpired({ leaseExpiresAt: 2000 }, 1001), false);
});

test('visual state follows dependencies and status', () => {
  const blocked = tasks.find((task) => task.id === 'alpha-impl');
  assert.equal(taskVisualState(blocked, tasks), 'blocked');
  const open = tasks.find((task) => task.id === 'alpha-req-1');
  assert.equal(taskVisualState(open, tasks), 'open');
  const completed = { ...open, status: 'completed' };
  assert.equal(taskVisualState(completed, [completed]), 'completed');
});


test('sample graph is valid against the roster and team ids', () => {
  assert.deepEqual(validateTaskGraph(tasks, rosterMembers, { teamIds }), []);
});

test('unknown team ids are rejected', () => {
  const bad = [{ id: 'g1', teamId: 'gamma', subject: 'g', dependencies: [], status: 'pending', kind: 'work' }];
  assert.match(validateTaskGraph(bad, rosterMembers, { teamIds }).join('\n'), /unknown teamId/);
});

test('cross-team dependencies are rejected', () => {
  const bad = [
    { id: 'a1', teamId: 'alpha', subject: 'a', dependencies: [], status: 'pending', kind: 'work' },
    { id: 'b1', teamId: 'beta', subject: 'b', dependencies: ['a1'], status: 'pending', kind: 'work' },
  ];
  assert.match(validateTaskGraph(bad, rosterMembers, { teamIds }).join('\n'), /cross-team dependency/);
});

test('an assignee from another team is rejected', () => {
  const bad = [{ id: 'a1', teamId: 'alpha', subject: 'a', assignee: 'beta-impl', dependencies: [], status: 'pending', kind: 'work' }];
  assert.match(validateTaskGraph(bad, rosterMembers, { teamIds }).join('\n'), /belongs to another team/);
});

test('integration requires verify', () => {
  const bad = [{
    id: 'i1', teamId: 'alpha', subject: 'i', kind: 'integration',
    objective: 'integrate', acceptance: ['ok'], dependencies: [], status: 'pending',
  }];
  assert.match(validateTaskGraph(bad, rosterMembers, { teamIds }).join('\n'), /verify is required for integration/);
});

test('one member is not dispatched twice in one allocation', () => {
  const two = [
    { id: 'a1', teamId: 'alpha', subject: 'a1', assignee: 'alpha-impl', dependencies: [], status: 'pending', kind: 'work' },
    { id: 'a2', teamId: 'alpha', subject: 'a2', assignee: 'alpha-impl', dependencies: [], status: 'pending', kind: 'work' },
  ];
  const plan = allocateSlots({ config, tasks: two });
  assert.equal(plan.dispatch.filter((item) => item.member === 'alpha-impl').length, 1);
  assert.equal(plan.deferred.length, 1);
});

test('a failed dependency never unlocks downstream work', () => {
  const failedDep = [
    { id: 'a', teamId: 'alpha', subject: 'a', dependencies: [], status: 'failed', kind: 'work' },
    { id: 'b', teamId: 'alpha', subject: 'b', dependencies: ['a'], status: 'pending', kind: 'work' },
  ];
  assert.deepEqual(nextReady(failedDep).map((task) => task.id), []);
});

test('plan-time self-review is rejected', () => {
  const bad = [
    { id: 'i1', teamId: 'alpha', subject: 'i', kind: 'implementation', status: 'completed', assignee: 'alpha-impl', dependencies: [], objective: 'x', acceptance: ['a'], inScope: ['src/'], verify: ['npm test'] },
    { id: 'r1', teamId: 'alpha', subject: 'r', kind: 'review', status: 'pending', assignee: 'alpha-impl', dependencies: ['i1'], objective: 'x', acceptance: ['a'], reviewedTaskId: 'i1' },
  ];
  assert.match(validateTaskGraph(bad, rosterMembers, { teamIds }).join(String.fromCharCode(10)), /reviewer is the implementer/);
});

test('dynamicTeams allocates by task demand instead of a fixed per-team split', () => {
  const dynamicConfig = structuredClone(config);
  dynamicConfig.scheduler.activeWorkerSlots = 4;
  dynamicConfig.scheduler.maxActivePerTeam = 2;
  dynamicConfig.scheduler.dynamicTeams = true;
  const dynamicTasks = [
    ...Array.from({ length: 4 }, (_, index) => ({ id: `a${index}`, teamId: 'alpha', status: 'pending', kind: 'implementation', complexity: 'L', dependencies: [] })),
    { id: 'b0', teamId: 'beta', status: 'pending', kind: 'review', complexity: 'S', dependencies: [] },
    { id: 'b1', teamId: 'beta', status: 'pending', kind: 'review', complexity: 'S', dependencies: [] },
  ];
  const dynamicPlan = allocateSlots({ config: dynamicConfig, tasks: dynamicTasks, active: [] });
  assert.deepEqual(countByTeam(dynamicPlan.dispatch), { alpha: 3, beta: 1 });

  const fixed = structuredClone(dynamicConfig);
  fixed.scheduler.dynamicTeams = false;
  const fixedPlan = allocateSlots({ config: fixed, tasks: dynamicTasks, active: [] });
  assert.deepEqual(countByTeam(fixedPlan.dispatch), { alpha: 2, beta: 2 });
});

test('team maxActiveWorkers caps one team without capping the other', () => {
  const capped = structuredClone(config);
  capped.scheduler.activeWorkerSlots = 8;
  capped.scheduler.maxActivePerTeam = 8;
  capped.scheduler.dynamicTeams = true;
  const beta = capped.teams.find((team) => team.id === 'beta');
  beta.maxActiveWorkers = 2;
  const tasks = [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `a${index}`, teamId: 'alpha', status: 'pending', kind: 'implementation', complexity: 'M', dependencies: [] })),
    ...Array.from({ length: 6 }, (_, index) => ({ id: `b${index}`, teamId: 'beta', status: 'pending', kind: 'implementation', complexity: 'M', dependencies: [] })),
  ];
  const plan = allocateSlots({ config: capped, tasks, active: [] });
  assert.deepEqual(countByTeam(plan.dispatch), { alpha: 6, beta: 2 });
});

test('headless members use the non-interactive worker mode', () => {
  assert.equal(memberPermissionMode({ isolation: { workerMode: 'yolo' }, zcode: { mode: 'build' } }), 'yolo');
  assert.equal(memberPermissionMode({ isolation: {}, zcode: { mode: 'build' } }), 'build');
  assert.equal(memberPermissionMode({ readOnly: true, isolation: { workerMode: 'yolo' }, zcode: { mode: 'build' } }), 'plan');
  assert.equal(memberPermissionMode({}), 'yolo');
});

// --- automatic repair contract (A-STAB-REPAIR-CONTRACT) -------------------

const repairImpl = {
  id: 'impl-1',
  teamId: 'alpha',
  kind: 'implementation',
  status: 'completed',
  assignee: 'bob',
  objective: 'implement the scheduler',
  acceptance: ['works'],
  verify: ['npm test'],
  inScope: ['src/', 'test/'],
  dependencies: [],
};

function failedReview(findings, overrides = {}) {
  return {
    id: 'review-impl-1-r1',
    teamId: 'alpha',
    kind: 'review',
    status: 'failed',
    assignee: 'reviewer',
    verdict: 'needs_revision',
    round: 1,
    reviewedTaskId: 'impl-1',
    dependencies: ['impl-1'],
    acceptance: ['quality'],
    objective: 'review the scheduler',
    findings,
    ...overrides,
  };
}

function repairFor(findings, overrides = {}, sourceScope = repairImpl.inScope) {
  const review = failedReview(findings, overrides);
  const result = planFollowUp(review, [{ ...repairImpl, inScope: sourceScope }, review], { codeMaxRounds: 3, maxRepairAttempts: 2 });
  return { result, repair: result.created[0], review };
}

test('repair objective is derived from the review findings, not copied', () => {
  const { repair, result } = repairFor([
    {
      id: 'f1',
      severity: 'high',
      file: 'src/scheduler-service.mjs',
      line: 49,
      problem: 'the repair objective copies the implementation objective',
      requiredFix: 'build the objective from the findings list',
    },
    {
      id: 'f2',
      severity: 'medium',
      problem: 'the repair scope keeps line suffixes',
      requiredFix: 'strip the line suffix from src/scheduler-service.mjs:49,244',
    },
    {
      id: 'f3',
      severity: 'blocker',
      file: 'src/domain/gates.mjs',
      problem: 'a comma list in finding.file is swallowed',
      requiredFix: 'split the declared file into real paths',
    },
  ]);
  assert.equal(result.created.length, 2);
  assert.notEqual(repair.objective, repairImpl.objective);
  assert.notEqual(repair.objective, 'implement the scheduler');
  // P0/P1/P2 priority, file:line and the required fix all stay executable.
  assert.match(repair.objective, /\[P0\/blocker\]/);
  assert.match(repair.objective, /P1/);
  assert.match(repair.objective, /P2/);
  assert.match(repair.objective, /src\/scheduler-service\.mjs:49/);
  assert.match(repair.objective, /build the objective from the findings list/);
  assert.match(repair.objective, /src\/scheduler-service\.mjs:49,244/);
  assert.match(repair.objective, /review-impl-1-r1/);
});

test('repair scope keeps only real paths from comma lists, line ranges and 与', () => {
  const { repair } = repairFor([
    { id: 'f1', severity: 'high', problem: 'comma list with lines', requiredFix: '更新 src/x.mjs:49,244 与 src/y.mjs:453' },
    { id: 'f2', severity: 'medium', problem: 'comma separated list', requiredFix: 'update STATUS.md,HANDOFF.md and docs/contracts.md' },
    { id: 'f3', severity: 'low', problem: 'chinese conjunction', requiredFix: '补 test/scheduler.test.mjs 与 test/service-v06.test.mjs' },
    { id: 'f4', severity: 'low', problem: 'prose slash', requiredFix: '修复映射并转发/等待 的问题，P1 优先级' },
  ], {}, ['src/', 'test/', 'docs/', 'STATUS.md', 'HANDOFF.md']);
  assert.deepEqual(
    [...repair.inScope].sort(),
    [
      'HANDOFF.md',
      'STATUS.md',
      'docs/contracts.md',
      'src/x.mjs',
      'src/y.mjs',
      'test/scheduler.test.mjs',
      'test/service-v06.test.mjs',
    ].sort(),
  );
  for (const path of repair.inScope) {
    assert.doesNotMatch(path, /[:,，]/);
  }
});

test('repair scope handles newline lists and line ranges', () => {
  const { repair } = repairFor([
    { id: 'f1', severity: 'high', problem: 'multi-line list', requiredFix: 'touch src/a.mjs:12\nsrc/b.mjs:99-120\ndocs/ops.md' },
  ], {}, ['src/', 'docs/']);
  assert.deepEqual([...repair.inScope].sort(), ['docs/ops.md', 'src/a.mjs', 'src/b.mjs'].sort());
});

test('deriveRepairScope keeps real files out of a comma-separated fragment', () => {
  const scope = deriveRepairScope([
    { requiredFix: 'update STATUS.md,HANDOFF.md and src/scheduler-service.mjs:49,244' },
  ], ['src/']);
  assert.deepEqual([...scope].sort(), ['HANDOFF.md', 'STATUS.md', 'src/scheduler-service.mjs'].sort());
});

test('declared finding.file lists split into every real path (F-01 and F-06)', () => {
  // Raw review values: F-01 hides two line numbers after one file, F-06 is a
  // four-file comma list. Neither may survive as a single fake scope entry.
  const { repair } = repairFor([
    { id: 'F-01', severity: 'high', file: 'src/hot-update.mjs:49,244', problem: 'x', requiredFix: 'y' },
    {
      id: 'F-06',
      severity: 'high',
      file: 'STATUS.md,HANDOFF.md,CHANGELOG.md,docs/decisions.md',
      problem: 'x',
      requiredFix: 'y',
    },
  ], {}, ['src/', 'docs/', 'STATUS.md', 'HANDOFF.md', 'CHANGELOG.md']);
  assert.equal(repair.inScope.length, 5);
  assert.deepEqual(
    [...repair.inScope].sort(),
    ['CHANGELOG.md', 'HANDOFF.md', 'STATUS.md', 'docs/decisions.md', 'src/hot-update.mjs'].sort(),
  );
  for (const path of repair.inScope) {
    assert.doesNotMatch(path, /[,:]/);
  }
});

test('a declared extensionless file is still an authoritative scope path', () => {
  const { repair } = repairFor([
    { id: 'f1', severity: 'low', file: 'Makefile', problem: 'x', requiredFix: 'y' },
  ], {}, ['Makefile']);
  assert.deepEqual(repair.inScope, ['Makefile']);
});

test('findings fingerprint cannot collide across field or row boundaries', () => {
  const pipeInProblem = findingsFingerprint([
    { id: 'f1', severity: 'high', file: 'src/a.mjs', problem: 'a|b', requiredFix: 'c' },
  ]);
  const pipeInFix = findingsFingerprint([
    { id: 'f1', severity: 'high', file: 'src/a.mjs', problem: 'a', requiredFix: 'b|c' },
  ]);
  assert.notEqual(pipeInProblem, pipeInFix);
  const ordered = findingsFingerprint([
    { id: 'f1', severity: 'high', problem: 'p1', requiredFix: 'r1' },
    { id: 'f2', severity: 'low', problem: 'p2', requiredFix: 'r2' },
  ]);
  const reversed = findingsFingerprint([
    { id: 'f2', severity: 'low', problem: 'p2', requiredFix: 'r2' },
    { id: 'f1', severity: 'high', problem: 'p1', requiredFix: 'r1' },
  ]);
  assert.equal(ordered, reversed);
});

test('repair scope falls back to the source inScope with an explicit warning', () => {
  const { repair, result } = repairFor([
    { id: 'f1', severity: 'high', problem: 'no path is cited', requiredFix: 'make the gate deterministic' },
  ]);
  assert.deepEqual(repair.inScope, ['src/', 'test/']);
  assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0);
  assert.match(result.warnings.join('\n'), /fallback|fell back|inScope/i);
});

test('a repair with no derivable scope escalates instead of creating a broken contract', () => {
  const review = failedReview([
    { id: 'f1', severity: 'high', problem: 'no path is cited', requiredFix: 'make the gate deterministic' },
  ]);
  const source = { ...repairImpl, inScope: [] };
  const result = planFollowUp(review, [source, review], { codeMaxRounds: 3, maxRepairAttempts: 2 });
  assert.equal(result.created.length, 0);
  assert.equal(result.escalated, true);
  assert.match(result.warnings.join('\n'), /scope/i);
});

test('the same findings never create a duplicate repair task', () => {
  const planned = repairFor([
    { id: 'f1', severity: 'high', file: 'src/a.mjs', problem: 'x', requiredFix: 'fix src/a.mjs' },
  ]);
  const review = planned.review;
  const finishedRepair = { ...planned.repair, status: 'completed' };
  const again = planFollowUp(review, [repairImpl, review, finishedRepair], { codeMaxRounds: 3, maxRepairAttempts: 2 });
  assert.equal(again.created.length, 0);
  assert.equal(again.deduplicated, true);
});

test('identical findings from a new review round do not spawn another repair', () => {
  const findings = [
    { id: 'f1', severity: 'high', file: 'src/a.mjs', problem: 'x', requiredFix: 'fix src/a.mjs' },
  ];
  const first = repairFor(findings);
  const nextReview = failedReview(findings, {
    id: 'review-impl-1-r2',
    round: 2,
    dependencies: ['repair-review-impl-1-r1'],
  });
  const again = planFollowUp(nextReview, [repairImpl, first.review, first.repair, nextReview], {});
  assert.equal(again.created.length, 0);
  assert.equal(again.deduplicated, true);
});

test('a completed repair that leaves the same findings open escalates', () => {
  const findings = [
    { id: 'f1', severity: 'high', file: 'src/a.mjs', problem: 'x', requiredFix: 'fix src/a.mjs' },
  ];
  const first = repairFor(findings);
  const nextReview = failedReview(findings, { id: 'review-impl-1-r2', round: 2 });
  const again = planFollowUp(
    nextReview,
    [repairImpl, first.review, { ...first.repair, status: 'completed' }, nextReview],
    {},
  );
  assert.equal(again.created.length, 0);
  assert.equal(again.escalated, true);
  assert.equal(again.deduplicated, true);
  assert.match(again.reason, /completed but the same findings/);
});

// --- service input hardening ------------------------------------------------

const INJECTED_TASK_FIELDS = [
  'hidden', 'mergeState', 'mergeCommit', 'changedPaths', 'commandsRun',
  'acceptanceResults', 'reviewedArtifacts', 'worktree', 'attemptId',
];

function hardenedSetup({ phase = 'running', control = 'active', members = [{ name: 'eng' }] } = {}) {
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter, config, cwd: process.cwd(), now: () => 1000,
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase, control, members });
  return { store, adapter, service };
}

function isStateError(error) {
  return error?.status === 409 && error?.code === 'E_STATE';
}

function isForbidden(error) {
  return error?.status === 403 && error?.code === 'E_FORBIDDEN';
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

test('addTask drops injected lifecycle, evidence and merge fields', () => {
  const { store, service } = hardenedSetup();
  const created = service.addTask('alpha', {
    id: 't1', subject: 'hardened', kind: 'work', assignee: 'eng',
    status: 'completed',
    hidden: true,
    mergeState: 'merged',
    mergeCommit: 'deadbeef',
    changedPaths: ['src/a.js'],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    reviewedArtifacts: ['src/a.js'],
    worktree: '/tmp/injected-worktree',
    attemptId: 'att_injected',
  });
  assert.equal(created.status, 'pending');
  assert.equal(created.subject, 'hardened');
  assert.equal(created.assignee, 'eng');
  assert.deepEqual(created.dependencies, []);
  const stored = store.getTask('t1');
  assert.equal(stored.status, 'pending');
  for (const field of INJECTED_TASK_FIELDS) {
    assert.equal(stored[field], undefined, `${field} must not be stored`);
  }
  store.close();
});

test('addTask drops internal bookkeeping fields supplied by a public caller', () => {
  const { store, service } = hardenedSetup({ members: [{ name: 'lead', role: 'lead' }, { name: 'eng', role: 'engineer' }] });
  const lead = store.findMember('alpha', 'lead');
  const created = service.addTask('alpha', {
    id: 't1', subject: 'public task', kind: 'work', assignee: 'eng',
    createdAt: 0,
    closedLoop: { state: 'escalated' },
    findings: [{ id: 'forged', severity: 'low' }],
    findingsFingerprint: 'forged',
    assigneeId: 'forged-member',
    sourceTaskId: 'impl-link',
  }, { actor: { role: 'member', name: 'lead', memberId: lead.id, teamId: 'alpha' } });
  assert.equal(created.createdAt, 1000, 'createdAt is server-owned');
  assert.equal(created.closedLoop, undefined);
  assert.equal(created.findings, undefined);
  assert.equal(created.findingsFingerprint, undefined);
  assert.equal(created.assigneeId, undefined);
  assert.equal(created.sourceTaskId, 'impl-link', 'task-graph linkage remains public');
  store.close();
});

test('public addTask keeps review linkage and round for manual review creation', () => {
  const { store, service } = hardenedSetup({
    members: [{ name: 'eng', role: 'engineer' }, { name: 'rev', role: 'reviewer' }],
  });
  store.addTask({
    id: 'impl', teamId: 'alpha', subject: 'impl', kind: 'work',
    status: 'completed', assignee: 'eng',
  });
  const review = service.addTask('alpha', {
    id: 'review', subject: 'review', kind: 'review', assignee: 'rev',
    reviewedTaskId: 'impl', dependencies: ['impl'], objective: 'review',
    acceptance: ['quality'], round: 2,
  });
  assert.equal(review.reviewedTaskId, 'impl');
  assert.equal(review.round, 2);
  store.close();
});

test('editPlan reuses the task allowlist and cannot inject lifecycle state', () => {
  const { store, service } = hardenedSetup({ phase: 'staged' });
  service.editPlan('alpha', {
    tasks: [{
      id: 't1', subject: 'planned', kind: 'work',
      status: 'completed',
      hidden: true,
      mergeState: 'merged',
      mergeCommit: 'deadbeef',
      worktree: '/tmp/injected-worktree',
      changedPaths: ['src/a.js'],
      acceptanceResults: [{ criterion: 'works', status: 'passed' }],
      closedLoop: { state: 'escalated' },
      findings: [{ id: 'forged' }],
      createdAt: 0,
      assigneeId: 'forged-member',
    }],
  });
  const stored = store.getTask('t1');
  assert.equal(stored.status, 'pending');
  assert.equal(stored.hidden, undefined);
  assert.equal(stored.mergeState, undefined);
  assert.equal(stored.mergeCommit, undefined);
  assert.equal(stored.worktree, undefined);
  assert.equal(stored.changedPaths, undefined);
  assert.equal(stored.acceptanceResults, undefined);
  assert.equal(stored.closedLoop, undefined);
  assert.equal(stored.findings, undefined);
  assert.equal(stored.assigneeId, undefined);
  assert.equal(stored.createdAt, 1000);
  store.close();
});

test('editPlan keeps review linkage for a staged review task', () => {
  const { store, service } = hardenedSetup({
    phase: 'staged',
    members: [{ name: 'eng', role: 'engineer' }, { name: 'rev', role: 'reviewer' }],
  });
  service.editPlan('alpha', {
    tasks: [
      { id: 'impl', subject: 'impl', kind: 'work', assignee: 'eng' },
      {
        id: 'review', subject: 'review', kind: 'review', assignee: 'rev',
        reviewedTaskId: 'impl', dependencies: ['impl'], objective: 'review',
        acceptance: ['quality'], round: 2,
      },
    ],
  });
  const review = store.getTask('review');
  assert.equal(review.reviewedTaskId, 'impl');
  assert.equal(review.round, 2);
  store.close();
});

test('shadow sessions get a Bash/write denylist on mail delivery too', async () => {
  const { store, adapter, service } = hardenedSetup({
    members: [{ name: 'shadow', role: 'shadow' }, { name: 'eng', role: 'engineer' }],
  });
  const shadow = store.findMember('alpha', 'shadow');
  const created = await adapter.create({
    teamId: 'alpha', memberName: shadow.name, cwd: process.cwd(), prompt: 'init',
  });
  store.updateMember(shadow.id, { sessionId: created.sessionId });
  service.sendMessage('alpha', 'eng', 'shadow', 'hello shadow');
  await service.tick('alpha');
  const mailSend = adapter.calls.find((call) => call.kind === 'send'
    && call.input?.message?.startsWith('Mail from eng:'));
  assert.ok(mailSend, 'mail must be delivered to the shadow session');
  assert.ok(mailSend.input.disallowedTools.includes('Bash'));
  assert.ok(mailSend.input.disallowedTools.includes('Edit'));
  store.close();
});

test('amendTask writes only contract whitelist fields and keeps revisions accurate', () => {
  const { store, service } = hardenedSetup();
  service.addTask('alpha', {
    id: 't1', subject: 'amend me', kind: 'work', assignee: 'eng', acceptance: ['old'],
  });
  const next = service.amendTask('alpha', 't1', {
    acceptance: ['new'],
    priority: 'critical',
    subject: 'renamed',
    status: 'completed',
    hidden: true,
    worktree: '/tmp/injected-worktree',
    mergeState: 'merged',
    mergeCommit: 'deadbeef',
    changedPaths: ['src/a.js'],
    commandsRun: [],
    acceptanceResults: [],
    reviewedArtifacts: ['src/a.js'],
    attemptId: 'att_injected',
  }, 'tighten the contract');
  assert.deepEqual(next.acceptance, ['new']);
  assert.equal(next.priority, undefined);
  assert.equal(next.subject, 'amend me');
  assert.equal(next.status, 'pending');
  for (const field of INJECTED_TASK_FIELDS) {
    assert.equal(next[field], undefined, `${field} must not be written by amendTask`);
  }
  assert.deepEqual(next.revisions.at(-1).fields, ['acceptance']);
  assert.deepEqual(next.revisions.at(-1).previous, { acceptance: ['old'] });
  store.close();
});

test('a lead may publish work but cannot set or amend the task contract', () => {
  const { store, service } = hardenedSetup({
    members: [{ name: 'lead', role: 'lead' }, { name: 'eng', role: 'engineer' }],
  });
  const lead = store.findMember('alpha', 'lead');
  const actor = {
    role: 'member', name: 'lead', memberId: lead.id, teamId: 'alpha',
  };
  const plain = service.addTask('alpha', {
    id: 't1', subject: 'lead work', kind: 'work', assignee: 'eng',
  }, { actor });
  assert.equal(plain.status, 'pending');
  assert.throws(
    () => service.addTask('alpha', {
      id: 't2', subject: 'contract work', kind: 'work', objective: 'widen the contract',
    }, { actor }),
    isForbidden,
  );
  assert.throws(
    () => service.amendTask('alpha', 't1', { verify: ['npm test'] }, 'lead widens verify', actor),
    isForbidden,
  );
  const unchanged = service.amendTask('alpha', 't1', {
    worktree: '/tmp/injected-worktree',
  }, 'lead injects a worktree', actor);
  assert.equal(unchanged.worktree, undefined);
  assert.equal(store.getTask('t1').verify, undefined);
  store.close();
});

test('addTask and mergeTask refuse staged, archived and halted teams', async () => {
  for (const state of [
    { phase: 'staged' },
    { phase: 'archived' },
    { phase: 'running', control: 'halted' },
  ]) {
    const { store, service } = hardenedSetup();
    store.addTask({
      id: 'done', teamId: 'alpha', subject: 'done', kind: 'work',
      status: 'completed', worktree: '/tmp/wt',
    });
    store.updateTeam('alpha', state);
    const label = `${state.phase}/${state.control ?? 'active'}`;
    assert.throws(
      () => service.addTask('alpha', { id: 't1', subject: 'blocked', kind: 'work' }),
      isStateError,
      `addTask must refuse ${label}`,
    );
    assert.equal(store.getTask('t1'), undefined);
    await assert.rejects(
      service.mergeTask('alpha', 'done'),
      isStateError,
      `mergeTask must refuse ${label}`,
    );
    const internal = service.addTask('alpha', {
      id: 'recovered', subject: 'recovery row', kind: 'work',
    }, { internal: true });
    assert.equal(internal.status, 'pending', 'internal recovery may still write');
    store.close();
  }
});

test('shadow and patrol sessions deny Bash while review contractors keep it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-agent-teams-denylist-'));
  try {
    const { store, adapter, service } = hardenedSetup();
    service.memberHomeRoot = () => home;
    await service.startShadow({ teamId: 'alpha' });
    const shadowCreate = adapter.calls.find((call) => call.kind === 'create' && call.input.shadow === true);
    assert.ok(shadowCreate, 'startShadow must create a session');
    assert.ok(shadowCreate.input.disallowedTools.includes('Bash'));
    assert.ok(shadowCreate.input.disallowedTools.includes('Edit'));

    const patrol = await service.submitContractor({
      teamId: 'alpha', purpose: 'patrol', prompt: 'report only',
    });
    assert.equal(
      await waitFor(() => adapter.calls.some((call) => call.kind === 'create' && call.input.memberId === patrol.id)),
      true,
    );
    const patrolCreate = adapter.calls.find((call) => call.kind === 'create' && call.input.memberId === patrol.id);
    assert.ok(patrolCreate.input.disallowedTools.includes('Bash'));
    assert.equal(
      await waitFor(() => ['completed', 'failed', 'cleanup_error', 'killed'].includes(store.getContractor(patrol.id)?.status)),
      true,
    );

    const review = await service.submitContractor({
      teamId: 'alpha', purpose: 'audit', prompt: 'review only', mode: 'review',
    });
    assert.equal(
      await waitFor(() => adapter.calls.some((call) => call.kind === 'create' && call.input.memberId === review.id)),
      true,
    );
    const reviewCreate = adapter.calls.find((call) => call.kind === 'create' && call.input.memberId === review.id);
    assert.equal(reviewCreate.input.disallowedTools.includes('Bash'), false);
    assert.ok(reviewCreate.input.disallowedTools.includes('Edit'));
    assert.equal(
      await waitFor(() => ['completed', 'failed', 'cleanup_error', 'killed'].includes(store.getContractor(review.id)?.status)),
      true,
    );
    store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
