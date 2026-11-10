import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import {
  deliveryAudit,
  findingsFingerprint,
  planCompletionFanOut,
  planCompletionReview,
  planFailedReviewFollowUp,
} from '../src/domain/gates.mjs';
import { nextReady, validateTaskGraph } from '../src/domain/scheduler.mjs';
import { migrateLegacyRepairs, normalizeTaskModes } from '../src/service/phase0-normalize.mjs';
import { revertCommitOnce } from '../src/git/merge-queue.mjs';
import { createWorktreeFenceProvider } from '../src/git/worktree-fence.mjs';

const VERIFY = 'node -e "process.exit(0)"';

function setup({ artifactFenceProvider, handler } = {}) {
  const { config } = loadConfig('config/example.v06.json');
  config.scheduler.dynamicTeams = false;
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter({ handler });
  let clock = 1000;
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter, config, cwd: process.cwd(), now: () => clock,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
    artifactFenceProvider,
  });
  return { config, store, adapter, service, advance: (ms) => { clock += ms; } };
}

function finding(overrides = {}) {
  return { id: 'f1', severity: 'high', file: 'src/a.js', problem: 'broken',
    requiredFix: 'fix src/a.js', ...overrides };
}

function legacyRoot(overrides = {}) {
  return {
    id: 'legacy-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'legacy', subject: 'legacy root', objective: 'works', dependencies: [],
    assignee: 'Engineer 01', assigneeId: 'm-engineer', acceptance: ['works'],
    inScope: ['src/', 'test/'], verify: [VERIFY], sourceBase: 'base-commit',
    sourceCommit: 'root-commit', diffHash: 'root-diff', deliveryUnitId: 'legacy-root',
    deliverySeq: 0, taskEpoch: 0, changedPaths: ['src/a.js'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: VERIFY, status: 'passed' }],
    ...overrides,
  };
}

function failedLegacyReview(overrides = {}) {
  return {
    id: 'legacy-review', teamId: 'alpha', kind: 'review', status: 'failed',
    verdict: 'needs_revision', reviewMode: 'legacy', reviewedTaskId: 'legacy-root',
    dependencies: ['legacy-root'], round: 1, assignee: 'Reviewer 01', assigneeId: 'm-reviewer',
    objective: 'review', acceptance: ['reviewed'], findings: [finding()],
    ...overrides,
  };
}

test('B43 legacy repair depends on the source and its re-review binds the repair commit', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const root = legacyRoot();
  const review = failedLegacyReview();
  store.addTask(root);
  store.addTask(review);
  await service.reconcileClosedLoop('alpha');
  const repair = store.listTasks('alpha').find((task) => task.kind === 'repair');
  assert.ok(repair);
  assert.deepEqual(repair.dependencies, [root.id]);
  assert.equal(repair.parentReviewTaskId, review.id);
  assert.equal(repair.mode, 'legacy');
  assert.equal(repair.sourceBase, root.sourceCommit);
  assert.equal(nextReady(store.listTasks('alpha')).some((task) => task.id === repair.id), true);

  // A task that depends on the repair cannot be ready before it completes.
  store.addTask({ id: 'after-repair', teamId: 'alpha', kind: 'verification', status: 'pending',
    dependencies: [repair.id], reviewedTaskId: repair.id, objective: 'check', acceptance: ['ok'],
    verify: [VERIFY] });
  assert.equal(nextReady(store.listTasks('alpha')).some((task) => task.id === 'after-repair'), false);

  store.updateTask(repair.id, {
    status: 'completed', sourceCommit: 'repair-commit', sourceBase: root.sourceCommit,
    diffHash: 'repair-diff', changedPaths: ['src/a.js'],
    acceptanceResults: [{ criterion: 'fix src/a.js', status: 'passed' }],
    commandsRun: repair.verify.length > 0 ? [{ command: VERIFY, status: 'passed' }] : [],
  });
  await service.applyClosedLoop('alpha', store.getTask(repair.id));
  const recheck = store.listTasks('alpha').find((task) => task.kind === 'review'
    && task.reviewedTaskId === repair.id);
  assert.ok(recheck);
  assert.equal(recheck.reviewMode, 'legacy');
  assert.equal(recheck.reviewedSourceCommit, 'repair-commit');
  assert.deepEqual(recheck.dependencies, [repair.id]);
  assert.equal(nextReady(store.listTasks('alpha')).some((task) => task.id === recheck.id), true);

  // A pending re-review blocks the merge instead of falling back to an old pass.
  const pendingTarget = service.resolveDeliveryMergeTarget('alpha', store.getTask(root.id));
  assert.equal(pendingTarget.ok, false);
  assert.equal(pendingTarget.blocked, 'review_pending');

  // A completed but unreviewed repair must not be bypassed by the root's old pass.
  const root2 = legacyRoot({ id: 'legacy-root-2', deliveryUnitId: 'legacy-root-2', sourceCommit: 'root-2' });
  const repair2 = {
    id: 'legacy-repair-2', teamId: 'alpha', kind: 'repair', status: 'completed', mode: 'legacy',
    sourceTaskId: root2.id, dependencies: [root2.id], round: 2, sourceCommit: 'repair-2',
    sourceBase: root2.sourceCommit, acceptance: ['works'], inScope: ['src/'], verify: [VERIFY],
  };
  const oldPass2 = {
    id: 'old-pass-2', teamId: 'alpha', kind: 'review', status: 'completed', verdict: 'pass',
    reviewMode: 'legacy', reviewedTaskId: root2.id, dependencies: [root2.id], round: 1,
    reviewedSourceCommit: root2.sourceCommit, assignee: 'Reviewer 01', assigneeId: 'm-reviewer',
    scores: { overall: 4.8, code: 4.8 },
  };
  store.addTask(root2);
  store.addTask(repair2);
  store.addTask(oldPass2);
  const target = service.resolveDeliveryMergeTarget('alpha', store.getTask(root2.id));
  assert.equal(target.ok, false);
  assert.equal(target.blocked, 'newer_delivery_unreviewed');
  store.close();
});

test('B43 archived legacy review advances to a new review epoch', () => {
  const source = { id: 'epoch-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'legacy', sourceCommit: 'c1', acceptance: ['works'], legacyReviewEpoch: 2 };
  const archived = { id: 'old-e7', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', reviewMode: 'legacy', reviewedTaskId: source.id, archived: true,
    reviewEpoch: 7, legacyReviewEpoch: 7, reviewedSourceCommit: 'c0' };
  const plan = planCompletionReview({ task: source, tasks: [source, archived] });
  assert.equal(plan.action, 'create');
  assert.equal(plan.task.legacyReviewEpoch, 8);
  assert.notEqual(plan.task.id, archived.id);
  assert.equal(plan.task.reviewedSourceCommit, 'c1');
});

test('B45 bound known-repair is not half-bound and uses the next unit sequence', () => {
  const root = { id: 'unit-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'bound', assigned: true, assignee: 'e1', assigneeId: 'm1', deliveryUnitId: 'unit-root',
    deliverySeq: 0, taskEpoch: 1, sourceCommit: 'root-commit', sourceBase: 'base',
    diffHash: 'root-diff', acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY],
    findings: [finding()] };
  const pass = { id: 'unit-review', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', reviewMode: 'bound', reviewedTaskId: root.id, dependencies: [root.id],
    binding: { deliveryUnitId: root.id, deliverySeq: 0, sourceTaskId: root.id,
      sourceCommit: root.sourceCommit, sourceBase: root.sourceBase, diffHash: root.diffHash },
    deliveryGeneration: 1, scores: { overall: 4.8, code: 4.8 }, assignee: 'r1', assigneeId: 'mr' };
  const previousRepair = { id: 'previous-repair', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'bound', deliveryUnitId: root.id, deliverySeq: 2, sourceTaskId: root.id,
    sourceCommit: 'repair-commit' };
  const tasks = [root, previousRepair, pass];
  const fan = planCompletionFanOut({ task: root, tasks });
  const known = fan.created.find((task) => task.id === 'repair-known-unit-root');
  assert.ok(known);
  assert.equal(known.mode, 'bound');
  assert.equal(known.parentReviewTaskId, pass.id);
  assert.equal(known.deliveryUnitId, root.id);
  assert.equal(known.deliverySeq, 3);
  assert.equal(known.sourceBase, root.sourceCommit);
  assert.equal(nextReady([...tasks, ...fan.created]).some((task) => task.id === known.id), true);

  const broken = { ...root, deliveryUnitId: 'other', deliverySeq: 7 };
  const plan = planCompletionReview({ task: broken, tasks: [broken] });
  assert.equal(plan.needsCaptain, true);

  // A review binding may carry a higher sequence than any task row; the new
  // repair must advance past both sources, never reuse 2 or 9.
  const seqRoot = { ...root, deliverySeq: 0, taskEpoch: 1 };
  const seqRepair = { id: 'seq-repair', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'bound', sourceTaskId: seqRoot.id, deliveryUnitId: seqRoot.id, deliverySeq: 2,
    deliveryGeneration: 1, sourceCommit: 'seq-commit', acceptance: ['works'], inScope: ['src/'], verify: [VERIFY] };
  const seqReview = { id: 'seq-review', teamId: 'alpha', kind: 'review', status: 'failed',
    verdict: 'needs_revision', reviewMode: 'bound', reviewedTaskId: seqRoot.id,
    dependencies: [seqRoot.id], findings: [finding()], deliveryGeneration: 1, unitReviewSeq: 3,
    binding: { deliveryUnitId: seqRoot.id, deliverySeq: 0, sourceTaskId: seqRoot.id,
      sourceBase: seqRoot.sourceBase, sourceCommit: seqRoot.sourceCommit } };
  const seqArchived = { id: 'seq-archived', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', reviewMode: 'bound', reviewedTaskId: seqRepair.id, archived: true,
    binding: { deliveryUnitId: seqRoot.id, deliverySeq: 9, sourceTaskId: seqRepair.id,
      sourceCommit: seqRepair.sourceCommit } };
  const seqPlan = planFailedReviewFollowUp({
    task: seqReview, tasks: [seqRoot, seqRepair, seqArchived, seqReview],
  });
  assert.equal(seqPlan.action, 'repair');
  assert.equal(seqPlan.task.deliverySeq, 10);
  assert.equal(seqPlan.task.parentReviewTaskId, seqReview.id);
});

test('B46 failed review repair depends on the unit root; reject never creates a repair', () => {
  const root = { id: 'bound-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'bound', deliveryUnitId: 'bound-root', deliverySeq: 0, taskEpoch: 2,
    sourceCommit: 'root-commit', acceptance: ['works'], inScope: ['src/', 'test/'], verify: [VERIFY] };
  const review = { id: 'bound-review', teamId: 'alpha', kind: 'review', status: 'failed',
    verdict: 'needs_revision', reviewMode: 'bound', reviewedTaskId: root.id,
    dependencies: [root.id], findings: [finding()], deliveryGeneration: 2, unitReviewSeq: 1,
    binding: { deliveryUnitId: root.id, deliverySeq: 0, sourceTaskId: root.id,
      sourceCommit: root.sourceCommit } };
  const plan = planFailedReviewFollowUp({ task: review, tasks: [root, review] });
  assert.equal(plan.action, 'repair');
  assert.deepEqual(plan.task.dependencies, [root.id]);
  assert.equal(plan.task.parentReviewTaskId, review.id);
  assert.equal(nextReady([root, review, plan.task]).some((task) => task.id === plan.task.id), true);

  const reject = planFailedReviewFollowUp({ task: { ...review, verdict: 'reject' }, tasks: [root, review] });
  assert.equal(reject.action, 'escalate');
  assert.equal(reject.task, undefined);
});

test('B46 settled post-merge repair is recreated once from legacy and integration roots', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const root = {
    id: 'legacy-post', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'legacy', sourceCommit: 'source', mergeCommit: 'reviewed', mergeState: 'rejected',
    postMergeReview: 'needs_revision', repairPlanPending: true, inScope: ['src/'], outOfScope: [],
    verify: [VERIFY], acceptance: ['works'], subject: 'legacy post', objective: 'works',
    negativeMergeIntent: { operationId: 'op', phase: 'settled', verdict: 'needs_revision',
      mergeCommit: 'reviewed', evidence: 'fix', mergeReviewId: 'mrv', findings: [finding()] },
  };
  store.addTask(root);
  service.reconcilePostMergeRepairs('alpha');
  const repair = store.listTasks('alpha').find((task) => task.kind === 'repair');
  assert.ok(repair);
  assert.equal(repair.mode, 'legacy');
  assert.equal(repair.sourceBase, 'reviewed');
  assert.equal(repair.parentIntegrationId, undefined);
  assert.deepEqual(repair.dependencies, [root.id]);
  assert.equal(repair.repairOrigin, 'postmerge');
  service.reconcilePostMergeRepairs('alpha');
  assert.equal(store.listTasks('alpha').filter((task) => task.kind === 'repair').length, 1);

  const integration = {
    id: 'integr', teamId: 'alpha', kind: 'integration', status: 'completed',
    mode: 'legacy', sourceCommit: 'int-source', mergeCommit: 'int-reviewed', mergeState: 'rejected',
    postMergeReview: 'needs_revision', repairPlanPending: true, inScope: ['src/'], outOfScope: [],
    verify: [VERIFY], acceptance: ['works'], subject: 'integration', objective: 'works',
    negativeMergeIntent: { operationId: 'op2', phase: 'settled', verdict: 'needs_revision',
      mergeCommit: 'int-reviewed', evidence: 'fix', mergeReviewId: 'mrv2', findings: [finding()] },
  };
  store.addTask(integration);
  service.reconcilePostMergeRepairs('alpha');
  const integrationRepair = store.listTasks('alpha').find((task) => task.parentIntegrationId === integration.id);
  assert.ok(integrationRepair);
  assert.equal(integrationRepair.deliveryUnitId, undefined);
  assert.equal(integrationRepair.mode, 'legacy');
  assert.equal(nextReady(store.listTasks('alpha')).some((task) => task.id === integrationRepair.id), true);

  // A second rejection of the integration repair must create a third repair
  // that keeps the original integration root as source, not the repair itself.
  store.updateTask(integrationRepair.id, {
    status: 'completed', mergeCommit: 'repair-reviewed', sourceBase: 'repair-reviewed',
    mergeState: 'rejected', postMergeReview: 'needs_revision', repairPlanPending: true,
    negativeMergeIntent: { operationId: 'op3', phase: 'settled', verdict: 'needs_revision',
      mergeCommit: 'repair-reviewed', evidence: 'fix again', mergeReviewId: 'mrv3', findings: [finding()] },
  });
  service.reconcilePostMergeRepairs('alpha');
  const secondRepair = store.listTasks('alpha').find((task) => task.kind === 'repair'
    && task.parentIntegrationId === integration.id && task.id !== integrationRepair.id);
  assert.ok(secondRepair, 'a second integration rejection must create a new repair generation');
  assert.equal(secondRepair.sourceTaskId, integration.id,
    'the integration repair lineage must stay rooted at the integration task');
  assert.deepEqual(secondRepair.dependencies, [integrationRepair.id, integration.id]);
  assert.deepEqual(validateTaskGraph(store.listTasks('alpha'), [],
    { teamIds: ['alpha'], allowUnassigned: true }), []);
  assert.equal(nextReady(store.listTasks('alpha')).some((task) => task.id === secondRepair.id), true);
  store.close();
});

test('B48 legacy findings-only fan-out produces review+known-repair and never duplicates', () => {
  const root = legacyRoot({
    sourceCommit: 'legacy-commit', requiresVerification: true, findings: [finding()],
    verify: [], acceptance: ['works'],
  });
  const members = [
    { id: 'm-e', name: 'e2', role: 'engineer', license: { roleKey: 'engineer', allowedTaskKinds: ['repair'] } },
    { id: 'm-r', name: 'r1', role: 'reviewer', license: { roleKey: 'reviewer', allowedTaskKinds: ['review'] } },
    { id: 'm-a', name: 'a1', role: 'analyst', license: { roleKey: 'analyst', allowedTaskKinds: ['verification'] } },
  ];
  const first = planCompletionFanOut({ task: root, tasks: [root], members });
  assert.equal(first.action, 'create');
  assert.deepEqual(first.created.map((task) => task.id).sort(),
    ['repair-known-legacy-root', 'review-legacy-root']);
  assert.equal(first.created.some((task) => task.kind === 'verification'), false,
    'a source with no verify command cannot produce command evidence');
  const repair = first.created.find((task) => task.kind === 'repair');
  assert.equal(repair.mode, 'legacy');
  assert.equal(repair.contractSource, 'findings');
  assert.deepEqual(repair.verify, []);
  assert.deepEqual(repair.dependencies, [root.id]);
  assert.equal(repair.legacyUnbound, false);
  assert.equal(validateTaskGraph([root, ...first.created], members, { allowUnassigned: true }).length, 0);
  const second = planCompletionFanOut({ task: root, tasks: [root, ...first.created], members });
  assert.deepEqual(second.created, []);
});

test('B49 halted teams skip the closed loop and mixed mode blocks merge resolution', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', control: 'halted' });
  store.addTask(legacyRoot());
  const result = await service.reconcileClosedLoop('alpha');
  assert.equal(result.skipped, 'team-not-active');
  assert.equal(store.listTasks('alpha').filter((task) => task.kind === 'review').length, 0);

  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  const root = { id: 'mixed-root', teamId: 'beta', kind: 'implementation', status: 'completed',
    mode: 'legacy', acceptance: ['works'], inScope: ['src/'], verify: [VERIFY], sourceCommit: 'c' };
  const repair = { id: 'mixed-repair', teamId: 'beta', kind: 'repair', status: 'completed',
    mode: 'bound', sourceTaskId: root.id, dependencies: [root.id], deliveryUnitId: root.id,
    deliverySeq: 1, sourceBase: 'c', sourceCommit: 'r', acceptance: ['works'], inScope: ['src/'], verify: [VERIFY] };
  store.addTask(root);
  store.addTask(repair);
  const target = service.resolveDeliveryMergeTarget('beta', store.getTask(root.id));
  assert.equal(target.ok, false);
  assert.equal(target.blocked, 'mixed_mode_requires_captain');
  store.close();
});

test('commit-before-review persists source identity and fails closed without a trusted fence', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-commit-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    let released = 0;
    const artifactFenceProvider = {
      async acquire(input) {
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => { released += 1; } };
      },
    };
    const { config, store, service } = setup({ artifactFenceProvider });
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.useWorktrees = true;
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    service.addTask('alpha', { id: 't1', subject: 't1', kind: 'implementation',
      assigneeRole: 'engineer', objective: 'works', acceptance: ['works'],
      inScope: ['src/'], verify: [VERIFY] });
    await service.tick('alpha');
    const live = store.getTask('t1');
    assert.equal(live.status, 'in_progress');
    mkdirSync(join(live.worktree, 'src'), { recursive: true });
    writeFileSync(join(live.worktree, 'src', 'a.js'), 'ok', 'utf8');
    const done = await service.completeTask({ teamId: 'alpha', taskId: 't1', attemptId: live.attemptId,
      update: { status: 'completed', acceptanceResults: [{ criterion: 'works', status: 'passed' }] } });
    assert.equal(done.ok, true, done.error);
    const completed = store.getTask('t1');
    assert.match(completed.sourceCommit, /^[0-9a-f]{40}$/);
    assert.match(completed.diffHash, /^[0-9a-f]{64}$/);
    const raw = execFileSync('git', ['diff', '--raw', '-z', '--no-renames', '--full-index', '--no-abbrev',
      `${completed.sourceBase}..${completed.sourceCommit}`, '--'], { cwd: repo, encoding: 'utf8' });
    const rawTokens = raw.split('\0');
    const rawEntries = [];
    for (let index = 0; index + 1 < rawTokens.length; index += 2) {
      rawEntries.push(`${rawTokens[index]}\0${rawTokens[index + 1]}`);
    }
    rawEntries.sort();
    const canonical = createHash('sha256').update(rawEntries.join('\0')).digest('hex');
    assert.equal(completed.diffHash, canonical,
      'diffHash must be the canonical raw-entry digest, not a text diff hash');
    assert.deepEqual(completed.changedPaths, ['src/a.js']);
    const review = store.listTasks('alpha').find((task) => task.kind === 'review');
    assert.ok(review);
    assert.equal(review.binding.sourceCommit, completed.sourceCommit);
    assert.equal(review.binding.diffHash, completed.diffHash);
    assert.equal(released, 1);

    // A rejected completion must not commit first. The same attempt can retry
    // after fixing acceptance evidence and produce exactly one commit.
    service.addTask('alpha', { id: 't3', subject: 't3', kind: 'implementation',
      assigneeRole: 'engineer', objective: 'works', acceptance: ['works'],
      inScope: ['src/'], verify: [VERIFY] });
    await service.tick('alpha');
    const t3 = store.getTask('t3');
    mkdirSync(join(t3.worktree, 'src'), { recursive: true });
    writeFileSync(join(t3.worktree, 'src', 'c.js'), 'ok', 'utf8');
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: t3.worktree, encoding: 'utf8' }).trim();
    const rejected = await service.completeTask({ teamId: 'alpha', taskId: 't3', attemptId: t3.attemptId,
      update: { status: 'completed', acceptanceResults: [] } });
    assert.equal(rejected.ok, false);
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: t3.worktree, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore, 'a rejected completion must not create an orphan commit');
    const retried = await service.completeTask({ teamId: 'alpha', taskId: 't3', attemptId: t3.attemptId,
      update: { status: 'completed', acceptanceResults: [{ criterion: 'works', status: 'passed' }] } });
    assert.equal(retried.ok, true, retried.error);
    assert.match(store.getTask('t3').sourceCommit, /^[0-9a-f]{40}$/);

    // The same committed artifact is accepted without a second commit; a
    // second completion cannot duplicate the review.
    const again = await service.applyClosedLoop('alpha', completed);
    assert.equal(again.created.length, 0);
    assert.equal(store.listTasks('alpha').filter((task) => task.kind === 'review'
      && task.reviewedTaskId === 't1').length, 1);

    // Without the capability the daemon keeps the task open and escalates.
    service.artifactFenceProvider = null;
    service.addTask('alpha', { id: 't2', subject: 't2', kind: 'implementation',
      assigneeRole: 'engineer', objective: 'works', acceptance: ['works'],
      inScope: ['src/'], verify: [VERIFY] });
    await service.tick('alpha');
    const open = store.getTask('t2');
    mkdirSync(join(open.worktree, 'src'), { recursive: true });
    writeFileSync(join(open.worktree, 'src', 'b.js'), 'ok', 'utf8');
    const blocked = await service.completeTask({ teamId: 'alpha', taskId: 't2', attemptId: open.attemptId,
      update: { status: 'completed', acceptanceResults: [{ criterion: 'works', status: 'passed' }] } });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'E_ARTIFACT_FENCE');
    assert.equal(store.getTask('t2').status, 'in_progress');
    assert.equal(store.getTask('t2').hold.reason, 'exclusive_worktree_fence_unavailable');
    assert.equal(store.getTask('t2').needsCaptain, true);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('B44 audit separates historical rows, verification evidence and failed-root delivery', () => {
  const root = legacyRoot({ id: 'failed-root', status: 'failed', deliveryUnitId: 'failed-root',
    deliverySeq: 0, sourceCommit: 'root-c', worktree: '/tmp/failed-root' });
  const repair = { id: 'failed-repair', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'legacy', sourceTaskId: root.id, dependencies: [root.id], sourceCommit: 'repair-c',
    acceptance: ['works'], inScope: ['src/'], verify: [VERIFY],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: VERIFY, status: 'passed' }], changedPaths: ['src/a.js'] };
  const review = { id: 'failed-review', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', reviewMode: 'legacy', reviewedTaskId: repair.id, reviewedSourceCommit: repair.sourceCommit,
    dependencies: [repair.id], assignee: 'r1', assigneeId: 'mr',
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: VERIFY, status: 'passed' }] };
  const verification = { id: 'verify-ok', teamId: 'alpha', kind: 'verification', status: 'completed',
    reviewedTaskId: root.id, acceptance: ['checked'], acceptanceResults: [{ criterion: 'checked', status: 'passed' }],
    verify: [VERIFY], commandsRun: [{ command: VERIFY, status: 'passed' }] };
  const historicalReview = { id: 'old-review', teamId: 'alpha', kind: 'review', status: 'failed',
    historical: true, verdict: 'needs_revision', reviewedTaskId: 'unrelated-source', findings: [] };
  const unboundVerification = { id: 'old-verify', teamId: 'alpha', kind: 'verification', status: 'failed',
    legacyUnbound: true, quarantinedAt: 1, reviewedTaskId: 'unrelated-source-2',
    acceptance: ['old'], verify: [VERIFY] };
  const legacyRepairRow = { id: 'legacy-repair-row', teamId: 'alpha', kind: 'repair', status: 'completed',
    legacyRepair: true, quarantinedAt: 1, acceptance: ['old'], verify: [VERIFY],
    mergeState: 'pending', worktree: '/tmp/old' };
  const activeReview = { ...historicalReview, id: 'active-review', historical: false,
    reviewedTaskId: 'unrelated-source', findings: [finding()] };
  const brokenVerification = { ...verification, id: 'verify-bad', acceptanceResults: [] };
  const cancelledRoot = { ...root, id: 'cancelled-root', status: 'cancelled', deliveryUnitId: 'cancelled-root' };
  const audit = deliveryAudit({ phase: 'running', control: 'active',
    tasks: [root, repair, review, verification, historicalReview, unboundVerification,
      legacyRepairRow, activeReview, brokenVerification, cancelledRoot] });
  assert.equal(audit.blockers.some((item) => item.includes('old-review')), false);
  assert.equal(audit.blockers.some((item) => item.includes('old-verify')), false);
  assert.equal(audit.blockers.some((item) => item.includes('legacy-repair-row')), false);
  assert.equal(audit.blockers.some((item) => /verify-ok.*verdict/.test(item)), false);
  assert.equal(audit.blockers.some((item) => item.includes('active-review')), true);
  assert.equal(audit.blockers.some((item) => item.includes('verify-bad')), true);
  assert.equal(audit.blockers.includes(`${root.id}: unit_not_merged`), true);
  assert.equal(audit.blockers.some((item) => item.includes('cancelled-root: unit_not_merged')), false);

  const mergedRepair = { ...repair, mergeState: 'merged', mergeCommit: 'repair-c', mergedCommit: 'repair-c' };
  const deliveredRoot = { ...root, closedLoop: { deliveredBy: mergedRepair.id } };
  const delivered = deliveryAudit({ phase: 'running', control: 'active',
    tasks: [deliveredRoot, mergedRepair, review, verification] });
  assert.equal(delivered.blockers.includes(`${root.id}: unit_not_merged`), false);
});

test('B47 an integration repair remains outside the unit and marks its parent merged', async () => {
  const { config, store, service } = setup({
    handler: async () => ({ response: JSON.stringify({ verdict: 'pass', evidence: 'ok' }) }),
  });
  config.quality.postMergeReview = 'contractor';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
  const parent = { id: 'int-root', teamId: 'alpha', kind: 'integration', status: 'completed',
    mode: 'legacy', acceptance: ['integration'], verify: [VERIFY], inScope: ['src/'],
    mergeState: 'rejected', mergeReverted: true, sourceCommit: 'old-int' };
  const repair = { id: 'int-repair', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'legacy', parentIntegrationId: parent.id, sourceTaskId: parent.id,
    dependencies: [parent.id], sourceCommit: 'new-int', mergeCommit: 'new-int',
    mergeState: 'review_pending', acceptance: ['integration'], verify: [VERIFY], inScope: ['src/'],
    assignee: 'Engineer 01' };
  store.addTask(parent);
  store.addTask(repair);
  const result = await service.reviewMerge('alpha', repair.id);
  assert.equal(result.ok, true, result.error);
  const liveRepair = store.getTask(repair.id);
  const liveParent = store.getTask(parent.id);
  assert.equal(liveRepair.mergeState, 'merged');
  assert.equal(liveRepair.deliveryUnitId, undefined);
  assert.equal(liveParent.mergeState, 'merged');
  assert.equal(liveParent.mergedCommit, 'new-int');
  assert.equal(liveParent.mergeReverted, false);
  assert.equal(liveParent.closedLoop.deliveredBy, repair.id);
});

test('B49 adopt fails closed on a missing worktree and does not dispatch a held review', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ id: 'adopt-me', mode: 'bound', deliveryUnitId: 'adopt-me',
    sourceCommit: undefined, diffHash: undefined, worktree: '/tmp/adopt-me',
    worktreeBase: 'base', lastAttemptId: 'attempt-1' }));
  const adopted = await service.adoptPendingCandidates({ teamId: 'alpha' });
  assert.deepEqual(adopted.adopted, []);
  assert.deepEqual(adopted.blocked, ['adopt-me']);
  const task = store.getTask('adopt-me');
  assert.equal(task.mergeState, 'blocked');
  assert.equal(task.mergeBlockReason, 'adopt_worktree_missing');
  assert.equal(task.needsCaptain, true);
  assert.equal(store.listTasks('alpha').some((item) => item.kind === 'review'), false);
  store.close();
});

test('captain can release a named hold; stale or manual holds stay closed', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'held', teamId: 'alpha', kind: 'work', status: 'pending',
    subject: 'held', dependencies: [], hold: { class: 'artifact_commit',
      reason: 'exclusive_worktree_fence_unavailable' } });
  assert.equal(nextReady(store.listTasks('alpha')).some((task) => task.id === 'held'), false);
  assert.throws(() => service.releaseTaskHold('alpha', 'held', {
    reason: 'operator approved', expectedReason: 'something-else', actor: { role: 'admin' },
  }), (error) => error.code === 'E_STALE_HOLD');
  const released = service.releaseTaskHold('alpha', 'held', {
    reason: 'operator approved', expectedReason: 'exclusive_worktree_fence_unavailable',
    actor: { role: 'admin' },
  });
  assert.equal(released.ok, true);
  assert.equal(store.getTask('held').hold, undefined);
  assert.equal(nextReady(store.listTasks('alpha')).some((task) => task.id === 'held'), true);
  assert.throws(() => service.releaseTaskHold('alpha', 'held', {
    reason: 'no authority', actor: { role: 'member', name: 'x' },
  }), (error) => error.code === 'E_FORBIDDEN');
  store.updateTask('held', { hold: { class: 'legacy_repair_manual', reason: 'legacy_repair_manual' } });
  assert.throws(() => service.releaseTaskHold('alpha', 'held', {
    reason: 'try', actor: { role: 'admin' },
  }), (error) => error.code === 'E_STATE');
  store.close();
});

test('B48 persisted fan-out creates review+known-repair once across reconciles', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ id: 'persisted-root', deliveryUnitId: 'persisted-root',
    sourceCommit: 'persisted-commit', verify: [], findings: [finding()], acceptance: ['works'] }));
  const first = await service.applyClosedLoop('alpha', store.getTask('persisted-root'));
  assert.equal(first.created.length, 2);
  await service.reconcileClosedLoop('alpha');
  await service.reconcileClosedLoop('alpha');
  const tasks = store.listTasks('alpha');
  assert.equal(tasks.filter((task) => task.kind === 'review').length, 1);
  assert.equal(tasks.filter((task) => task.kind === 'repair').length, 1);
  const review = tasks.find((task) => task.kind === 'review');
  const repair = tasks.find((task) => task.kind === 'repair');
  assert.equal(repair.mode, 'legacy');
  assert.equal(repair.contractSource, 'findings');
  assert.equal(repair.parentReviewTaskId, undefined);
  assert.equal(review.reviewedSourceCommit, 'persisted-commit');
  store.close();
});

test('B43 legacy pass review without reviewedSourceCommit blocks merge', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const root = legacyRoot({ id: 'unbound-root', deliveryUnitId: 'unbound-root' });
  const repair = { id: 'unbound-repair', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'legacy', round: 2, sourceTaskId: root.id, dependencies: [root.id],
    sourceCommit: 'repair-c', sourceBase: root.sourceCommit, acceptance: ['works'],
    inScope: ['src/'], verify: [VERIFY] };
  const review = { id: 'unbound-review', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', reviewMode: 'legacy', reviewedTaskId: repair.id, dependencies: [repair.id],
    assignee: 'Reviewer 01', assigneeId: 'm-reviewer', scores: { overall: 4.8, code: 4.8 } };
  store.addTask(root);
  store.addTask(repair);
  store.addTask(review);
  const target = service.resolveDeliveryMergeTarget('alpha', store.getTask(root.id));
  assert.equal(target.ok, false);
  assert.equal(target.blocked, 'review_unbound');
  store.close();
});

test('a failed prerequisite stops the rest of the planned fan-out batch', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const root = legacyRoot({ id: 'batch-root', deliveryUnitId: 'batch-root',
    findings: [finding()], verify: [VERIFY] });
  store.addTask(root);
  const plan = planCompletionFanOut({ task: root, tasks: [root] });
  assert.ok(plan.created.length >= 2);
  assert.equal(plan.created[0].kind, 'review');
  const original = service.createLoopTask.bind(service);
  const calls = [];
  service.createLoopTask = (_teamId, item) => {
    calls.push(item.id);
    return item.kind === 'review'
      ? { created: [], escalated: 1, error: 'review create failed' }
      : { created: [{ id: item.id }], escalated: 0 };
  };
  const result = service.createLoopTasks('alpha', plan.created, root);
  assert.deepEqual(calls, [plan.created[0].id]);
  assert.equal(result.error, 'follow-up batch stopped after a create failure');
  assert.deepEqual(result.created, []);
  service.createLoopTask = original;
  store.close();
});

test('releasing one hold preserves unrelated captain escalations', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'residual', teamId: 'alpha', kind: 'work', status: 'pending',
    subject: 'residual', dependencies: [], needsCaptain: true, bindingState: 'blocked',
    hold: { class: 'artifact_commit', reason: 'artifact_commit_failed', escalated: true } });
  const released = service.releaseTaskHold('alpha', 'residual', {
    reason: 'fix applied', expectedReason: 'artifact_commit_failed', actor: { role: 'admin' },
  });
  assert.equal(released.ok, true);
  assert.equal(store.getTask('residual').hold, undefined);
  assert.equal(store.getTask('residual').needsCaptain, true);
  store.close();
});

test('B44 a completed root with a failed review and a passing repair is audited through the repair', () => {
  const root = legacyRoot({ id: 'repair-root', deliveryUnitId: 'repair-root', deliverySeq: 0,
    sourceCommit: 'root-c', mergeState: 'merged', mergeCommit: 'repair-c', mergedCommit: 'repair-c' });
  const failed = failedLegacyReview({ id: 'root-review', reviewedTaskId: root.id, dependencies: [root.id] });
  const repair = { id: 'repair-after-root', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'legacy', sourceTaskId: root.id, dependencies: [root.id], sourceCommit: 'repair-c',
    acceptance: ['works'], inScope: ['src/'], verify: [VERIFY],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }], changedPaths: ['src/a.js'],
    mergeState: 'merged', mergeCommit: 'repair-c', mergedCommit: 'repair-c' };
  const pass = { id: 'repair-review', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', reviewMode: 'legacy', reviewedTaskId: repair.id,
    reviewedSourceCommit: repair.sourceCommit, dependencies: [repair.id],
    assignee: 'Reviewer 01', assigneeId: 'm-reviewer',
    acceptanceResults: [{ criterion: 'works', status: 'passed' }] };
  const audit = deliveryAudit({ phase: 'running', control: 'active', tasks: [root, failed, repair, pass] });
  assert.equal(audit.blockers.includes(`${root.id} has no passing review`), false);
  assert.equal(audit.blockers.includes(`${repair.id} has no passing review`), false);
});

test('B48 a findings-only repair can fail review and be repaired again', () => {
  const source = { id: 'findings-source', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'legacy', contractSource: 'findings', acceptance: ['works'], verify: [],
    inScope: ['src/'], outOfScope: [], sourceCommit: 'findings-c', dependencies: [] };
  const review = { id: 'findings-review', teamId: 'alpha', kind: 'review', status: 'failed',
    verdict: 'needs_revision', reviewMode: 'legacy', reviewedTaskId: source.id,
    reviewedSourceCommit: source.sourceCommit, dependencies: [source.id],
    findings: [finding()], round: 1, assignee: 'Reviewer 01', assigneeId: 'm-reviewer' };
  const plan = planFailedReviewFollowUp({ task: review, tasks: [source, review], policy: {} });
  assert.equal(plan.action, 'repair');
  assert.equal(plan.task.contractSource, 'findings');
  assert.deepEqual(plan.task.verify, []);
  assert.equal(plan.task.sourceBase, source.sourceCommit);
});

test('adopt retries recoverable failures instead of treating the first attempt as final', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ id: 'retry-adopt', mode: 'bound', deliveryUnitId: 'retry-adopt',
    sourceCommit: undefined, diffHash: undefined, worktree: join(tmpdir(), 'missing-adopt-retry'),
    worktreeBase: 'base', lastAttemptId: 'attempt-retry' }));
  const first = await service.adoptPendingCandidates({ teamId: 'alpha' });
  const second = await service.adoptPendingCandidates({ teamId: 'alpha' });
  assert.deepEqual(first.blocked, ['retry-adopt']);
  assert.deepEqual(second.blocked, ['retry-adopt']);
  store.close();
});

test('adopt retries missing worktree, unavailable fence, and generic failures with silent backoff', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-adopt-retry-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const artifactFenceProvider = {
      async acquire({ taskId }) {
        if (taskId === 'retry-generic') throw new Error('temporary fence startup failure');
        throw new Error(`unexpected fence request for ${taskId}`);
      },
    };
    const { store, service, advance } = setup({ artifactFenceProvider });
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    const candidate = (id, overrides = {}) => ({ id, teamId: 'alpha', kind: 'integration',
      status: 'completed', worktree: repo, sourceBase: base, worktreeBase: base,
      lastAttemptId: `attempt-${id}`, ...overrides });
    store.addTask(candidate('retry-missing', { worktree: join(repo, 'missing-worktree') }));
    store.addTask(candidate('retry-fence', { lastAttemptId: undefined }));
    store.addTask(candidate('retry-generic'));

    await service.reconcileClosedLoop('alpha');
    for (const id of ['retry-missing', 'retry-fence', 'retry-generic']) {
      const task = store.getTask(id);
      assert.equal(task.adoptAttempts, 1, `${id} should persist its first failed attempt`);
      assert.equal(task.adoptRetryAt, 6000, `${id} should use the same initial backoff`);
    }
    const eventCount = (type) => store.listEvents('alpha').filter((event) => event.type === type).length;
    const initialEvents = {
      blocked: eventCount('task.adopt_blocked'), failed: eventCount('task.adopt_failed'),
      sweep: eventCount('loop.adoption_sweep'),
    };
    assert.deepEqual(initialEvents, { blocked: 2, failed: 1, sweep: 1 });

    advance(1000);
    await service.reconcileClosedLoop('alpha');
    assert.deepEqual({
      blocked: eventCount('task.adopt_blocked'), failed: eventCount('task.adopt_failed'),
      sweep: eventCount('loop.adoption_sweep'),
    }, initialEvents, 'deferred retries must not write duplicate block or sweep events');
    for (const id of ['retry-missing', 'retry-fence', 'retry-generic']) {
      assert.equal(store.getTask(id).adoptAttempts, 1, `${id} must not retry before adoptRetryAt`);
    }

    const expectedRetryAt = [16000, 36000, 76000, 156000, undefined];
    for (const [index, delay] of [4000, 10000, 20000, 40000, 80000].entries()) {
      advance(delay);
      await service.reconcileClosedLoop('alpha');
      for (const id of ['retry-missing', 'retry-fence', 'retry-generic']) {
        const task = store.getTask(id);
        assert.equal(task.adoptAttempts, index + 2, `${id} should increment once when retried`);
        assert.equal(task.adoptRetryAt, expectedRetryAt[index],
          `${id} should use exponential backoff or clear its retry time at the limit`);
      }
    }
    for (const id of ['retry-missing', 'retry-fence', 'retry-generic']) {
      const task = store.getTask(id);
      assert.equal(task.adoptAttempts, 6, `${id} should stop after the retry limit`);
      assert.equal(task.mergeBlockReason, 'adopt_failed_terminal');
      assert.equal(task.adoptRetryAt, undefined);
    }
    assert.equal(eventCount('task.adopt_blocked'), 10,
      'missing worktree and unavailable fence each emit only on five attempted retries');
    assert.equal(eventCount('task.adopt_failed'), 5,
      'generic failures emit only on attempted retries');
    assert.equal(eventCount('task.adopt_failed_terminal'), 3,
      'all retry classes become terminal at the same limit');
    assert.equal(eventCount('loop.adoption_sweep'), 6,
      'sweeps occur for attempts, but not for the intervening deferred tick');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('release-hold requires an expectedReason', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'reason-hold', teamId: 'alpha', kind: 'work', status: 'pending',
    subject: 'reason', dependencies: [], hold: { class: 'artifact_commit', reason: 'artifact_commit_failed' } });
  assert.throws(() => service.releaseTaskHold('alpha', 'reason-hold', {
    reason: 'operator approved', actor: { role: 'admin' },
  }), (error) => error.code === 'E_INVALID');
  store.close();
});

test('restart releases a stale publication guard and keeps the task escalated', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ id: 'guarded-task', mergeState: 'review_pending' }));
  store.updateTeam('alpha', { publicationGuard: { operationId: 'op-1', taskId: 'guarded-task',
    state: 'unknown', expectedCommit: 'root-commit' } });
  const result = await service.reconcileAfterRestart();
  assert.equal(store.getTeam('alpha').publicationGuard, undefined);
  assert.equal(store.getTask('guarded-task').needsCaptain, true);
  assert.equal(store.getTask('guarded-task').publicationRecoveryState, 'guard_released_after_restart');
  assert.ok(result.tasks !== undefined);
  store.close();
});

test('legacy repair dispatch starts from its source commit, not the team base', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-repair-base-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', '-c', 'implementation'], { cwd: repo });
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.js'), 'implementation', 'utf8');
    execFileSync('git', ['add', 'src/a.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'implementation'], { cwd: repo });
    const implementation = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', 'main'], { cwd: repo });

    const artifactFenceProvider = {
      async acquire(input) {
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => {} };
      },
    };
    const { config, store, service } = setup({ artifactFenceProvider });
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.useWorktrees = true;
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
    store.addTask({ id: 'source', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', subject: 'source', dependencies: [], assignee: 'Engineer 01',
      assigneeRole: 'engineer', acceptance: ['works'], verify: [VERIFY], inScope: ['src/'],
      sourceBase: base, sourceCommit: implementation, deliveryUnitId: 'source', deliverySeq: 0 });
    store.addTask({ id: 'repair-base', teamId: 'alpha', kind: 'repair', status: 'pending',
      mode: 'legacy', subject: 'repair', dependencies: ['source'], sourceTaskId: 'source',
      assignee: 'Engineer 01', assigneeRole: 'engineer', acceptance: ['works'], verify: [VERIFY],
      inScope: ['src/'], sourceBase: implementation, repairOrigin: 'planner' });
    await service.tick('alpha');
    const live = store.getTask('repair-base');
    assert.equal(live.status, 'in_progress');
    assert.equal(existsSync(join(live.worktree, 'src', 'a.js')), true,
      'repair worktree must contain the source implementation');
    writeFileSync(join(live.worktree, 'src', 'repair.js'), 'repair', 'utf8');
    const done = await service.completeTask({ teamId: 'alpha', taskId: 'repair-base', attemptId: live.attemptId,
      update: { status: 'completed', acceptanceResults: [{ criterion: 'works', status: 'passed' }] } });
    assert.equal(done.ok, true, done.error);
    assert.equal(store.getTask('repair-base').sourceBase, implementation);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('legacy root plus repair merges the complete reviewed range and audits through the repair', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-merge-range-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', '-c', 'delivery'], { cwd: repo });
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'impl.js'), 'implementation', 'utf8');
    execFileSync('git', ['add', 'src/impl.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'implementation'], { cwd: repo });
    const implementation = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'src', 'repair.js'), 'repair', 'utf8');
    execFileSync('git', ['add', 'src/repair.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'repair'], { cwd: repo });
    const repairCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', 'main'], { cwd: repo });

    const { config, store, service } = setup();
    config.quality.postMergeReview = 'off';
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'range-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', round: 1, subject: 'root', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceBase: base,
      sourceCommit: implementation, deliveryUnitId: 'range-root', deliverySeq: 0,
      acceptanceResults: [{ criterion: 'works', status: 'passed' }], changedPaths: ['src/impl.js'] });
    store.addTask({ id: 'range-review', teamId: 'alpha', kind: 'review', status: 'failed',
      verdict: 'needs_revision', reviewMode: 'legacy', reviewedTaskId: 'range-root',
      dependencies: ['range-root'], round: 1, assignee: 'Reviewer 01', findings: [finding()] });
    store.addTask({ id: 'range-repair', teamId: 'alpha', kind: 'repair', status: 'completed',
      mode: 'legacy', round: 2, sourceTaskId: 'range-root', dependencies: ['range-root'],
      attach: 'Engineer 01', assignee: 'Engineer 01', acceptance: ['works'], verify: [VERIFY],
      inScope: ['src/'], sourceBase: implementation, sourceCommit: repairCommit,
      acceptanceResults: [{ criterion: 'works', status: 'passed' }], changedPaths: ['src/repair.js'] });
    store.addTask({ id: 'range-pass', teamId: 'alpha', kind: 'review', status: 'completed',
      verdict: 'pass', reviewMode: 'legacy', reviewedTaskId: 'range-repair',
      reviewedSourceCommit: repairCommit, dependencies: ['range-repair'], round: 2,
      assignee: 'Reviewer 01', acceptanceResults: [{ criterion: 'works', status: 'passed' }] });
    const merged = await service.mergeTask('alpha', 'range-repair');
    assert.equal(merged.ok, true, merged.error);
    assert.equal(existsSync(join(repo, 'src', 'impl.js')), true, 'implementation must reach main');
    assert.equal(existsSync(join(repo, 'src', 'repair.js')), true, 'repair must reach main');
    assert.equal(store.getTask('range-root').mergeState, 'merged');
    assert.equal(store.getTask('range-repair').mergeState, 'merged');
    const audit = deliveryAudit({ phase: 'running', control: 'active', tasks: store.listTasks('alpha') });
    assert.equal(audit.blockers.some((item) => item.includes('has no passing review')), false, audit.blockers.join('\n'));
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a completed work task still merges without a delivery unit', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-work-merge-'));
  const worktree = join(repo, 'work');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'work-branch', worktree, 'main'], { cwd: repo });
    writeFileSync(join(worktree, 'work.txt'), 'work output', 'utf8');

    const artifactFenceProvider = {
      async acquire(input) {
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => {} };
      },
    };
    const { config, store, service } = setup({ artifactFenceProvider });
    config.quality.postMergeReview = 'off';
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'work-task', teamId: 'alpha', kind: 'work', status: 'completed',
      mode: 'legacy', subject: 'work', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], worktree,
      worktreeBase: base, lastAttemptId: 'work-attempt' });
    const merged = await service.mergeTask('alpha', 'work-task');
    assert.equal(merged.ok, true, merged.error);
    assert.equal(store.getTask('work-task').mergeState, 'merged');
    assert.equal(existsSync(join(repo, 'work.txt')), true);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a merge conflict releases the publication guard instead of freezing the store', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-conflict-'));
  const worktree = join(repo, 'work-conflict');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'conflict-branch', worktree, 'main'], { cwd: repo });
    writeFileSync(join(worktree, 'README.md'), 'worktree', 'utf8');
    writeFileSync(join(repo, 'README.md'), 'main', 'utf8');
    execFileSync('git', ['commit', '-am', 'main change'], { cwd: repo });

    const artifactFenceProvider = {
      async acquire(input) {
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => {} };
      },
    };
    const { config, store, service } = setup({ artifactFenceProvider });
    config.quality.postMergeReview = 'off';
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'conflict-task', teamId: 'alpha', kind: 'work', status: 'completed',
      mode: 'legacy', subject: 'conflict', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['README.md'], worktree,
      worktreeBase: base, lastAttemptId: 'conflict-attempt' });
    const result = await service.mergeTask('alpha', 'conflict-task');
    assert.equal(result.ok, false);
    assert.equal(store.getTeam('alpha').publicationGuard, undefined);
    assert.equal(store.getTask('conflict-task').mergeState, 'conflict');
    assert.doesNotThrow(() => store.updateTeam('alpha', { needsCaptain: true }));
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a failed fast-forward can retry publication without re-running the review', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-ff-retry-'));
  const integrationWorktree = join(repo, 'integration-retry');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    execFileSync('git', ['worktree', 'add', '-b', 'integration/retry', integrationWorktree, 'main'], { cwd: repo });
    writeFileSync(join(integrationWorktree, 'published.txt'), 'published', 'utf8');
    execFileSync('git', ['add', 'published.txt'], { cwd: integrationWorktree });
    execFileSync('git', ['commit', '-m', 'integrated'], { cwd: integrationWorktree });
    const integrationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: integrationWorktree, encoding: 'utf8' }).trim();

    const { config, store, service } = setup();
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'ff-task', teamId: 'alpha', kind: 'work', status: 'completed',
      mode: 'legacy', subject: 'ff', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], mergeState: 'ff_failed', postMergeReview: 'pass',
      mergeCommit: integrationCommit, integrationCommit,
      integrationBranch: 'integration/retry', integrationWorktree, ffAttempt: 1 });
    const result = await service.mergeTask('alpha', 'ff-task');
    assert.equal(result.ok, false, 'cleanup evidence is intentionally absent');
    assert.equal(store.getTask('ff-task').mergeState, 'merged');
    assert.equal(existsSync(join(repo, 'published.txt')), true);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a completed integration worktree is adopted without a delivery unit', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-integration-adopt-'));
  const worktree = join(repo, 'integration-worktree');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'integration/adopt', worktree, 'main'], { cwd: repo });
    writeFileSync(join(worktree, 'integrated.txt'), 'integrated', 'utf8');
    const artifactFenceProvider = {
      async acquire(input) {
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => {} };
      },
    };
    const { config, store, service } = setup({ artifactFenceProvider });
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'integration-adopt', teamId: 'alpha', kind: 'integration', status: 'completed',
      mode: 'legacy', subject: 'integration', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], worktree, worktreeBase: base, sourceBase: base,
      inScope: ['integrated.txt'], lastAttemptId: 'attempt-integration' });
    const result = await service.adoptPendingCandidates({ teamId: 'alpha' });
    const adopted = store.getTask('integration-adopt');
    assert.deepEqual(result.adopted, ['integration-adopt']);
    assert.match(adopted.sourceCommit, /^[0-9a-f]{40}$/);
    assert.equal(adopted.bindingState, 'not_applicable');
    assert.equal(adopted.deliveryUnitId, undefined);
    config.quality.postMergeReview = 'off';
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    const merged = await service.mergeTask('alpha', 'integration-adopt');
    assert.equal(merged.ok, true, merged.error);
    assert.equal(store.getTask('integration-adopt').mergeState, 'merged');
    assert.equal(existsSync(join(repo, 'integrated.txt')), true);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('concurrent adopt and reconcile serialize a clean success against a dirty candidate', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-adopt-concurrency-'));
  const cleanWorktree = join(repo, 'clean-worktree');
  const cleanWorktreeTwo = join(repo, 'clean-worktree-two');
  const dirtyWorktree = join(repo, 'dirty-worktree');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'clean-adopt', cleanWorktree, 'main'], { cwd: repo });
    execFileSync('git', ['worktree', 'add', '-b', 'clean-adopt-two', cleanWorktreeTwo, 'main'], { cwd: repo });
    execFileSync('git', ['worktree', 'add', '-b', 'dirty-adopt', dirtyWorktree, 'main'], { cwd: repo });
    writeFileSync(join(cleanWorktree, 'clean.txt'), 'clean', 'utf8');
    writeFileSync(join(cleanWorktreeTwo, 'clean-two.txt'), 'clean two', 'utf8');
    writeFileSync(join(dirtyWorktree, 'dirty.txt'), 'dirty', 'utf8');
    const artifactFenceProvider = {
      async acquire(input) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => {} };
      },
    };
    const { store, service } = setup({ artifactFenceProvider });
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'clean-adopt', teamId: 'alpha', kind: 'integration', status: 'completed',
      mode: 'legacy', subject: 'clean', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], worktree: cleanWorktree, worktreeBase: base,
      sourceBase: base, inScope: ['clean.txt'], lastAttemptId: 'attempt-clean' });
    store.addTask({ id: 'clean-adopt-two', teamId: 'alpha', kind: 'integration', status: 'completed',
      mode: 'legacy', subject: 'clean two', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], worktree: cleanWorktreeTwo, worktreeBase: base,
      sourceBase: base, inScope: ['clean-two.txt'], lastAttemptId: 'attempt-clean-two' });
    store.addTask({ id: 'dirty-adopt', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'bound', subject: 'dirty', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], worktree: dirtyWorktree, worktreeBase: base,
      sourceBase: base, inScope: ['dirty.txt'], lastAttemptId: 'attempt-dirty' });

    const [adoptResult, reconcileResult] = await Promise.all([
      service.adoptPendingCandidates({ teamId: 'alpha' }),
      service.reconcileClosedLoop('alpha'),
    ]);
    assert.deepEqual(adoptResult.adopted, ['clean-adopt', 'clean-adopt-two']);
    assert.equal(reconcileResult.created, 0,
      'the serialized callers must finish the clean adoption and closed-loop sweep');
    const clean = store.getTask('clean-adopt');
    const dirty = store.getTask('dirty-adopt');
    assert.match(clean.sourceCommit, /^[0-9a-f]{40}$/);
    assert.notEqual(clean.mergeState, 'blocked');
    assert.notEqual(clean.mergeBlockReason, 'adopt_dirty_requires_review');
    const cleanTwo = store.getTask('clean-adopt-two');
    assert.match(cleanTwo.sourceCommit, /^[0-9a-f]{40}$/);
    assert.notEqual(cleanTwo.mergeState, 'blocked');
    assert.equal(dirty.sourceCommit, undefined);
    assert.equal(dirty.mergeState, 'blocked');
    assert.equal(dirty.mergeBlockReason, 'adopt_dirty_requires_review');
    assert.equal(dirty.needsCaptain, true);
    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'task.adopted').length, 2);
    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'task.adopt_blocked')
      .filter((event) => event.taskId === 'dirty-adopt').length, 1);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a fence-acquired adoption releases and defers when the task changes before commit', async () => {
  // This targets the re-read that sits *between* `acquire()` returning and
  // `commitArtifactBeforeReview()` starting. The other adoption race test
  // mutates the row inside `acquire()`, so the commit path also fails and the
  // test would still pass with that particular re-read deleted. Here the fence
  // is valid and the artifact is committable; only the post-acquire snapshot
  // check can notice the concurrent block, so removing it makes this test fail.
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-adopt-post-acquire-'));
  const worktree = join(repo, 'worktree');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'post-acquire', worktree, 'main'], { cwd: repo });
    writeFileSync(join(worktree, 'artifact.txt'), 'artifact', 'utf8');
    let releaseCount = 0;
    let acquireReturned = false;
    const { store, service } = setup({
      artifactFenceProvider: {
        async acquire(input) {
          acquireReturned = true;
          return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
            verify: async () => true, release: async () => { releaseCount += 1; } };
        },
      },
    });
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'post-acquire', teamId: 'alpha', kind: 'integration', status: 'completed',
      mode: 'legacy', subject: 'post acquire', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], worktree, worktreeBase: base, sourceBase: base,
      inScope: ['artifact.txt'], lastAttemptId: 'attempt-post-acquire' });
    // Land the concurrent change after acquire() has returned and before the
    // commit starts, by hooking the store update the way a reopen would.
    const originalGetTask = store.getTask.bind(store);
    let flipped = false;
    store.getTask = (taskId) => {
      if (taskId === 'post-acquire' && acquireReturned && !flipped) {
        flipped = true;
        store.updateTask(taskId, {
          mergeState: 'blocked', mergeBlockReason: 'adopt_dirty_requires_review',
          adoptBlockedReason: 'adopt_dirty_requires_review', bindingState: 'blocked', needsCaptain: true,
        });
      }
      return originalGetTask(taskId);
    };
    const result = await service.adoptPendingCandidates({ teamId: 'alpha' });
    store.getTask = originalGetTask;
    const task = store.getTask('post-acquire');
    assert.deepEqual(result.adopted, [], 'a task that changed after the fence must not be adopted');
    assert.ok(result.deferred.includes('post-acquire'), `expected a deferral, got ${JSON.stringify(result)}`);
    assert.equal(task.sourceCommit, undefined, 'no source commit may be written over the newer block');
    assert.equal(task.mergeState, 'blocked');
    assert.equal(task.mergeBlockReason, 'adopt_dirty_requires_review');
    assert.equal(releaseCount, 1, 'the acquired fence is released when the snapshot is stale');
    // The decisive difference from the commit-time re-read: with the
    // post-acquire check in place, no commit is ever attempted, so the branch
    // the task was on before the race is still what it points at. If that check
    // is removed, the artifact is committed first and only then discarded.
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    assert.equal(headAfter, base, 'the stale decision must not commit an artifact before deferring');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('adoption rereads task state after fence acquisition and never mixes source commit with a new block', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-adopt-fence-race-'));
  const worktree = join(repo, 'worktree');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'fence-race', worktree, 'main'], { cwd: repo });
    writeFileSync(join(worktree, 'artifact.txt'), 'artifact', 'utf8');
    let releaseCount = 0;
    const { store, service } = setup({
      artifactFenceProvider: {
        async acquire(input) {
          store.updateTask('fence-race', {
            mergeState: 'blocked', mergeBlockReason: 'adopt_dirty_requires_review',
            adoptBlockedReason: 'adopt_dirty_requires_review', bindingState: 'blocked', needsCaptain: true,
          });
          return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
            verify: async () => true, release: async () => { releaseCount += 1; } };
        },
      },
    });
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'fence-race', teamId: 'alpha', kind: 'integration', status: 'completed',
      mode: 'legacy', subject: 'fence race', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], worktree, worktreeBase: base, sourceBase: base,
      inScope: ['artifact.txt'], lastAttemptId: 'attempt-fence-race' });
    const result = await service.adoptPendingCandidates({ teamId: 'alpha' });
    const task = store.getTask('fence-race');
    assert.deepEqual(result.adopted, []);
    assert.deepEqual(result.deferred, ['fence-race']);
    assert.equal(task.sourceCommit, undefined);
    assert.equal(task.mergeState, 'blocked');
    assert.equal(task.mergeBlockReason, 'adopt_dirty_requires_review');
    assert.equal(task.needsCaptain, true);
    assert.equal(releaseCount, 1);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('adoption success clears only its own block and recomputes team captain alert conservatively', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-adopt-alerts-'));
  const worktree = join(repo, 'worktree');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'alert-adopt', worktree, 'main'], { cwd: repo });
    writeFileSync(join(worktree, 'artifact.txt'), 'artifact', 'utf8');
    const { store, service } = setup({ artifactFenceProvider: {
      async acquire(input) {
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => {} };
      },
    } });
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    // `createTeam` intentionally accepts only a fixed field set, so the alert
    // must be set through the store: passing it into createTeam silently drops
    // it and the reset assertion below would be vacuously true.
    store.updateTeam('alpha', { needsCaptain: true });
    assert.equal(store.getTeam('alpha').needsCaptain, true, 'the team alert precondition is real');
    store.addTask({ id: 'alert-adopt', teamId: 'alpha', kind: 'integration', status: 'completed',
      mode: 'legacy', subject: 'alert', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], worktree, worktreeBase: base, sourceBase: base,
      inScope: ['artifact.txt'], lastAttemptId: 'attempt-alert', mergeState: 'blocked',
      mergeBlockReason: 'adopt_worktree_missing', adoptBlockedReason: 'adopt_worktree_missing',
      adoptAttempts: 1, needsCaptain: true });
    await service.adoptPendingCandidates({ teamId: 'alpha' });
    const adopted = store.getTask('alert-adopt');
    assert.match(adopted.sourceCommit, /^[0-9a-f]{40}$/);
    assert.equal(adopted.mergeState, undefined);
    assert.equal(adopted.mergeBlockReason, undefined);
    assert.equal(adopted.adoptAttempts, 0);
    assert.equal(adopted.needsCaptain, false);
    assert.equal(store.getTeam('alpha').needsCaptain, false,
      'a resolved adoption clears the team alert it caused');

    const secondWorktree = join(repo, 'second-worktree');
    execFileSync('git', ['worktree', 'add', '-b', 'alert-adopt-second', secondWorktree, 'main'], { cwd: repo });
    writeFileSync(join(secondWorktree, 'second.txt'), 'second', 'utf8');
    store.addTask({ id: 'alert-adopt-second', teamId: 'alpha', kind: 'integration', status: 'completed',
      mode: 'legacy', subject: 'alert second', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], worktree: secondWorktree, worktreeBase: base, sourceBase: base,
      inScope: ['second.txt'], lastAttemptId: 'attempt-alert-second', mergeState: 'blocked',
      mergeBlockReason: 'adopt_worktree_missing', adoptBlockedReason: 'adopt_worktree_missing',
      adoptAttempts: 1, needsCaptain: true });
    store.addTask({ id: 'other-alert', teamId: 'alpha', kind: 'work', status: 'pending',
      subject: 'unrelated captain alert', dependencies: [], needsCaptain: true });
    store.updateTeam('alpha', { needsCaptain: true });
    const second = await service.adoptPendingCandidates({ teamId: 'alpha' });
    assert.deepEqual(second.adopted, ['alert-adopt-second']);
    assert.equal(store.getTask('alert-adopt-second').mergeState, undefined);
    assert.equal(store.getTask('alert-adopt-second').needsCaptain, false);
    assert.equal(store.getTask('other-alert').needsCaptain, true);
    assert.equal(store.getTeam('alpha').needsCaptain, true,
      'adopting one task must preserve another task captain alert');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('missing unit inheritance emits one terminal adoption block event across repeated sweeps', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'missing-unit', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'bound', subject: 'missing unit', dependencies: [], deliveryUnitId: 'root',
    worktree: '/not-used-for-this-terminal-block', lastAttemptId: 'attempt-missing-unit' });
  await service.adoptPendingCandidates({ teamId: 'alpha' });
  await service.reconcileClosedLoop('alpha');
  const task = store.getTask('missing-unit');
  assert.equal(task.mergeState, 'blocked');
  assert.equal(task.mergeBlockReason, 'missing_unit_inheritance');
  assert.equal(task.needsCaptain, true);
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'task.adopt_blocked'
    && event.taskId === 'missing-unit').length, 1);
  store.close();
});

test('publication guard blocks adoption per task with backoff instead of failing the team tick', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-adopt-publication-'));
  const worktree = join(repo, 'worktree');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'publication-adopt', worktree, 'main'], { cwd: repo });
    writeFileSync(join(worktree, 'artifact.txt'), 'artifact', 'utf8');
    const { store, service, advance } = setup({ artifactFenceProvider: {
      async acquire(input) {
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => {} };
      },
    } });
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
    store.addTask({ id: 'publication-adopt', teamId: 'alpha', kind: 'integration', status: 'completed',
      mode: 'legacy', subject: 'publication', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], worktree, worktreeBase: base, sourceBase: base,
      inScope: ['artifact.txt'], lastAttemptId: 'attempt-publication' });
    store.updateTeam('beta', { publicationGuard: { operationId: 'held-publication', taskId: 'other', state: 'publishing' } });
    const firstHeldTicks = await service.tickAll();
    assert.equal(firstHeldTicks.find((result) => result.teamId === 'alpha').blocked, 'publication-held');
    const repeatedHeldTicks = await service.tickAll();
    assert.equal(repeatedHeldTicks.find((result) => result.teamId === 'alpha').blocked, 'publication-held');
    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'team.tick_failed').length, 0);
    const heldLoop = await service.reconcileClosedLoop('alpha');
    assert.equal(heldLoop.skipped, 'publication-held');
    const heldTick = await service.tick('alpha');
    assert.equal(heldTick.blocked, 'publication-held');
    const repeatedHeldTick = await service.tick('alpha');
    assert.equal(repeatedHeldTick.blocked, 'publication-held');
    assert.equal(repeatedHeldTick.deferred, 1, 'a live publication hold is deferred during backoff');
    await service.reconcileClosedLoop('alpha');
    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'task.adopt_blocked'
      && event.taskId === 'publication-adopt').length, 1);
    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'team.tick_failed').length, 0,
      'a publication hold is isolated at the task/tick boundary without failure spam');
    store.updateTeam('beta', { publicationGuard: undefined }, { publicationOwner: 'held-publication' });
    advance(5000);
    const result = await service.adoptPendingCandidates({ teamId: 'alpha' });
    assert.deepEqual(result.adopted, ['publication-adopt']);
    assert.match(store.getTask('publication-adopt').sourceCommit, /^[0-9a-f]{40}$/);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a cancelled post-merge repair is re-planned with a new generation', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'rejected-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'legacy', subject: 'root', objective: 'works', dependencies: [], assignee: 'Engineer 01',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceBase: 'base',
    sourceCommit: 'source-c', mergeCommit: 'source-c', mergeState: 'rejected',
    postMergeReview: 'needs_revision', deliveryUnitId: 'rejected-root', deliverySeq: 0,
    repairTaskId: 'old-postmerge-repair',
    negativeMergeIntent: { phase: 'settled', operationId: 'op-1', verdict: 'needs_revision',
      evidence: 'fix src/a.js',
      findings: [finding({ file: 'src/domain/gates.mjs', requiredFix: 'fix src/domain/gates.mjs' })],
      mergeCommit: 'source-c' } });
  store.addTask({ id: 'old-postmerge-repair', teamId: 'alpha', kind: 'repair', status: 'cancelled',
    mode: 'legacy', objective: 'repair', sourceTaskId: 'rejected-root', dependencies: ['rejected-root'],
    sourceBase: 'source-c', repairGeneration: 0, repairKey: 'old-key', acceptance: ['works'],
    verify: [VERIFY], inScope: ['src/'] });
  service.reconcilePostMergeRepairs('alpha');
  const root = store.getTask('rejected-root');
  const repair = store.listTasks('alpha').find((task) => task.kind === 'repair' && task.id !== 'old-postmerge-repair');
  assert.ok(repair, 'a new repair generation must be created');
  assert.equal(repair.status, 'pending');
  assert.equal(repair.id === 'old-postmerge-repair', false);
  assert.equal(root.repairTaskId, repair.id);
  assert.equal(root.repairPlanPending, false);
  store.close();
});

test('cancel cascades through the unit and reopen archives the old review', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'cancel-root', teamId: 'alpha', kind: 'implementation', status: 'pending',
    mode: 'legacy', subject: 'root', objective: 'works', dependencies: [], assignee: 'Engineer 01',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'] });
  store.addTask({ id: 'cancel-review', teamId: 'alpha', kind: 'review', status: 'pending',
    reviewedTaskId: 'cancel-root', dependencies: ['cancel-root'], subject: 'review' });
  store.addTask({ id: 'cancel-dependent', teamId: 'alpha', kind: 'verification', status: 'pending',
    dependencies: ['cancel-root'], subject: 'dependent', verify: [VERIFY] });
  const result = service.cancelTask('alpha', 'cancel-root', { reason: 'superseded', actor: { role: 'admin' } });
  assert.deepEqual(result.cancelled.sort(), ['cancel-dependent', 'cancel-review', 'cancel-root']);
  assert.equal(store.getTask('cancel-review').archived, true);
  assert.equal(store.getTask('cancel-dependent').status, 'cancelled');
  const reopened = service.reopenTask('alpha', 'cancel-root', { reason: 'restore', actor: { role: 'admin' } });
  assert.equal(reopened.ok, true);
  assert.equal(store.getTask('cancel-root').status, 'pending');
  assert.equal(store.getTask('cancel-review').archived, true);
  assert.equal(store.getTask('cancel-review').archivedReason, 'reopen: restore');
  store.close();
});

test('delivery merged receipt records the actual published commit', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ id: 'receipt-root', deliveryUnitId: 'receipt-root', deliverySeq: 0 }));
  const root = store.getTask('receipt-root');
  service.markDeliveryMerged('alpha', { root, newest: root, group: [root] }, 'published-commit');
  const merged = store.getTask('receipt-root');
  assert.equal(merged.mergeCommit, 'root-commit');
  assert.equal(merged.mergedCommit, 'published-commit');
  assert.equal(merged.bindingState, 'merged');
  store.close();
});

test('failed-root audit uses the reviewed mergeCommit and the applied mergedCommit separately', () => {
  const root = legacyRoot({ id: 'froot', status: 'failed', deliveryUnitId: 'froot',
    deliverySeq: 0, sourceCommit: 'root-c' });
  const repair = { id: 'frepair', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'legacy', sourceTaskId: root.id, dependencies: [root.id], sourceCommit: 'reviewed-repair',
    mergeState: 'merged', mergeCommit: 'reviewed-repair', mergedCommit: 'published-repair',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }], changedPaths: ['src/a.js'] };
  const review = { id: 'freview', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', reviewMode: 'legacy', reviewedTaskId: repair.id,
    reviewedSourceCommit: 'reviewed-repair', dependencies: [repair.id],
    assignee: 'Reviewer 01', assigneeId: 'm-reviewer',
    acceptanceResults: [{ criterion: 'works', status: 'passed' }] };
  const deliveredRoot = { ...root, closedLoop: { deliveredBy: repair.id } };
  const audit = deliveryAudit({ phase: 'running', control: 'active', tasks: [deliveredRoot, repair, review] });
  assert.equal(audit.blockers.includes(`${root.id}: unit_not_merged`), false, audit.blockers.join('\n'));
});

test('bound delivery resolution ignores repairs from an older task generation after reopen', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ id: 'gen-root', mode: 'bound', deliveryUnitId: 'gen-root',
    deliverySeq: 0, taskEpoch: 1, sourceBase: 'base-c', sourceCommit: 'root-c' }));
  store.addTask({ id: 'gen-old-repair', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'bound', sourceTaskId: 'gen-root', deliveryUnitId: 'gen-root', deliverySeq: 2,
    deliveryGeneration: 0, sourceBase: 'root-c', sourceCommit: 'old-repair-c',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'] });
  store.addTask({ id: 'gen-review', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', reviewMode: 'bound', reviewedTaskId: 'gen-root', reviewEpoch: 0,
    unitReviewSeq: 1, deliveryGeneration: 1,
    binding: { deliveryUnitId: 'gen-root', deliverySeq: 0, sourceTaskId: 'gen-root',
      sourceBase: 'base-c', sourceCommit: 'root-c', diffHash: 'root-diff' },
    scores: { overall: 4.6, code: 4.6 }, assignee: 'Reviewer 01', assigneeId: 'm-reviewer' });
  const target = service.resolveDeliveryMergeTarget('alpha', store.getTask('gen-root'));
  assert.equal(target.ok, true, target.error);
  assert.equal(target.newest.id, 'gen-root');
  store.close();
});

test('non-delivery merge refuses sensitive or undeclared worktree files', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-work-scope-'));
  const worktree = join(repo, 'work-scope');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'scope-branch', worktree, 'main'], { cwd: repo });
    writeFileSync(join(worktree, 'work.txt'), 'ok', 'utf8');
    writeFileSync(join(worktree, 'credentials.json'), '{"secret":true}', 'utf8');
    const artifactFenceProvider = {
      async acquire(input) {
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => {} };
      },
    };
    const { config, store, service } = setup({ artifactFenceProvider });
    config.quality.postMergeReview = 'off';
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'scope-work', teamId: 'alpha', kind: 'work', status: 'completed',
      mode: 'legacy', subject: 'scope', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['work.txt'], worktree,
      worktreeBase: base, lastAttemptId: 'scope-attempt' });
    const result = await service.mergeTask('alpha', 'scope-work');
    assert.equal(result.ok, false);
    assert.match(result.error, /illegal_or_out_of_scope_path/);
    assert.equal(existsSync(join(repo, 'credentials.json')), false);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('cleanupPending retries through mergeTask without re-publishing', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'cleanup-task', teamId: 'alpha', kind: 'work', status: 'completed',
    subject: 'cleanup', dependencies: [], mergeState: 'merged', cleanupPending: true,
    mergeReviewError: 'worktree removal failed' });
  const result = await service.mergeTask('alpha', 'cleanup-task');
  assert.equal(result.ok, true);
  assert.equal(store.getTask('cleanup-task').cleanupPending, false);
  assert.equal(store.getTask('cleanup-task').mergeReviewError, undefined);
  store.close();
});

test('retryCleanup clears the integration branch and ownership pointers on success', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-cleanup-retry-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'base', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const branch = 'integration/alpha/cleanup-retry/1';
    execFileSync('git', ['branch', branch, base], { cwd: repo });
    const worktree = join(repo, 'cleanup-retry-wt');
    execFileSync('git', ['worktree', 'add', worktree, branch], { cwd: repo });
    const { store, service } = setup();
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'cleanup-retry', teamId: 'alpha', kind: 'work', status: 'completed',
      subject: 'cleanup retry', mergeState: 'merged', cleanupPending: true,
      integrationBranch: branch, integrationWorktree: worktree,
      integrationOwnership: { token: 'cleanup-retry-token', operationId: 'cleanup-retry-op',
        canonicalRepo: realpathSync.native(repo), branch,
        worktree: realpathSync.native(worktree), refOid: base } });
    const result = await service.retryCleanup('alpha', 'cleanup-retry');
    assert.equal(result.ok, true, result.error);
    const task = store.getTask('cleanup-retry');
    assert.equal(task.cleanupPending, false);
    assert.equal(task.integrationBranch, undefined);
    assert.equal(task.integrationWorktree, undefined);
    assert.equal(task.integrationOwnership, undefined);
    assert.equal(existsSync(worktree), false);
    assert.throws(() => execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }));
    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'merge.cleanup_retried').length, 1);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a surviving commit from an orphaned attempt can be rebound after a DB failure', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-rebind-'));
  const worktree = join(repo, 'rebind-worktree');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'rebind-branch', worktree, 'main'], { cwd: repo });
    mkdirSync(join(worktree, 'src'));
    writeFileSync(join(worktree, 'src', 'a.js'), 'artifact', 'utf8');
    execFileSync('git', ['add', 'src/a.js'], { cwd: worktree });
    execFileSync('git', ['-c', 'user.name=Ai-Agent-Teams', '-c', 'user.email=ai-agent-teams@local.invalid',
      'commit', '--no-verify', '-m', 'agent-teams: alpha/rebind-task',
      '-m', `Agent-Teams-Task: alpha/rebind-task\nAgent-Teams-Attempt: old-attempt\nAgent-Teams-Base: ${base}`], { cwd: worktree });
    const surviving = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();

    const artifactFenceProvider = {
      async acquire(input) {
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => {} };
      },
    };
    const { store, service } = setup({ artifactFenceProvider });
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'rebind-task', teamId: 'alpha', kind: 'implementation', status: 'in_progress',
      mode: 'bound', subject: 'rebind', objective: 'works', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], deliveryUnitId: 'rebind-task',
      deliverySeq: 0, taskEpoch: 0, controlEpoch: 0, attemptId: 'new-attempt',
      lastAttemptId: 'new-attempt', worktree, worktreeBase: base });
    store.addAttempt({ id: 'old-attempt', teamId: 'alpha', taskId: 'rebind-task',
      attempt: 1, assignee: 'Engineer 01', status: 'orphaned', taskEpoch: 0, controlEpoch: 0 });
    store.addAttempt({ id: 'new-attempt', teamId: 'alpha', taskId: 'rebind-task',
      attempt: 2, assignee: 'Engineer 01', status: 'claimed', taskEpoch: 0, controlEpoch: 0 });
    const result = await service.completeTask({ teamId: 'alpha', taskId: 'rebind-task', attemptId: 'new-attempt',
      update: { status: 'completed', acceptanceResults: [{ criterion: 'works', status: 'passed' }],
        changedPaths: ['src/a.js'] } });
    assert.equal(result.ok, true, result.error);
    assert.equal(store.getTask('rebind-task').sourceCommit, surviving);
    assert.equal(store.getTask('rebind-task').status, 'completed');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('completed work closeout commits once and is idempotent', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-closeout-'));
  const worktree = join(repo, 'closeout-work');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'closeout-branch', worktree, 'main'], { cwd: repo });
    writeFileSync(join(worktree, 'result.txt'), 'done', 'utf8');
    const artifactFenceProvider = {
      async acquire(input) {
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => {} };
      },
    };
    const { store, service } = setup({ artifactFenceProvider });
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'closeout-work', teamId: 'alpha', kind: 'work', status: 'completed',
      mode: 'legacy', subject: 'closeout', dependencies: [], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], worktree, worktreeBase: base,
      lastAttemptId: 'closeout-attempt' });
    const first = await service.closeoutCompletedWork({ teamId: 'alpha' });
    assert.deepEqual(first.closed, ['closeout-work']);
    const committed = store.getTask('closeout-work').sourceCommit;
    assert.match(committed, /^[0-9a-f]{40}$/);
    const second = await service.closeoutCompletedWork({ teamId: 'alpha' });
    assert.deepEqual(second.closed, []);
    assert.equal(store.getTask('closeout-work').sourceCommit, committed);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('B43 a reopened legacy delivery reviews in the new epoch and resolves as mergeable', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ status: 'pending' }));
  store.addTask({ id: 'legacy-old-repair', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'legacy', subject: 'old repair', objective: 'fix it', sourceTaskId: 'legacy-root',
    dependencies: ['legacy-root'], round: 2,
    assignee: 'Engineer 01', acceptance: ['works'], verify: [VERIFY], inScope: ['src/'],
    sourceBase: 'root-commit', sourceCommit: 'old-repair-c',
    acceptanceResults: [{ criterion: 'works', status: 'passed' }] });
  service.cancelTask('alpha', 'legacy-root', { reason: 'restart delivery', actor: { role: 'admin' } });
  service.reopenTask('alpha', 'legacy-root', { reason: 'restart delivery', actor: { role: 'admin' } });
  assert.equal(store.getTask('legacy-old-repair').archived, true,
    'the previous generation repair must not remain the newest deliverable');
  assert.equal(store.getTask('legacy-old-repair').historical, true);
  const epoch = store.getTask('legacy-root').taskEpoch;
  assert.ok(epoch > 0);
  const reopenedRoot = store.getTask('legacy-root');
  assert.equal(reopenedRoot.sourceBase, undefined,
    'a reopened implementation root must recompute its base on dispatch');
  assert.equal(reopenedRoot.previousSourceBase, 'base-commit');
  assert.equal(reopenedRoot.sourceCommit, undefined);
  store.updateTask('legacy-root', {
    status: 'completed',
    sourceCommit: 'root-commit',
    diffHash: 'root-diff',
    changedPaths: ['src/a.js'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: VERIFY, status: 'passed' }],
  });
  await service.reconcileClosedLoop('alpha');
  const review = store.listTasks('alpha').find((task) => task.kind === 'review'
    && task.reviewedTaskId === 'legacy-root' && !task.archived);
  assert.ok(review, 'a new epoch review must be planned');
  assert.equal(review.deliveryGeneration, epoch,
    'the review generation must match the reopened task epoch');
  store.updateTask(review.id, {
    status: 'completed', verdict: 'pass', reviewedSourceCommit: 'root-commit',
    acceptanceResults: [{ criterion: 'reviewed', status: 'passed' }],
  });
  const target = service.resolveDeliveryMergeTarget('alpha', store.getTask('legacy-root'));
  assert.equal(target.ok, true, target.error);
  store.close();
});

test('reopen clears post-merge review and repair state for a rejected delivery', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({
    id: 'reopen-rejected', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'legacy', subject: 'rejected delivery', dependencies: [], assignee: 'Engineer 01',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceBase: 'base-c',
    sourceCommit: 'delivered-c', mergeState: 'rejected', postMergeReview: 'needs_revision',
    mergeReviewError: 'rollback failed', negativeMergeIntent: { operationId: 'op', phase: 'settled' },
    repairTaskId: 'old-repair', repairPlanPending: true, ffAttempt: 2, integrationCommit: 'integration-c',
    closedLoop: { origin: 'closed-loop', deliveredBy: 'old-repair', deliveredAt: 1 },
  });
  service.reopenTask('alpha', 'reopen-rejected', { reason: 'deliver again', actor: { role: 'admin' } });
  const task = store.getTask('reopen-rejected');
  assert.equal(task.status, 'pending');
  assert.equal(task.mergeState, undefined);
  assert.equal(task.postMergeReview, undefined);
  assert.equal(task.mergeReviewError, undefined);
  assert.equal(task.negativeMergeIntent, undefined);
  assert.equal(task.repairTaskId, undefined);
  assert.equal(task.repairPlanPending, false);
  assert.equal(task.ffAttempt, 0);
  assert.equal(task.integrationCommit, undefined);
  assert.equal(task.closedLoop.deliveredBy, undefined);
  assert.ok(task.taskEpoch > 0);
  store.close();
});

test('a manual repair created after V15 is not reclassified by the startup migration', () => {
  const { store, service } = setup();
  service.useWorktrees = true;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'manual-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'legacy', subject: 'manual root', objective: 'works',
    sourceCommit: 'root-c', sourceBase: 'base-c', assignee: 'Engineer 01',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'] });
  service.addTask('alpha', {
    id: 'manual-repair', subject: 'manual repair', kind: 'repair', assigneeRole: 'engineer',
    sourceTaskId: 'manual-root', dependencies: ['manual-root'],
    objective: 'fix it', acceptance: ['works'], verify: [VERIFY], inScope: ['src/'],
  });
  assert.equal(store.getTask('manual-repair').repairOrigin, 'manual');
  assert.equal(store.getTask('manual-repair').mode, 'legacy',
    'a manual repair without a delivery unit must dispatch as legacy, not as half-bound');
  const result = migrateLegacyRepairs(store, { useWorktrees: true });
  assert.equal(result.candidates, 0);
  assert.equal(store.getTask('manual-repair').legacyRepair, undefined);
  normalizeTaskModes(store, { useWorktrees: true });
  assert.equal(store.getTask('manual-repair').mode, 'legacy');
  assert.equal(nextReady(store.listTasks('alpha')).some((task) => task.id === 'manual-repair'), true);
  store.close();
});

test('a failed-root delivery is idempotent once its repair is merged', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({
    id: 'failed-root-idempotent', teamId: 'alpha', kind: 'implementation', status: 'failed',
    mode: 'legacy', subject: 'root', dependencies: [], assignee: 'Engineer 01',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceBase: 'base-c',
    closedLoop: { origin: 'closed-loop', deliveredBy: 'repaired-delivery', deliveredAt: 1 },
  });
  store.addTask({
    id: 'repaired-delivery', teamId: 'alpha', kind: 'repair', status: 'completed', mode: 'legacy',
    round: 2, sourceTaskId: 'failed-root-idempotent', dependencies: ['failed-root-idempotent'],
    assignee: 'Engineer 01', acceptance: ['works'], verify: [VERIFY], inScope: ['src/'],
    sourceBase: 'base-c', sourceCommit: 'repair-c', mergeState: 'merged', mergeCommit: 'repair-c',
    mergedCommit: 'published-c', acceptanceResults: [{ criterion: 'works', status: 'passed' }],
  });
  store.addTask({
    id: 'repaired-review', teamId: 'alpha', kind: 'review', status: 'completed', verdict: 'pass',
    reviewMode: 'legacy', reviewedTaskId: 'repaired-delivery', reviewedSourceCommit: 'repair-c',
    round: 2, assignee: 'Reviewer 01', acceptanceResults: [{ criterion: 'reviewed', status: 'passed' }],
  });
  const result = await service.mergeTask('alpha', 'failed-root-idempotent');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.alreadyMerged, true);
  assert.equal(store.getTask('failed-root-idempotent').mergeState, undefined,
    'a repeated merge must not rewrite the failed root into a conflict state');
  store.close();
});

test('a sibling repair outside the delivered tip does not receive a merged receipt', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-sibling-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'root.js'), 'root', 'utf8');
    execFileSync('git', ['add', 'src/root.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'root'], { cwd: repo });
    const rootCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'src', 'a.js'), 'a', 'utf8');
    execFileSync('git', ['add', 'src/a.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'repair-a'], { cwd: repo });
    const siblingA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['reset', '--hard', rootCommit], { cwd: repo });
    writeFileSync(join(repo, 'src', 'b.js'), 'b', 'utf8');
    execFileSync('git', ['add', 'src/b.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'repair-b'], { cwd: repo });
    const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { store, service } = setup();
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    const fold = (id, sourceCommit, deliverySeq) => ({
      id, teamId: 'alpha', kind: 'repair', status: 'completed', mode: 'legacy',
      sourceTaskId: 'sibling-root', dependencies: ['sibling-root'], assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceBase: base,
      sourceCommit, deliverySeq, deliveryUnitId: 'sibling-root',
    });
    store.addTask({ id: 'sibling-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', deliveryUnitId: 'sibling-root', deliverySeq: 0, sourceBase: base,
      sourceCommit: rootCommit, assignee: 'Engineer 01', acceptance: ['works'], verify: [VERIFY] });
    store.addTask(fold('repair-a', siblingA, 1));
    store.addTask(fold('repair-b', tip, 2));
    const delivery = {
      ok: true, root: store.getTask('sibling-root'), newest: store.getTask('repair-b'),
      sourceCommit: tip,
      group: [store.getTask('sibling-root'), store.getTask('repair-a'), store.getTask('repair-b')],
    };
    const marked = service.markDeliveryMerged('alpha', delivery, tip, undefined);
    assert.deepEqual(marked.excluded, ['repair-a'],
      'the caller must learn which sibling was excluded from the receipt');
    assert.equal(store.getTask('sibling-root').mergeState, 'merged');
    assert.equal(store.getTask('repair-b').mergeState, 'merged');
    assert.equal(store.getTask('repair-a').mergeState, 'blocked');
    assert.equal(store.getTask('repair-a').mergeBlockReason, 'sibling_not_in_delivery');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('restart clears a prepared integration intent that never created external state', async () => {
  const { store, service } = setup();
  service.repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-empty-repo-'));
  try {
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'intent-cleared', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', subject: 'intent', objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: 'source-c',
      mergeState: 'integrating', integrationIntent: { operationId: 'op-clear', state: 'prepared',
        branch: 'integration/alpha/intent-cleared/1', worktree: join(service.repo, 'missing-worktree'),
        sourceCommit: 'source-c', baseBranch: 'main' } });
    store.updateTeam('alpha', { publicationGuard: { operationId: 'op-clear', taskId: 'intent-cleared',
      state: 'integrating' } });
    await service.reconcileAfterRestart();
    const task = store.getTask('intent-cleared');
    assert.equal(task.integrationIntent, undefined);
    assert.equal(task.mergeState, undefined);
    assert.equal(store.getTeam('alpha').publicationGuard, undefined);
    store.close();
  } finally {
    rmSync(service.repo, { recursive: true, force: true });
  }
});

test('restart adopts an integration branch and worktree left by a crash', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-adopt-intent-'));
  const worktree = join(repo, 'integration-wt');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'artifact.js'), 'artifact', 'utf8');
    execFileSync('git', ['add', 'src/artifact.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'artifact'], { cwd: repo });
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['reset', '--hard', base], { cwd: repo });
    const branch = 'integration/alpha/adopt-me/1';
    execFileSync('git', ['branch', branch], { cwd: repo });
    execFileSync('git', ['worktree', 'add', worktree, branch], { cwd: repo });
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'artifact.js'), 'artifact', 'utf8');
    execFileSync('git', ['add', 'src/artifact.js'], { cwd: worktree });
    execFileSync('git', ['commit', '-m', 'integrate artifact'], { cwd: worktree });
    const tip = execFileSync('git', ['rev-parse', branch], { cwd: repo, encoding: 'utf8' }).trim();
    const { store, service } = setup();
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'adopt-me', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', subject: 'adopt', objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceBase: base, sourceCommit,
      mergeState: 'integrating', integrationIntent: { operationId: 'op-adopt', state: 'prepared',
        branch, worktree, sourceCommit, artifactBase: base, baseBranch: 'main' } });
    store.updateTeam('alpha', { publicationGuard: { operationId: 'op-adopt', taskId: 'adopt-me',
      state: 'integrating' } });
    await service.reconcileAfterRestart();
    const task = store.getTask('adopt-me');
    assert.equal(task.integrationIntent.state, 'settled');
    assert.equal(task.integrationCommit, tip);
    assert.equal(task.mergeState, 'review_pending');
    assert.equal(task.integrationBranch, branch);
    assert.equal(task.integrationOwnership.refOid, tip);
    assert.equal(store.getTeam('alpha').publicationGuard, undefined);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('restart releases a post-merge review claim without a verdict', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'claim-release', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'legacy', subject: 'claim', objective: 'works', assignee: 'Engineer 01',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: 'source-c',
    mergeState: 'review_pending', mergeCommit: 'source-c', integrationCommit: 'integration-c',
    integrationIntent: { operationId: 'op-claim', state: 'settled', commit: 'integration-c' },
    postMergeClaim: { operationId: 'review-op', state: 'claimed', createdAt: 1 } });
  await service.reconcileAfterRestart();
  const task = store.getTask('claim-release');
  assert.equal(task.postMergeClaim, undefined);
  assert.equal(task.mergeState, 'review_pending');
  store.close();
});

test('a publishing guard left by a crash waits for captain reconciliation instead of replaying', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'publishing-crash', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'legacy', subject: 'publishing', objective: 'works', assignee: 'Engineer 01',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: 'source-c' });
  store.updateTeam('alpha', { publicationGuard: { operationId: 'op-publishing', taskId: 'publishing-crash',
    state: 'publishing', expectedCommit: 'source-c' } });
  await service.reconcileAfterRestart();
  assert.equal(store.getTask('publishing-crash').mergeState, 'publication_unknown');
  const retry = await service.mergeTask('alpha', 'publishing-crash');
  assert.equal(retry.ok, false);
  assert.equal(retry.blocked, 'publication_unknown');
  store.close();
});

test('integration intent recovery releases its own matching guard in place', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const task = store.addTask({ id: 'intent-guard', teamId: 'alpha', kind: 'implementation',
    status: 'completed', mode: 'legacy', subject: 'intent', objective: 'works', assignee: 'Engineer 01',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: 'source-c',
    mergeState: 'review_pending',
    integrationIntent: { operationId: 'op-intent-guard', state: 'prepared', sourceCommit: 'source-c' } });
  store.updateTeam('alpha', { publicationGuard: { operationId: 'op-intent-guard',
    taskId: 'intent-guard', state: 'integrating' } });
  // Call the recovery entry directly (not reconcileAfterRestart, which clears
  // guards in its first pass) so the releaseGuard branch inside this function
  // is actually executed.
  assert.equal(await service.reconcileIntegrationIntent('alpha', store.getTask(task.id)), true);
  assert.equal(store.getTeam('alpha').publicationGuard, undefined);
  assert.equal(store.getTask('intent-guard').integrationIntent, undefined);
  assert.equal(store.listEvents('alpha')
    .filter((event) => event.type === 'merge.integration_intent_cleared').length, 1);
  store.close();
});

test('restart clears a later team publication guard before reconciling earlier team rows', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  for (const id of ['alpha-row', 'beta-crash']) {
    store.addTask({ id, teamId: id.startsWith('alpha') ? 'alpha' : 'beta', kind: 'implementation',
      status: 'completed', mode: 'legacy', subject: id, objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: `${id}-commit` });
  }
  // A prepared intent forces a real task write for alpha while the loop is
  // walking earlier teams; without the two-phase guard release this write
  // hits beta's still-live guard and throws E_PUBLICATION_HELD.
  store.updateTask('alpha-row', { integrationIntent: {
    operationId: 'op-alpha-row', state: 'prepared', sourceCommit: 'alpha-row-commit',
  } });
  // Only one team can hold the repository-wide guard. Put it on the team that
  // the restart loop visits last: reconciling alpha's rows while beta's guard
  // is still live used to throw E_PUBLICATION_HELD.
  store.updateTeam('beta', { publicationGuard: { operationId: 'op-beta', taskId: 'beta-crash',
    state: 'publishing', expectedCommit: 'beta-crash-commit' } });
  await service.reconcileAfterRestart();
  assert.equal(store.getTeam('beta').publicationGuard, undefined);
  assert.equal(store.getTask('beta-crash').mergeState, 'publication_unknown');
  assert.equal(store.listEvents('beta')
    .filter((event) => event.type === 'merge.publication_guard_released').length, 1);
  assert.equal(store.getTask('alpha-row').integrationIntent, undefined,
    'alpha task rows must be reconcilable while the later team guard is still recorded');
  assert.equal(store.listEvents('alpha')
    .filter((event) => event.type === 'merge.integration_intent_cleared').length, 1);
  store.close();
});

test('captain reconciliation clears or confirms an unknown publication', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-publication-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'published', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'published'], { cwd: repo });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { config, store, service } = setup();
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    const captain = { role: 'admin', name: 'captain' };
    store.addTask({ id: 'reconcile-not-applied', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', subject: 'not applied', objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: 'source-1',
      mergeState: 'publication_unknown' });
    store.updateTeam('alpha', { publicationGuard: { operationId: 'op-1', taskId: 'reconcile-not-applied',
      state: 'publishing', expectedCommit: 'source-1' } });
    const cleared = await service.reconcilePublication('alpha', 'reconcile-not-applied', { applied: false, actor: captain });
    assert.equal(cleared.ok, true);
    assert.equal(store.getTask('reconcile-not-applied').mergeState, undefined);
    assert.equal(store.getTeam('alpha').publicationGuard, undefined);
    store.addTask({ id: 'reconcile-applied', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', subject: 'applied', objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: 'source-2',
      mergeCommit: 'reviewed-2', integrationCommit: head, postMergeReview: 'pass',
      mergeState: 'publication_unknown' });
    store.updateTeam('alpha', { publicationGuard: { operationId: 'op-2', taskId: 'reconcile-applied',
      state: 'publishing', expectedCommit: 'source-2' } });
    const confirmed = await service.reconcilePublication('alpha', 'reconcile-applied', { applied: true, actor: captain });
    // The task itself is confirmed, but this fixture has no current review, so
    // the delivery receipt is incomplete and must not be reported as a clean
    // success.
    assert.equal(confirmed.ok, false);
    assert.equal(confirmed.applied, true);
    assert.equal(confirmed.blocked, 'review_required');
    assert.equal(confirmed.commit, head);
    assert.equal(store.getTask('reconcile-applied').needsCaptain, true);
    assert.equal(store.getTask('reconcile-applied').mergeState, 'merged');
    assert.equal(store.getTask('reconcile-applied').mergedCommit, head);
    assert.equal(store.getTeam('alpha').publicationGuard, undefined);

    store.addTask({ id: 'reconcile-bogus', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', subject: 'bogus', objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: 'source-3',
      integrationCommit: '0'.repeat(40), postMergeReview: 'pass', mergeState: 'publication_unknown' });
    store.updateTeam('alpha', { publicationGuard: { operationId: 'op-3', taskId: 'reconcile-bogus',
      state: 'publishing', expectedCommit: 'source-3' } });
    await assert.rejects(
      () => service.reconcilePublication('alpha', 'reconcile-bogus', { applied: true, actor: captain }),
      (error) => error.status === 409 && error.code === 'E_STATE',
    );
    assert.equal(store.getTask('reconcile-bogus').mergeState, 'publication_unknown');
    assert.equal(store.getTeam('alpha').publicationGuard.taskId, 'reconcile-bogus');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('captain applied confirmation cleans the integration branch and worktree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-confirm-cleanup-'));
  const worktree = join(repo, 'integration-wt');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const branch = 'integration/alpha/cleanup/1';
    execFileSync('git', ['branch', branch], { cwd: repo });
    execFileSync('git', ['worktree', 'add', worktree, branch], { cwd: repo });
    writeFileSync(join(worktree, 'integrated.txt'), 'integrated', 'utf8');
    execFileSync('git', ['add', 'integrated.txt'], { cwd: worktree });
    execFileSync('git', ['commit', '-m', 'integrated'], { cwd: worktree });
    const integrationCommit = execFileSync('git', ['rev-parse', branch], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['merge', '--ff-only', branch], { cwd: repo });
    const { config, store, service } = setup();
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'confirm-cleanup-parent', teamId: 'alpha', kind: 'integration', status: 'completed',
      mode: 'legacy', subject: 'parent integration', objective: 'integrate', assignee: 'Engineer 01',
      acceptance: ['integrated'], verify: [VERIFY], inScope: ['src/'], mergeCommit: integrationCommit });
    store.addTask({ id: 'confirm-cleanup', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', subject: 'cleanup', objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: integrationCommit,
      mergeCommit: integrationCommit, integrationCommit, postMergeReview: 'pass',
      parentIntegrationId: 'confirm-cleanup-parent',
      mergeState: 'publication_unknown', integrationBranch: branch, integrationWorktree: worktree,
      integrationOwnership: { token: 'op-clean', operationId: 'op-clean',
        canonicalRepo: realpathSync.native(repo), branch,
        worktree: realpathSync.native(worktree), refOid: integrationCommit } });
    store.addTask({ id: 'confirm-cleanup-review', teamId: 'alpha', kind: 'review', status: 'completed',
      verdict: 'pass', reviewMode: 'legacy', reviewedTaskId: 'confirm-cleanup',
      reviewedSourceCommit: integrationCommit, dependencies: ['confirm-cleanup'], round: 1,
      assignee: 'Reviewer 01', acceptance: ['reviewed'] });
    store.updateTeam('alpha', { publicationGuard: { operationId: 'op-clean', taskId: 'confirm-cleanup',
      state: 'publishing', expectedCommit: integrationCommit } });
    const result = await service.reconcilePublication('alpha', 'confirm-cleanup', {
      applied: true, actor: { role: 'admin', name: 'captain' },
    });
    assert.equal(result.ok, true, result.error);
    const task = store.getTask('confirm-cleanup');
    assert.equal(task.mergeState, 'merged');
    assert.equal(task.integrationBranch, undefined);
    assert.equal(task.integrationWorktree, undefined);
    const parent = store.getTask('confirm-cleanup-parent');
    assert.equal(parent.mergeState, 'merged');
    assert.equal(parent.mergedCommit, integrationCommit);
    assert.equal(parent.closedLoop.deliveredBy, 'confirm-cleanup');
    assert.equal(existsSync(worktree), false);
    assert.throws(() => execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }));
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('restart refuses to adopt an integration branch that does not contain the artifact', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-adopt-empty-'));
  const worktree = join(repo, 'integration-wt');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'artifact.js'), 'artifact', 'utf8');
    execFileSync('git', ['add', 'src/artifact.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'artifact'], { cwd: repo });
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['reset', '--hard', base], { cwd: repo });
    const branch = 'integration/alpha/empty/1';
    execFileSync('git', ['branch', branch], { cwd: repo });
    execFileSync('git', ['worktree', 'add', worktree, branch], { cwd: repo });
    const { store, service } = setup();
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'empty-branch', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', subject: 'empty', objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceBase: base, sourceCommit,
      mergeState: 'integrating', integrationIntent: { operationId: 'op-empty', state: 'prepared',
        branch, worktree, sourceCommit, artifactBase: base, baseBranch: 'main' } });
    await service.reconcileAfterRestart();
    const task = store.getTask('empty-branch');
    assert.equal(task.integrationIntent.state, 'unknown');
    assert.equal(task.mergeBlockReason, 'integration_outcome_unknown');
    assert.equal(task.integrationCommit, undefined);
    assert.equal(task.needsCaptain, true);
    const reconciled = await service.reconcilePublication('alpha', 'empty-branch', {
      applied: false, actor: { role: 'admin', name: 'captain' },
    });
    assert.equal(reconciled.ok, true, reconciled.error);
    assert.equal(reconciled.recovery, 'discard_artifact');
    assert.equal(store.getTask('empty-branch').integrationIntent, undefined);
    assert.throws(() => execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }));
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('restart -> captain not-applied -> mergeTask publishes the reviewed artifact', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-publication-flow-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'impl.js'), 'implementation', 'utf8');
    execFileSync('git', ['add', 'src/impl.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'implementation'], { cwd: repo });
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['reset', '--hard', base], { cwd: repo });
    const { config, store, service } = setup();
    config.quality.postMergeReview = 'off';
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'publication-flow', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', round: 1, subject: 'flow', objective: 'works', dependencies: [],
      assignee: 'Engineer 01', acceptance: ['works'], verify: [VERIFY], inScope: ['src/'],
      sourceBase: base, sourceCommit, deliveryUnitId: 'publication-flow', deliverySeq: 0,
      acceptanceResults: [{ criterion: 'works', status: 'passed' }], changedPaths: ['src/impl.js'],
      publicationRecovery: { operationId: 'op-flow', expectedCommit: sourceCommit, state: 'publishing', targetBranch: 'main' } });
    store.addTask({ id: 'publication-flow-review', teamId: 'alpha', kind: 'review', status: 'completed',
      verdict: 'pass', reviewMode: 'legacy', reviewedTaskId: 'publication-flow',
      reviewedSourceCommit: sourceCommit, dependencies: ['publication-flow'], round: 1,
      assignee: 'Reviewer 01', acceptanceResults: [{ criterion: 'reviewed', status: 'passed' }] });
    store.updateTeam('alpha', { publicationGuard: { operationId: 'op-flow', taskId: 'publication-flow',
      state: 'publishing', expectedCommit: sourceCommit } });
    await service.reconcileAfterRestart();
    assert.equal(store.getTask('publication-flow').mergeState, 'publication_unknown');
    const reconciled = await service.reconcilePublication('alpha', 'publication-flow', {
      applied: false, actor: { role: 'admin', name: 'captain' },
    });
    assert.equal(reconciled.ok, true);
    assert.equal(store.getTask('publication-flow').publicationRecovery, undefined);
    const merged = await service.mergeTask('alpha', 'publication-flow');
    assert.equal(merged.ok, true, merged.error);
    assert.equal(existsSync(join(repo, 'src', 'impl.js')), true);
    assert.equal(store.getTask('publication-flow').mergeState, 'merged');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('not-applied reconciliation keeps an existing integration commit for review', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'integration-resume', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'legacy', subject: 'resume', objective: 'works', assignee: 'Engineer 01',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceBase: 'base-c', sourceCommit: 'source-c',
    mergeState: 'publication_unknown', mergeCommit: 'source-c', integrationCommit: 'integration-c',
    integrationBranch: 'integration/alpha/resume/1', integrationWorktree: '/tmp/none',
    integrationIntent: { operationId: 'op-resume', state: 'settled', commit: 'integration-c' },
    postMergeClaim: { operationId: 'review-op', state: 'claimed', createdAt: 1 },
    publicationRecovery: { operationId: 'op-resume', expectedCommit: 'source-c', state: 'publishing' } });
  const result = await service.reconcilePublication('alpha', 'integration-resume', {
    applied: false, actor: { role: 'admin', name: 'captain' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recovery, 'resume_review');
  const task = store.getTask('integration-resume');
  assert.equal(task.mergeState, 'review_pending');
  assert.equal(task.integrationCommit, 'integration-c');
  assert.equal(task.postMergeClaim, undefined);
  assert.equal(task.publicationRecovery, undefined);
  store.close();
});

test('B45/B48 a bound known-repair keys the unit root and deduplicates review findings', () => {
  const root = { id: 'bound-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'bound', deliveryUnitId: 'bound-root', deliverySeq: 0, sourceBase: 'base-c',
    sourceCommit: 'root-c', diffHash: 'root-d', acceptance: ['works'], verify: [VERIFY],
    inScope: ['src/'], assignee: 'Engineer 01', changedPaths: ['src/a.js'],
    dependencies: [], objective: 'works' };
  const rootReview = { id: 'bound-root-review', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', reviewMode: 'bound', reviewedTaskId: root.id, round: 1, assignee: 'Reviewer 01',
    dependencies: [root.id], objective: 'review', acceptance: ['reviewed'],
    binding: { deliveryUnitId: root.id, deliverySeq: 0, sourceTaskId: root.id,
      sourceBase: 'base-c', sourceCommit: 'root-c', diffHash: 'root-d' } };
  const repair = { id: 'bound-repair', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'bound', deliveryUnitId: root.id, deliverySeq: 1, sourceTaskId: root.id,
    sourceBase: 'root-c', sourceCommit: 'repair-c', diffHash: 'repair-d',
    parentReviewTaskId: rootReview.id, findings: [finding()], acceptance: ['works'],
    verify: [VERIFY], inScope: ['src/'], assignee: 'Engineer 01', round: 2,
    dependencies: [root.id], objective: 'fix', changedPaths: ['src/a.js'] };
  const plan = planCompletionFanOut({ task: repair, tasks: [root, rootReview, repair], members: [], policy: {} });
  const known = (plan.created ?? []).find((item) => item.closedLoop?.role === 'known-repair');
  assert.ok(known, 'completion must plan a known-repair');
  assert.deepEqual(known.dependencies, [repair.id, root.id],
    'the known-repair must depend on both the reviewed repair and the unit root');
  const graphErrors = validateTaskGraph([root, rootReview, repair, ...(plan.created ?? [])], [],
    { teamIds: ['alpha'], allowUnassigned: true });
  assert.deepEqual(graphErrors, [], 'the planned bound known-repair must pass graph validation');
  assert.equal(known.sourceTaskId, root.id,
    'a bound known-repair must key the delivery root, not the reviewed repair');
  assert.equal(known.findingsFingerprint, findingsFingerprint([finding()]));
  const failed = { id: 'bound-repair-review', teamId: 'alpha', kind: 'review', status: 'failed',
    verdict: 'needs_revision', evidence: 'the finding is still present',
    reviewedTaskId: repair.id, reviewMode: 'bound', round: 2, assignee: 'Reviewer 01',
    findings: [finding()],
    binding: { deliveryUnitId: root.id, deliverySeq: 1, sourceTaskId: repair.id,
      sourceBase: 'root-c', sourceCommit: 'repair-c', diffHash: 'repair-d' } };
  const next = planFailedReviewFollowUp({
    task: failed, tasks: [root, rootReview, repair, known, failed], members: [], policy: {},
  });
  assert.equal(next.deduplicated, true, `the same findings must not create a second repair: ${JSON.stringify(next)}`);
});

test('not-applied after a passing review retries the publication without a dead review_pending', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-ff-recover-'));
  const worktree = join(repo, 'integration-wt');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const branch = 'integration/alpha/ff-recover/1';
    execFileSync('git', ['branch', branch], { cwd: repo });
    execFileSync('git', ['worktree', 'add', worktree, branch], { cwd: repo });
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'published.js'), 'published', 'utf8');
    execFileSync('git', ['add', 'src/published.js'], { cwd: worktree });
    execFileSync('git', ['commit', '-m', 'integrated artifact'], { cwd: worktree });
    const integrationCommit = execFileSync('git', ['rev-parse', branch], { cwd: repo, encoding: 'utf8' }).trim();
    const { config, store, service } = setup();
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    const canonicalRepo = realpathSync.native(repo);
    const canonicalWorktree = realpathSync.native(worktree);
    store.addTask({ id: 'ff-recover', teamId: 'alpha', kind: 'work', status: 'completed',
      mode: 'legacy', subject: 'ff recover', objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'],
      mergeState: 'publication_unknown', mergeCommit: 'reviewed-c',
      integrationCommit, integrationBranch: branch, integrationWorktree: worktree,
      integrationOwnership: { token: 'op-ff', operationId: 'op-ff', canonicalRepo,
        branch, worktree: canonicalWorktree, refOid: integrationCommit },
      integrationIntent: { operationId: 'op-ff', state: 'settled', commit: integrationCommit },
      postMergeReview: 'pass',
      publicationRecovery: { operationId: 'op-ff', expectedCommit: integrationCommit,
        state: 'publishing', targetBranch: 'main' } });
    store.updateTeam('alpha', { publicationGuard: { operationId: 'op-ff', taskId: 'ff-recover',
      state: 'publishing', expectedCommit: integrationCommit } });
    await service.reconcileAfterRestart();
    const reconciled = await service.reconcilePublication('alpha', 'ff-recover', {
      applied: false, actor: { role: 'admin', name: 'captain' },
    });
    assert.equal(reconciled.ok, true, reconciled.error);
    assert.equal(reconciled.recovery, 'retry_publication');
    const afterReconcile = store.getTask('ff-recover');
    assert.equal(afterReconcile.mergeState, 'ff_failed');
    assert.equal(afterReconcile.postMergeReview, 'pass');
    const merged = await service.mergeTask('alpha', 'ff-recover');
    assert.equal(merged.ok, true, merged.error);
    assert.equal(existsSync(join(repo, 'src', 'published.js')), true,
      'the reviewed integration artifact must reach the target branch');
    assert.equal(store.getTask('ff-recover').mergeState, 'merged');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('captain applied confirmation reports excluded siblings instead of a false success', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-applied-excluded-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'published.txt'), 'published', 'utf8');
    execFileSync('git', ['add', 'published.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'published'], { cwd: repo });
    const publishedTip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', '-c', 'delivery'], { cwd: repo });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'root.js'), 'root', 'utf8');
    execFileSync('git', ['add', 'src/root.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'root'], { cwd: repo });
    const rootCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'src', 'sibling.js'), 'sibling', 'utf8');
    execFileSync('git', ['add', 'src/sibling.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'sibling'], { cwd: repo });
    const siblingCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['reset', '--hard', rootCommit], { cwd: repo });
    writeFileSync(join(repo, 'src', 'tip.js'), 'tip', 'utf8');
    execFileSync('git', ['add', 'src/tip.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'tip'], { cwd: repo });
    const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', 'main'], { cwd: repo });
    const { store, service } = setup();
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    const baseTask = (id, round, commit, seq) => ({ id, teamId: 'alpha', kind: 'repair',
      status: 'completed', mode: 'legacy', round, sourceTaskId: 'confirm-root',
      dependencies: ['confirm-root'], assignee: 'Engineer 01', acceptance: ['works'],
      verify: [VERIFY], inScope: ['src/'], sourceBase: base, sourceCommit: commit,
      deliveryUnitId: 'confirm-root', deliverySeq: seq, objective: 'fix' });
    store.addTask({ id: 'confirm-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', round: 1, deliveryUnitId: 'confirm-root', deliverySeq: 0, sourceBase: base,
      sourceCommit: rootCommit, assignee: 'Engineer 01', acceptance: ['works'], verify: [VERIFY],
      dependencies: [], objective: 'works' });
    store.addTask(baseTask('confirm-sibling', 2, siblingCommit, 1));
    store.addTask({ ...baseTask('confirm-tip', 3, tip, 2), mergeState: 'publication_unknown',
      mergeCommit: tip, integrationCommit: publishedTip, postMergeReview: 'pass',
      publicationRecovery: { operationId: 'op-confirm', expectedCommit: publishedTip, state: 'publishing' } });
    store.addTask({ id: 'confirm-review', teamId: 'alpha', kind: 'review', status: 'completed',
      verdict: 'pass', reviewMode: 'legacy', reviewedTaskId: 'confirm-tip',
      reviewedSourceCommit: tip, dependencies: ['confirm-tip'], round: 3,
      assignee: 'Reviewer 01', acceptance: ['reviewed'] });
    store.updateTeam('alpha', { publicationGuard: { operationId: 'op-confirm', taskId: 'confirm-tip',
      state: 'publishing', expectedCommit: publishedTip } });
    const result = await service.reconcilePublication('alpha', 'confirm-tip', {
      applied: true, actor: { role: 'admin', name: 'captain' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.blocked, 'sibling_not_in_delivery');
    assert.deepEqual(result.excluded, ['confirm-sibling']);
    assert.equal(store.getTask('confirm-tip').mergeState, 'merged');
    assert.equal(store.getTeam('alpha').needsCaptain, true);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('B43 a stale legacy review is superseded and re-planned for the new source commit', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ sourceCommit: 'new-source-c' }));
  store.addTask(failedLegacyReview({
    id: 'stale-legacy-review', status: 'completed', verdict: 'pass',
    reviewedSourceCommit: 'old-source-c',
  }));
  await service.reconcileClosedLoop('alpha');
  const stale = store.getTask('stale-legacy-review');
  assert.equal(stale.archived, true);
  assert.equal(stale.superseded, true);
  assert.equal(stale.archivedReason, 'legacy-review-source-changed');
  const replanned = store.listTasks('alpha').find((task) => task.kind === 'review'
    && task.reviewedTaskId === 'legacy-root' && !task.archived && task.id !== stale.id);
  assert.ok(replanned, 'a new review must be planned after superseding the stale one');
  assert.equal(replanned.reviewedSourceCommit, 'new-source-c');
  assert.equal(replanned.deliveryGeneration, store.getTask('legacy-root').taskEpoch ?? 0);
  assert.equal(store.getTeam('alpha').needsCaptain ?? false, false);
  store.close();
});

test('B43 supersede archives a stale pass but keeps the failed review and escalates', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ sourceCommit: 'new-source-mixed' }));
  // The pass row is created first: the plan must not depend on row order.
  store.addTask(failedLegacyReview({ id: 'old-pass-mixed', status: 'completed', verdict: 'pass',
    reviewedSourceCommit: 'old-source-mixed' }));
  store.addTask(failedLegacyReview({ id: 'old-fail-mixed', status: 'completed',
    verdict: 'needs_revision', reviewedSourceCommit: 'old-source-mixed' }));
  await service.reconcileClosedLoop('alpha');
  assert.equal(store.getTask('old-pass-mixed').archived, true);
  assert.equal(store.getTask('old-pass-mixed').superseded, true);
  const failed = store.getTask('old-fail-mixed');
  assert.notEqual(failed.archived, true, 'a failed review is repair evidence and must not be archived');
  assert.equal(failed.status, 'completed');
  assert.equal(failed.verdict, 'needs_revision');
  assert.equal(store.getTeam('alpha').needsCaptain, true,
    'a stale failed review must escalate instead of silently doing nothing');
  store.close();
});

test('B43 an active legacy review on an old commit is cancelled and its attempt is closed', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ sourceCommit: 'new-source-active' }));
  store.addTask(failedLegacyReview({ id: 'old-active-review', status: 'pending', verdict: undefined,
    findings: [], reviewedSourceCommit: 'old-source-active', attemptId: 'old-active-attempt' }));
  store.addAttempt({ id: 'old-active-attempt', teamId: 'alpha', taskId: 'old-active-review',
    status: 'in_progress', taskEpoch: 0, controlEpoch: 0 });
  await service.reconcileClosedLoop('alpha');
  const review = store.getTask('old-active-review');
  assert.equal(review.status, 'cancelled');
  assert.equal(review.cancelReason, 'stale_binding');
  assert.equal(review.archived, true);
  assert.equal(review.historical, true);
  assert.equal(store.getAttempt('old-active-attempt').status, 'cancelled');
  const replanned = store.listTasks('alpha').find((task) => task.kind === 'review'
    && task.reviewedTaskId === 'legacy-root' && task.status === 'pending' && !task.archived);
  assert.ok(replanned, 'the new commit must get a fresh review in the same sweep');
  assert.equal(replanned.reviewedSourceCommit, 'new-source-active');
  store.close();
});

test('B43 applyClosedLoop supersedes a stale review even when the plan creates follow-ups', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ sourceCommit: 'new-source-combined', requiresVerification: true }));
  store.addTask(failedLegacyReview({ id: 'stale-combined-pass', status: 'completed', verdict: 'pass',
    reviewedSourceCommit: 'old-source-combined' }));
  await service.reconcileClosedLoop('alpha');
  const stale = store.getTask('stale-combined-pass');
  assert.equal(stale.archived, true, 'the stale pass must be archived before any created follow-up is dispatched');
  assert.equal(stale.superseded, true);
  const fresh = store.listTasks('alpha').find((task) => task.kind === 'review'
    && task.reviewedTaskId === 'legacy-root' && task.status === 'pending' && !task.archived);
  assert.ok(fresh, 'the new commit must get a fresh review in the same sweep');
  assert.equal(fresh.reviewedSourceCommit, 'new-source-combined');
  assert.ok(store.listTasks('alpha').some((task) => task.kind === 'verification'
    && task.reviewedTaskId === 'legacy-root'), 'the requested verification is still planned');
  store.close();
});

test('B46 reopen archives the previous repair review so delivery audit has no missing-source blocker', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ status: 'completed', mergeState: 'rejected', mergeCommit: 'old-merge' }));
  store.addTask({ id: 'old-repair', teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'legacy', subject: 'old repair', objective: 'fix', assignee: 'Engineer 02',
    acceptance: ['fixed'], verify: [VERIFY], sourceTaskId: 'legacy-root',
    sourceBase: 'root-commit', sourceCommit: 'old-repair-commit', changedPaths: ['src/a.js'] });
  store.addTask({ id: 'old-repair-review', teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', reviewedTaskId: 'old-repair', reviewedSourceCommit: 'old-repair-commit',
    reviewMode: 'legacy', dependencies: ['old-repair'], round: 2, assignee: 'Reviewer 02' });
  service.reopenTask('alpha', 'legacy-root', { reason: 'post-merge rejected',
    actor: { role: 'admin', name: 'captain' } });
  assert.equal(store.getTask('old-repair').archived, true);
  assert.equal(store.getTask('old-repair-review').archived, true);
  assert.equal(store.getTask('old-repair-review').historical, true);
  const audit = deliveryAudit({ ...store.getTeam('alpha'), tasks: store.listTasks('alpha') });
  assert.equal(audit.blockers.some((blocker) => blocker.includes('references missing task')), false);
  store.close();
});

test('B46 reopen archives the whole repair chain even without a deliveryUnitId', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  // Pre-V15 roots have no deliveryUnitId at all.
  store.addTask(legacyRoot({ status: 'completed', mergeState: 'rejected', deliveryUnitId: undefined }));
  const repair = (id, sourceTaskId) => ({ id, teamId: 'alpha', kind: 'repair', status: 'completed',
    mode: 'legacy', subject: id, objective: 'fix', assignee: 'Engineer 02', acceptance: ['fixed'],
    verify: [VERIFY], sourceTaskId, sourceCommit: `${id}-commit`, changedPaths: ['src/a.js'] });
  const review = (id, reviewedTaskId) => ({ id, teamId: 'alpha', kind: 'review', status: 'completed',
    verdict: 'pass', reviewedTaskId, reviewedSourceCommit: `${reviewedTaskId}-commit`,
    reviewMode: 'legacy', dependencies: [reviewedTaskId], round: 2, assignee: 'Reviewer 02' });
  store.addTask(repair('legacy-repair-1', 'legacy-root'));
  store.addTask(review('legacy-review-1', 'legacy-repair-1'));
  // A failed re-review creates a second-generation repair keyed to repair 1.
  store.addTask(repair('legacy-repair-2', 'legacy-repair-1'));
  store.addTask(review('legacy-review-2', 'legacy-repair-2'));
  service.reopenTask('alpha', 'legacy-root', { reason: 'post-merge rejected',
    actor: { role: 'admin', name: 'captain' } });
  for (const id of ['legacy-repair-1', 'legacy-review-1', 'legacy-repair-2', 'legacy-review-2']) {
    assert.equal(store.getTask(id).archived, true, `${id} must be archived with the old generation`);
    assert.equal(store.getTask(id).historical, true);
  }
  store.close();
});

test('B46 reopen takes over a matching guard even when review and repair rows exist', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ status: 'completed', mergeState: 'ff_exhausted' }));
  store.addTask({ id: 'guard-old-review', teamId: 'alpha', kind: 'review', status: 'in_progress',
    reviewedTaskId: 'legacy-root', reviewedSourceCommit: 'root-commit',
    reviewMode: 'legacy', dependencies: ['legacy-root'], round: 1, assignee: 'Reviewer 01',
    attemptId: 'guard-review-attempt' });
  store.addAttempt({ id: 'guard-review-attempt', teamId: 'alpha', taskId: 'guard-old-review',
    status: 'in_progress', taskEpoch: 0, controlEpoch: 0 });
  store.addTask({ id: 'guard-active-repair', teamId: 'alpha', kind: 'repair', status: 'in_progress',
    mode: 'legacy', subject: 'active repair', objective: 'fix', assignee: 'Engineer 02',
    acceptance: ['fixed'], verify: [VERIFY], sourceTaskId: 'legacy-root',
    attemptId: 'guard-repair-attempt' });
  store.addAttempt({ id: 'guard-repair-attempt', teamId: 'alpha', taskId: 'guard-active-repair',
    status: 'in_progress', taskEpoch: 0, controlEpoch: 0 });
  store.updateTeam('alpha', { publicationGuard: { operationId: 'guard-op', taskId: 'legacy-root',
    state: 'publishing', expectedCommit: 'root-commit' } });
  assert.throws(() => service.reopenTask('alpha', 'legacy-root', {
    reason: 'recover exhausted publication', actor: { role: 'admin', name: 'captain' },
  }), (error) => error.code === 'E_PUBLICATION_HELD' && error.status === 409);
  assert.equal(store.getTeam('alpha').publicationGuard.state, 'publishing');
  assert.equal(store.getTask('legacy-root').status, 'completed');
  assert.notEqual(store.getTask('guard-old-review').archived, true, 'the failed reopen must roll back');
  store.updateTeam('alpha', { publicationGuard: { operationId: 'guard-op', taskId: 'legacy-root',
    state: 'unknown', expectedCommit: 'root-commit' } }, { publicationOwner: 'guard-op' });
  const reopened = service.reopenTask('alpha', 'legacy-root', { reason: 'recover exhausted publication',
    actor: { role: 'admin', name: 'captain' } });
  assert.equal(reopened.ok, true);
  assert.equal(store.getTeam('alpha').publicationGuard, undefined);
  assert.equal(store.getTask('guard-old-review').status, 'cancelled');
  assert.equal(store.getTask('guard-old-review').archived, true);
  assert.equal(store.getAttempt('guard-review-attempt').status, 'cancelled');
  assert.equal(store.getTask('guard-active-repair').status, 'cancelled');
  assert.equal(store.getTask('guard-active-repair').archived, true);
  assert.equal(store.getAttempt('guard-repair-attempt').status, 'cancelled');
  store.close();
});

test('B46 reopen does not archive an unrelated integration that lists the root as a dependency', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(legacyRoot({ status: 'completed', mergeState: 'rejected' }));
  store.addTask({ id: 'unit-b-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'legacy', subject: 'unit B', objective: 'works', assignee: 'Engineer 03',
    acceptance: ['works'], verify: [VERIFY], sourceCommit: 'unit-b-commit' });
  store.addTask({ id: 'unit-b-integration', teamId: 'alpha', kind: 'integration', status: 'in_progress',
    mode: 'legacy', subject: 'unit B integration', objective: 'integrate', assignee: 'Engineer 03',
    acceptance: ['integrated'], verify: [VERIFY], parentIntegrationId: 'unit-b-root',
    dependencies: ['legacy-root', 'unit-b-root'] });
  service.reopenTask('alpha', 'legacy-root', { reason: 'post-merge rejected',
    actor: { role: 'admin', name: 'captain' } });
  const integration = store.getTask('unit-b-integration');
  assert.notEqual(integration.archived, true);
  assert.equal(integration.status, 'in_progress');
  store.close();
});

test('B46 a reopened work task cannot reuse its previous source commit', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'work-reopen', teamId: 'alpha', kind: 'work', status: 'completed',
    mode: 'legacy', subject: 'work', objective: 'works', assignee: 'Engineer 01',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: 'old-work-commit',
    sourceBase: 'base-work', diffHash: 'old-diff', changedPaths: ['src/a.js'], noChanges: false,
    mergeState: 'ff_exhausted', mergeCommit: 'old-work-commit' });
  service.reopenTask('alpha', 'work-reopen', { reason: 'publication exhausted',
    actor: { role: 'admin', name: 'captain' } });
  const task = store.getTask('work-reopen');
  assert.equal(task.status, 'pending');
  assert.equal(task.sourceCommit, undefined);
  assert.equal(task.previousSourceCommit, 'old-work-commit');
  assert.equal(task.diffHash, undefined);
  assert.equal(task.changedPaths, undefined);
  assert.equal(task.noChanges, false);
  store.close();
});

test('B46 a reopened work task is re-committed instead of republishing its old source commit', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-work-reopen-'));
  const worktree = join(repo, 'work-wt');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'base', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'add', '-b', 'agent/alpha/work/1', worktree, base], { cwd: repo });
    writeFileSync(join(worktree, 'a.txt'), 'old work', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: worktree });
    execFileSync('git', ['commit', '-m', 'old work'], { cwd: worktree });
    const oldCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    const { store, service } = setup({ artifactFenceProvider: createWorktreeFenceProvider() });
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'work-redeliver', teamId: 'alpha', kind: 'work', status: 'completed',
      mode: 'legacy', subject: 'work', objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['a.txt'], sourceBase: base,
      sourceCommit: oldCommit, worktree, worktreeBase: base, mergeState: 'ff_exhausted',
      mergeCommit: oldCommit, attemptId: 'att-work-reopen', lastAttemptId: 'att-work-reopen' });
    store.addAttempt({ id: 'att-work-reopen', teamId: 'alpha', taskId: 'work-redeliver',
      status: 'failed', taskEpoch: 0, controlEpoch: 0 });
    service.reopenTask('alpha', 'work-redeliver', { reason: 'publication exhausted',
      actor: { role: 'admin', name: 'captain' } });
    // The target base advances, then the new generation dispatches a fresh
    // worktree from that base. The artifact diff must start at the new base,
    // not the previous generation's sourceBase.
    writeFileSync(join(repo, 'upstream.txt'), 'upstream', 'utf8');
    execFileSync('git', ['add', 'upstream.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'upstream advance'], { cwd: repo });
    const newBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const worktree2 = join(repo, 'work-wt-2');
    execFileSync('git', ['worktree', 'add', '-b', 'agent/alpha/work/2', worktree2, newBase], { cwd: repo });
    writeFileSync(join(worktree2, 'a.txt'), 'reworked', 'utf8');
    store.updateTask('work-redeliver', { status: 'completed', worktree: worktree2, worktreeBase: newBase });
    const closed = await service.closeoutCompletedWork({ teamId: 'alpha', taskId: 'work-redeliver' });
    assert.deepEqual(closed.closed, ['work-redeliver']);
    const task = store.getTask('work-redeliver');
    assert.notEqual(task.sourceCommit, oldCommit, 'the reopened work must produce a new commit');
    assert.equal(task.previousSourceCommit, oldCommit);
    assert.equal(task.previousSourceBase, base);
    assert.equal(task.sourceBase, newBase, 'the new generation must diff from the current target base');
    assert.deepEqual(task.changedPaths, ['a.txt'], 'upstream commits must not leak into the task artifact');
    const changed = execFileSync('git', ['show', '--name-only', '--format=', task.sourceCommit],
      { cwd: repo, encoding: 'utf8' }).trim();
    assert.match(changed, /a\.txt/);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('B46 a reopened review clears its archived/cancelled marker so it can dispatch', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'review-reopen', teamId: 'alpha', kind: 'review', status: 'cancelled',
    verdict: 'needs_revision', reviewedTaskId: 'missing-source', reviewMode: 'legacy',
    archived: true, superseded: true, historical: true, dependencies: [], round: 1,
    assignee: 'Reviewer 01' });
  service.reopenTask('alpha', 'review-reopen', { reason: 'retry review',
    actor: { role: 'admin', name: 'captain' } });
  const task = store.getTask('review-reopen');
  assert.equal(task.status, 'pending');
  assert.equal(task.archived, false);
  assert.equal(task.superseded, false);
  assert.equal(task.historical, false);
  store.close();
});

test('B46 markDeliveryMerged fails closed for a member without a source commit in a real repository', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-receipt-identity-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'base', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { store, service } = setup();
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask(legacyRoot({ sourceCommit: undefined, sourceBase: undefined, deliverySeq: 0 }));
    const repair = { ...legacyRoot({ id: 'receipt-repair', kind: 'repair', subject: 'repair',
      sourceTaskId: 'legacy-root', sourceCommit: tip, deliverySeq: 1, round: 2 }) };
    store.addTask(repair);
    const root = store.getTask('legacy-root');
    const marked = service.markDeliveryMerged('alpha', {
      root, group: [root, store.getTask('receipt-repair')], newest: store.getTask('receipt-repair'),
      sourceCommit: tip,
    }, tip);
    assert.deepEqual(marked.excluded, ['legacy-root']);
    assert.equal(store.getTask('legacy-root').mergeState, 'blocked');
    assert.equal(store.getTask('legacy-root').mergeBlockReason, 'sibling_not_in_delivery');
    assert.equal(store.getTask('receipt-repair').mergeState, 'merged');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('B47 a third fast-forward failure becomes ff_exhausted and stops retrying', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-ff-exhausted-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const branch = 'integration/alpha/exhausted/1';
    execFileSync('git', ['branch', branch], { cwd: repo });
    const worktree = join(repo, 'integration-wt');
    execFileSync('git', ['worktree', 'add', worktree, branch], { cwd: repo });
    writeFileSync(join(worktree, 'integrated.txt'), 'integrated', 'utf8');
    execFileSync('git', ['add', 'integrated.txt'], { cwd: worktree });
    execFileSync('git', ['commit', '-m', 'integrated'], { cwd: worktree });
    const integrationCommit = execFileSync('git', ['rev-parse', branch], { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'diverged.txt'), 'diverged', 'utf8');
    execFileSync('git', ['add', 'diverged.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'diverged'], { cwd: repo });
    const { config, store, service } = setup();
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'ff-exhausted', teamId: 'alpha', kind: 'work', status: 'completed',
      mode: 'legacy', subject: 'ff exhausted', objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], mergeState: 'ff_failed',
      mergeCommit: 'reviewed-c', postMergeReview: 'pass', ffAttempt: 2,
      integrationCommit, integrationBranch: branch, integrationWorktree: worktree,
      integrationOwnership: { token: 'op-ex', operationId: 'op-ex', canonicalRepo: realpathSync.native(repo),
        branch, worktree: realpathSync.native(worktree), refOid: integrationCommit },
      integrationIntent: { operationId: 'op-ex', state: 'settled', commit: integrationCommit } });
    const failed = await service.mergeTask('alpha', 'ff-exhausted');
    assert.equal(failed.ok, false);
    const task = store.getTask('ff-exhausted');
    assert.equal(task.mergeState, 'ff_exhausted');
    assert.equal(task.ffAttempt, 3);
    assert.equal(task.needsCaptain, true);
    const again = await service.mergeTask('alpha', 'ff-exhausted');
    assert.equal(again.ok, false);
    assert.equal(store.getTask('ff-exhausted').ffAttempt, 3, 'ff_exhausted must not retry a fourth time');
    store.updateTeam('alpha', { publicationGuard: { operationId: 'op-ex', taskId: 'ff-exhausted',
      state: 'unknown', expectedCommit: integrationCommit } });
    const reopened = service.reopenTask('alpha', 'ff-exhausted', {
      reason: 'branch rebased; retry the delivery', actor: { role: 'admin', name: 'captain' },
    });
    assert.equal(reopened.ok, true);
    const restarted = store.getTask('ff-exhausted');
    assert.equal(restarted.status, 'pending');
    assert.equal(restarted.mergeState, undefined);
    assert.equal(restarted.ffAttempt, 0);
    assert.equal(restarted.needsCaptain, false);
    assert.equal(store.getTeam('alpha').publicationGuard, undefined,
      'a captain reopen must take over the task publication guard');
    assert.equal(store.listEvents('alpha')
      .filter((event) => event.type === 'merge.publication_guard_cleared_by_reopen').length, 1);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('B47 an unparseable post-merge verdict has a captain reopen exit', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'unknown-verdict', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'legacy', subject: 'unknown verdict', objective: 'works', assignee: 'Engineer 01',
    acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: 'unknown-source',
    mergeState: 'review_pending_internal', postMergeReview: 'unknown', needsCaptain: true });
  const reopened = service.reopenTask('alpha', 'unknown-verdict', {
    reason: 'contractor returned no parseable verdict', actor: { role: 'admin', name: 'captain' },
  });
  assert.equal(reopened.ok, true);
  const task = store.getTask('unknown-verdict');
  assert.equal(task.status, 'pending');
  assert.equal(task.mergeState, undefined);
  assert.equal(task.postMergeReview, undefined);
  assert.equal(task.needsCaptain, false);
  store.close();
});

test('B46 restart records a negative revert receipt instead of guessing', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-negative-receipt-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'base', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'bad change', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'bad'], { cwd: repo });
    const bad = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const reverted = await revertCommitOnce({ repo, commit: bad, key: 'negative-restart-1' });
    assert.equal(reverted.ok, true, reverted.error);
    const { store, service } = setup();
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'negative-restart', teamId: 'alpha', kind: 'implementation', status: 'completed',
      mode: 'legacy', subject: 'negative', objective: 'works', assignee: 'Engineer 01',
      acceptance: ['works'], verify: [VERIFY], inScope: ['src/'], sourceCommit: bad,
      mergeCommit: bad, mergeState: 'review_pending',
      negativeMergeIntent: { operationId: 'negative-restart-1', phase: 'prepared',
        verdict: 'reject', mergeCommit: bad, evidence: 'bad change' } });
    await service.reconcileAfterRestart();
    const task = store.getTask('negative-restart');
    assert.equal(task.negativeMergeIntent.revertReceiptFound, true);
    assert.equal(task.negativeMergeIntent.revertCommit, reverted.commit);
    assert.equal(task.mergeBlockReason, 'negative_merge_outcome_unknown');
    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'merge.negative_receipt_found').length, 1);
    await service.reconcileAfterRestart();
    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'merge.negative_receipt_found').length, 1,
      'a receipt must be recorded once across restarts');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a target ref advanced without a worktree reset is escalated instead of reported as a clean merge', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-worktree-sync-'));
  const worktree = join(repo, 'integration-sync');
  const indexLock = join(repo, '.git', 'index.lock');
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    const branch = 'integration/alpha/worktree-sync/1';
    execFileSync('git', ['branch', branch], { cwd: repo });
    execFileSync('git', ['worktree', 'add', worktree, branch], { cwd: repo });
    writeFileSync(join(worktree, 'synced.txt'), 'synced', 'utf8');
    execFileSync('git', ['add', 'synced.txt'], { cwd: worktree });
    execFileSync('git', ['commit', '-m', 'integrated'], { cwd: worktree });
    const integrationCommit = execFileSync('git', ['rev-parse', branch], { cwd: repo, encoding: 'utf8' }).trim();
    const { config, store, service } = setup();
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'worktree-sync', teamId: 'alpha', kind: 'work', status: 'completed',
      mode: 'legacy', subject: 'worktree sync', objective: 'works', dependencies: [],
      assignee: 'Engineer 01', acceptance: ['works'], verify: [VERIFY], inScope: ['src/'],
      mergeState: 'ff_failed', postMergeReview: 'pass', ffAttempt: 1,
      mergeCommit: 'reviewed-c', integrationCommit, integrationBranch: branch,
      integrationWorktree: worktree,
      integrationOwnership: { token: 'op-sync', operationId: 'op-sync',
        canonicalRepo: realpathSync.native(repo), branch,
        worktree: realpathSync.native(worktree), refOid: integrationCommit },
      integrationIntent: { operationId: 'op-sync', state: 'settled', commit: integrationCommit } });
    // A pre-existing index lock reproduces a concurrent Git process: the
    // cleanliness probe and update-ref still succeed, while the final
    // `git reset --hard` cannot take the index and leaves the checkout stale.
    writeFileSync(indexLock, '', 'utf8');
    const result = await service.mergeTask('alpha', 'worktree-sync');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.needsCaptain, true, 'the ref advanced, but the worktree did not');
    assert.match(result.warning ?? '', /git reset --hard/);
    const task = store.getTask('worktree-sync');
    assert.equal(task.mergeState, 'merged');
    assert.equal(task.needsCaptain, true,
      'a publication whose worktree was not reset must never be reported as a clean merge');
    assert.match(task.mergeReviewError ?? '', /git reset --hard/);
    assert.deepEqual(task.publicationWorktreeSync, {
      target: 'main', commit: integrationCommit, state: 'not_synced',
    });
    assert.equal(store.getTeam('alpha').publicationGuard, undefined,
      'the ref update succeeded, so the publication guard is released');
    assert.equal(execFileSync('git', ['rev-parse', 'main'], { cwd: repo, encoding: 'utf8' }).trim(),
      integrationCommit, 'the target branch must carry the published commit');
    assert.equal(existsSync(join(repo, 'synced.txt')), false,
      'the index lock must leave the checked-out worktree behind the advanced ref');
    const events = store.listEvents('alpha')
      .filter((event) => event.type === 'merge.publication_worktree_not_synced');
    assert.equal(events.length, 1);
    assert.equal(events[0].taskId, 'worktree-sync');
    assert.equal(events[0].worktreeSynced, false);
    assert.equal(events[0].commit, integrationCommit);
    store.close();
  } finally {
    rmSync(indexLock, { force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('restart holds a negative merge when its revert receipt cannot be read', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-negative-unreadable-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'base', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'bad change', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'bad'], { cwd: repo });
    const bad = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { config, store, service } = setup();
    // Point the receipt lookup at a branch that does not exist so `git log`
    // fails. That is an unreadable receipt, not proof that nothing happened.
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'missing-base';
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'negative-unreadable', teamId: 'alpha', kind: 'implementation',
      status: 'completed', mode: 'legacy', subject: 'negative', objective: 'works', dependencies: [],
      assignee: 'Engineer 01', acceptance: ['works'], verify: [VERIFY], inScope: ['src/'],
      sourceCommit: bad, mergeCommit: bad, mergeState: 'review_pending',
      negativeMergeIntent: { operationId: 'negative-unreadable-1', phase: 'prepared',
        verdict: 'reject', mergeCommit: bad, evidence: 'bad change' } });
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    await service.reconcileAfterRestart();
    const task = store.getTask('negative-unreadable');
    assert.equal(task.mergeBlockReason, 'revert_receipt_unreadable');
    assert.equal(task.needsCaptain, true);
    assert.equal(task.negativeMergeIntent.phase, 'prepared');
    assert.equal(task.negativeMergeIntent.receiptStatus, 'error');
    assert.equal(typeof task.negativeMergeIntent.receiptError, 'string');
    assert.equal(task.negativeMergeIntent.revertReceiptFound, undefined);
    assert.equal(task.negativeMergeIntent.revertCommit, undefined);
    const types = store.listEvents('alpha').map((event) => event.type);
    assert.equal(types.filter((type) => type === 'merge.negative_receipt_unreadable').length, 1);
    assert.equal(types.includes('merge.negative_receipt_found'), false);
    assert.equal(types.includes('merge.negative_recovery_held'), false,
      'an unreadable receipt must not fall through to the no-receipt branch');
    assert.equal(store.getTeam('alpha').needsCaptain, true);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
      headBefore, 'an unreadable receipt must not move the target branch');
    const replayed = execFileSync('git', ['log', '--all', '--fixed-strings', '--format=%H',
      '--grep', 'Negative-Merge-Key: negative-unreadable-1', '--'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(replayed, '', 'no revert may be replayed while the receipt is unreadable');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('not-applied reconciliation keeps the guard when the integration branch cannot be discarded', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-v15-discard-failed-'));
  const worktree = join(repo, 'integration-discard');
  const branch = 'integration/alpha/discard/1';
  const refLock = join(repo, '.git', 'refs', 'heads', `${branch}.lock`);
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
    execFileSync('git', ['branch', branch], { cwd: repo });
    execFileSync('git', ['worktree', 'add', worktree, branch], { cwd: repo });
    writeFileSync(join(worktree, 'integrated.txt'), 'integrated', 'utf8');
    execFileSync('git', ['add', 'integrated.txt'], { cwd: worktree });
    execFileSync('git', ['commit', '-m', 'integrated'], { cwd: worktree });
    const integrationCommit = execFileSync('git', ['rev-parse', branch], { cwd: repo, encoding: 'utf8' }).trim();
    const { config, store, service } = setup();
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'discard-blocked', teamId: 'alpha', kind: 'work', status: 'completed',
      mode: 'legacy', subject: 'discard', objective: 'works', dependencies: [],
      assignee: 'Engineer 01', acceptance: ['works'], verify: [VERIFY], inScope: ['src/'],
      mergeState: 'publication_unknown', mergeCommit: 'reviewed-c',
      integrationBranch: branch, integrationWorktree: worktree });
    store.updateTeam('alpha', { publicationGuard: { operationId: 'op-discard',
      taskId: 'discard-blocked', state: 'publishing', expectedCommit: integrationCommit } });
    // The worktree is registered, but a ref lock makes the branch deletion
    // fail after discardIntegrationArtifact removed the checkout, so the
    // captain decision cannot be recorded as applied.
    mkdirSync(dirname(refLock), { recursive: true });
    writeFileSync(refLock, '', 'utf8');
    const result = await service.reconcilePublication('alpha', 'discard-blocked', {
      applied: false, actor: { role: 'admin', name: 'captain' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(result.needsCaptain, true);
    assert.match(result.error ?? '', /cannot lock ref/);
    const task = store.getTask('discard-blocked');
    assert.equal(task.needsCaptain, true);
    assert.equal(task.publicationRecoveryState, 'discard_failed');
    assert.match(task.mergeReviewError ?? '', /discard integration artifact failed/);
    assert.equal(task.mergeState, 'publication_unknown',
      'a failed discard must not clear the unknown publication');
    const guard = store.getTeam('alpha').publicationGuard;
    assert.equal(guard?.operationId, 'op-discard');
    assert.equal(guard?.taskId, 'discard-blocked');
    const events = store.listEvents('alpha')
      .filter((event) => event.type === 'merge.publication_discard_failed');
    assert.equal(events.length, 1);
    assert.equal(events[0].taskId, 'discard-blocked');
    assert.equal(events[0].branch, branch);
    assert.match(events[0].error ?? '', /cannot lock ref/);
    assert.doesNotThrow(() => execFileSync('git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }),
    'the artifact branch must survive so a later attempt can finish the discard');
    store.close();
  } finally {
    rmSync(refLock, { force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
