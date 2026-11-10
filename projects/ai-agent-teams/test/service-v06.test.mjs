import { testHomeRoot } from './support/cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { removeTreeWithRetry } from './support/cleanup.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService, isCapacityError } from '../src/scheduler-service.mjs';
import { deriveChangedPaths } from '../src/domain/changes.mjs';
import { snapshotScope } from '../src/domain/artifacts.mjs';
import { nextReady } from '../src/domain/scheduler.mjs';

function setup({ handler, memoryUsage, capacityStatePath, startClock = 1000, patch, artifactFenceProvider } = {}) {
  const { config } = loadConfig('config/example.v06.json');
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
    memoryUsage: memoryUsage ?? (() => ({ rssBytes: 1, budgetBytes: 100 })),
    capacityStatePath,
    artifactFenceProvider,
  });
  return { config, store, adapter, service, advance: (ms) => { clock += ms; }, now: () => clock };
}

function implementationTask(id, assigneeRole = 'engineer') {
  return {
    id,
    subject: id,
    kind: 'implementation',
    assigneeRole,
    objective: 'works',
    acceptance: ['works'],
    inScope: ['src/'],
    verify: ['node -e "process.exit(0)"'],
  };
}

test('v0.6 creates zero members, materializes roles on demand and shares slots', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  assert.equal(store.listMembers('alpha').length, 0);
  service.addTask('alpha', implementationTask('t1'));
  service.addTask('alpha', {
    id: 'review', subject: 'review', kind: 'review', assigneeRole: 'reviewer',
    objective: 'review', acceptance: ['quality'], reviewedTaskId: 't1', dependencies: ['t1'],
  }, { internal: true });
  const result = await service.tick('alpha');
  assert.equal(result.materialized, 1);
  assert.equal(result.dispatched, 1);
  assert.equal(store.listMembers('alpha').length, 1);
  assert.equal(store.getTask('t1').assignee, 'Engineer 01');
  assert.equal(store.getTask('review').assignee, undefined);
  store.close();
});

test('contractor admission counts sessions across teams and reserves the last slot', async () => {
  const { config, store, service, adapter } = setup();
  config.scheduler.maxTotalSessions = 2;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  const member = service.addMember('alpha', { name: 'Engineer 01', role: 'engineer' });
  store.updateMember(member.id, { sessionId: 'worker-session' });
  store.updateTeam('alpha', { captainSessionId: 'captain-session' });
  const submitted = await service.submitContractor({ teamId: 'beta', purpose: 'patrol', prompt: 'review' });
  assert.equal(submitted.status, 'queued');
  assert.equal(adapter.calls.filter((call) => call.kind === 'create').length, 0);
  assert.equal(service.workspaceSessionCount(), 2);
  store.updateTeam('alpha', { captainSessionId: undefined });
  service.pumpContractors();
  await service.contractorRuns.get(submitted.id);
  assert.equal(store.getContractor(submitted.id).status, 'completed');
  store.close();
});

test('captain and shadow starts respect the workspace session count', async () => {
  const { config, store, service, adapter } = setup();
  config.scheduler.maxTotalSessions = 1;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  store.updateTeam('alpha', { captainSessionId: 'existing-captain' });
  await assert.rejects(() => service.ensureCaptainSession(store.getTeam('beta')), (error) => error.code === 'E_SESSION_CAP');
  await assert.rejects(() => service.startShadow({ teamId: 'beta' }), (error) => error.code === 'E_SESSION_CAP');
  assert.equal(adapter.calls.filter((call) => call.kind === 'create').length, 0);
  assert.equal(service.workspaceSessionCount(), 1);
  store.close();
});

test('a starting shadow reserves a control slot before its session exists', async () => {
  const { config, store, service, adapter } = setup();
  config.scheduler.maxControlSessions = 1;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  let finish;
  adapter.create = async () => new Promise((resolve) => { finish = resolve; });
  const starting = service.startShadow({ teamId: 'alpha' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.controlSessionCount(), 1);
  await assert.rejects(() => service.ensureCaptainSession(store.getTeam('beta')), (error) => error.code === 'E_CONTROL_CAP');
  finish({ sessionId: 'shadow-pending' });
  assert.equal((await starting).ok, true);
  store.close();
});

test('worker creation reserves the last workspace slot across teams', async () => {
  const { config, store, service, adapter } = setup();
  config.scheduler.maxTotalSessions = 1;
  config.scheduler.dynamicTeams = false;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  service.addTask('alpha', implementationTask('a'));
  service.addTask('beta', implementationTask('b'));
  const originalCreate = adapter.create.bind(adapter);
  let release;
  let started;
  const arrived = new Promise((resolve) => { started = resolve; });
  adapter.create = async (input) => {
    started();
    await new Promise((resolve) => { release = resolve; });
    return originalCreate(input);
  };
  const first = service.tick('alpha');
  await arrived;
  assert.equal(service.workspaceSessionCount(), 1);
  const second = await service.tick('beta');
  assert.equal(second.dispatched, 0);
  assert.equal(store.getTask('b').status, 'pending');
  release();
  assert.equal((await first).dispatched, 1);
  assert.equal(service.workspaceSessionCount(), 1);
  store.close();
});

test('unknown worker session creation keeps its reservation and holds the task', async () => {
  const { store, service, adapter } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('a'));
  let creates = 0;
  adapter.create = async () => { creates += 1; throw new Error('response lost after create'); };
  await service.tick('alpha');
  const member = store.listMembers('alpha')[0];
  assert.equal(member.workerSessionStart.state, 'unknown');
  assert.equal(store.getTask('a').hold.class, 'session_creation_unknown');
  assert.equal(store.getTeam('alpha').needsCaptain, true);
  assert.equal(service.workspaceSessionCount(), 1);
  await service.tick('alpha');
  assert.equal(creates, 1);
  store.close();
});

test('session retirement retains occupancy and revokes the member token without side-effect proof', async () => {
  const { store, service, adapter } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const member = service.addMember('alpha', { name: 'worker', role: 'engineer' });
  const token = store.getMemberToken(member.id);
  store.updateMember(member.id, { sessionId: 'possibly-live', status: 'idle', workState: 'available' });
  adapter.stop = async () => ({ ok: true });
  adapter.close = async () => ({ ok: true });
  adapter.verifySessionTermination = undefined;
  const result = await service.sleepMember('alpha', member.id);
  assert.equal(result.ok, false);
  assert.equal(result.needsCaptain, true);
  assert.equal(store.getMember(member.id).sessionId, 'possibly-live');
  assert.equal(store.getMember(member.id).sessionRecoveryState, 'unknown');
  assert.equal(store.findMemberByToken(token), undefined);
  assert.equal(service.workspaceSessionCount(), 1);
  store.close();
});

test('a stale worker create cannot overwrite a newer reservation', async () => {
  const { store, service, adapter } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('a'));
  let finish;
  let notify;
  const arrived = new Promise((resolve) => { notify = resolve; });
  adapter.create = async () => { notify(); return new Promise((resolve) => { finish = resolve; }); };
  const old = service.tick('alpha');
  await arrived;
  const member = store.listMembers('alpha')[0];
  const previous = member.workerSessionStart.operationId;
  store.updateMember(member.id, { workerSessionStart: { operationId: 'new-operation', state: 'starting', attemptId: 'new-attempt' } });
  store.updateTask('a', { attemptId: 'new-attempt' });
  finish({ sessionId: 'old-session' });
  await old;
  assert.equal(store.getMember(member.id).workerSessionStart.operationId, 'new-operation');
  assert.equal(store.getTeam('alpha').workerSessionConflicts[0].operationId, previous);
  assert.equal(store.getTeam('alpha').workerSessionConflicts[0].sessionId, 'old-session');
  assert.equal(service.workspaceSessionCount(), 2);
  assert.equal(store.getTask('a').hold.class, 'session_conflict');
  assert.equal(store.getTask('a').attemptId, undefined);
  store.close();
});

test('an unknown control-session conflict remains charged to both budgets', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.updateTeam('alpha', { workerSessionConflicts: [{ operationId: 'old', sessionId: 'old-session', control: true, state: 'unknown' }] });
  assert.equal(service.controlSessionCount(), 1);
  assert.equal(service.workspaceSessionCount(), 1);
  store.close();
});

test('a control create with no returned ID retains its old reservation beside the new one', () => {
  const { config, store, service } = setup();
  config.scheduler.maxControlSessions = 2;
  config.scheduler.maxTotalSessions = 2;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const lead = service.addMember('alpha', { name: 'lead', role: 'lead' });
  store.updateMember(lead.id, { workerSessionStart: { operationId: 'new-operation', state: 'starting' } });
  service.recordUnknownWorkerSession('alpha', lead.id, 'old-operation', 'old-attempt', undefined, 'create response lost');
  assert.equal(store.getMember(lead.id).workerSessionStart.operationId, 'new-operation');
  assert.equal(store.getTeam('alpha').workerSessionConflicts[0].operationId, 'old-operation');
  assert.equal(service.controlSessionCount(), 2);
  assert.equal(service.workspaceSessionCount(), 2);
  assert.throws(() => service.assertControlBudget(), (error) => error.code === 'E_CONTROL_CAP');
  assert.throws(() => service.assertWorkspaceSessionBudget(), (error) => error.code === 'E_SESSION_CAP');
  store.close();
});

test('merge blocks historical, self or identity-less review before touching Git', async () => {
  const { config, store, service } = setup();
  config.quality.requireIndependentReview = true;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const author = service.addMember('alpha', { name: 'author', role: 'engineer' });
  const reviewer = service.addMember('alpha', { name: 'reviewer', role: 'reviewer' });
  store.addTask({ id: 'merge-root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    assignee: author.name, assigneeId: author.id, worktree: 'not-a-worktree' });
  store.addTask({ id: 'merge-review', teamId: 'alpha', kind: 'review', status: 'completed', verdict: 'pass',
    reviewedTaskId: 'merge-root', assignee: reviewer.name, assigneeId: reviewer.id, archived: true });
  for (const patch of [
    { archived: true },
    { archived: false, assigneeId: author.id },
    { archived: false, assigneeId: undefined },
  ]) {
    store.updateTask('merge-review', patch);
    const result = await service.mergeTask('alpha', 'merge-root');
    assert.equal(result.ok, false);
    assert.equal(result.needsCaptain, true);
    assert.match(result.error, /independent review/);
  }
  store.close();
});

test('post-merge review claims persist before the external reviewer starts', async () => {
  const { config, store, service, adapter } = setup();
  config.quality.postMergeReview = 'contractor';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'merged', teamId: 'alpha', kind: 'work', status: 'completed',
    mergeCommit: 'commit-a', mergeState: 'review_pending' });
  const other = new TeamService({ homeRoot: testHomeRoot(), store, adapter, config, cwd: process.cwd(), now: () => 1000 });
  let resolveReview;
  let calls = 0;
  const spawn = async () => { calls += 1; return new Promise((resolve) => { resolveReview = resolve; }); };
  service.spawnContractor = spawn;
  other.spawnContractor = spawn;
  const first = service.reviewMerge('alpha', 'merged');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getTask('merged').postMergeClaim.state, 'claimed');
  const duplicate = await other.reviewMerge('alpha', 'merged');
  assert.equal(duplicate.needsCaptain, true);
  assert.equal(calls, 1);
  resolveReview({ id: 'reviewer-one', status: 'completed', result: 'no verdict' });
  assert.equal((await first).verdict, 'unknown');
  assert.equal(store.listMergeReviews('alpha', 'merged').length, 1);
  store.close();
});

test('an interrupted integration intent blocks automatic Git replay', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'held-merge', teamId: 'alpha', kind: 'work', status: 'completed', worktree: 'never-opened',
    integrationIntent: { operationId: 'earlier', state: 'prepared', branch: 'integration/held' } });
  const result = await service.mergeTask('alpha', 'held-merge');
  assert.equal(result.ok, false);
  assert.equal(result.needsCaptain, true);
  assert.match(result.error, /reconciliation/);
  assert.equal(store.getTask('held-merge').integrationIntent.operationId, 'earlier');
  store.close();
});

test('integration intent and ownership survive through review and cleanup in a real Git repository', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-integration-intent-'));
  const worktree = `${repo}-task`;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const { config, store, service } = setup({
    handler: async () => ({ response: JSON.stringify({ verdict: 'pass', evidence: 'reviewed' }) }),
    artifactFenceProvider: {
      async acquire(input) {
        return { ...input, state: 'frozen', proof: 'test-fence-proof-0123456789',
          verify: async () => true, release: async () => {} };
      },
    },
  });
  try {
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'file.txt'), 'before');
    git(repo, 'add', 'file.txt');
    git(repo, 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'worktree', 'add', '-b', 'worker', worktree, 'HEAD');
    writeFileSync(join(worktree, 'file.txt'), 'after');
    git(worktree, 'add', 'file.txt');
    git(worktree, 'commit', '-m', 'change');
    service.repo = repo;
    service.cwd = repo;
    config.quality.postMergeReview = 'contractor';
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 'merge-work', teamId: 'alpha', kind: 'work', status: 'completed', worktree,
      inScope: ['file.txt'], worktreeBase: base, lastAttemptId: 'merge-attempt' });
    store.addTask({ id: 'guard-review', teamId: 'alpha', kind: 'review', status: 'completed', reviewedTaskId: 'merge-work' });
    const blockedWrites = [];
    const unsubscribe = store.subscribe((event) => {
      if (event.type !== 'team.updated' || !event.data.publicationGuard) return;
      try { store.updateTask('guard-review', { archived: true }); } catch (error) { blockedWrites.push(error.code); }
    });
    const result = await service.mergeTask('alpha', 'merge-work');
    unsubscribe();
    assert.equal(result.ok, true, JSON.stringify({ result, conflicts: store.getTeam('alpha').integrationConflicts }));
    const task = store.getTask('merge-work');
    assert.equal(task.mergeState, 'merged');
    assert.equal(task.integrationIntent.state, 'settled');
    assert.equal(task.integrationOwnership.operationId, task.integrationIntent.operationId);
    assert.equal(readFileSync(join(repo, 'file.txt'), 'utf8'), 'after');
    assert.equal(store.listEvents('alpha').some((event) => event.type === 'merge.integration_prepared'), true);
    assert.deepEqual(blockedWrites, ['E_PUBLICATION_HELD', 'E_PUBLICATION_HELD']);
    assert.notEqual(store.getTask('guard-review').archived, true);
  } finally {
    store.close();
    service.close();
    removeTreeWithRetry(worktree);
    removeTreeWithRetry(repo);
  }
});

test('post-merge publication is held if the delivery review is archived while the reviewer runs', async () => {
  const { config, store, service } = setup();
  config.quality.postMergeReview = 'contractor';
  config.quality.requireIndependentReview = true;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const author = service.addMember('alpha', { name: 'author', role: 'engineer' });
  const reviewer = service.addMember('alpha', { name: 'reviewer', role: 'reviewer' });
  store.addTask({ id: 'root', teamId: 'alpha', kind: 'implementation', status: 'completed',
    assigneeId: author.id, sourceCommit: 'source', sourceBase: 'base', diffHash: 'digest', deliveryUnitId: 'root', deliverySeq: 0,
    mergeCommit: 'source', mergeState: 'review_pending' });
  store.addTask({ id: 'delivery-review', teamId: 'alpha', kind: 'review', status: 'completed', verdict: 'pass',
    assigneeId: reviewer.id, reviewedTaskId: 'root', reviewMode: 'bound', scores: { overall: 4.5, code: 4.5 },
    binding: { sourceTaskId: 'root', deliveryUnitId: 'root', deliverySeq: 0, sourceBase: 'base', sourceCommit: 'source', diffHash: 'digest' } });
  let finish;
  service.spawnContractor = async () => new Promise((resolve) => { finish = resolve; });
  const running = service.reviewMerge('alpha', 'root');
  await new Promise((resolve) => setImmediate(resolve));
  store.updateTask('delivery-review', { archived: true });
  finish({ id: 'ctr', status: 'completed', result: JSON.stringify({ verdict: 'pass', evidence: 'ok', overall: 4.5, code: 4.5,
    findings: [], acceptanceResults: [], commandsRun: [] }) });
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.needsCaptain, true);
  assert.equal(store.getTask('root').mergeState, 'review_stale');
  store.close();
});

test('malformed bound post-merge verdict is held with an unknown claim', async () => {
  const { config, store, service } = setup();
  config.quality.postMergeReview = 'contractor';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'bound-unknown', teamId: 'alpha', kind: 'implementation', status: 'completed',
    mode: 'bound', sourceCommit: 'source', mergeCommit: 'source', mergeState: 'review_pending' });
  service.spawnContractor = async () => ({ id: 'reviewer', status: 'completed', result: '{"verdict":"pass"}' });
  const result = await service.reviewMerge('alpha', 'bound-unknown');
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.needsCaptain, true);
  assert.equal(store.getTask('bound-unknown').postMergeClaim.state, 'unknown');
  assert.equal(store.getTask('bound-unknown').mergeState, 'review_pending_internal');
  assert.equal(store.getTeam('alpha').needsCaptain, true);
  store.close();
});

test('bound post-merge repair inherits unit lineage and is ready after verified rollback', () => {
  const { config, store, service } = setup();
  config.quality.requireIndependentReview = true;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const author = service.addMember('alpha', { name: 'author', role: 'engineer' });
  const reviewer = service.addMember('alpha', { name: 'reviewer', role: 'reviewer' });
  const root = { id: 'bound-root-post', teamId: 'alpha', kind: 'implementation', status: 'completed',
    subject: 'root', objective: 'works', assignee: author.name, assigneeId: author.id, dependencies: [],
    mode: 'bound', deliveryUnitId: 'bound-root-post', deliverySeq: 0, taskEpoch: 0,
    sourceBase: 'base', sourceCommit: 'source', diffHash: 'digest', mergeCommit: 'source',
    postMergeReview: 'needs_revision', negativeMergeIntent: { phase: 'settled', verdict: 'needs_revision', mergeCommit: 'source' },
    acceptance: ['works'], inScope: ['src/'], outOfScope: ['src/private/'], verify: ['node --test'] };
  const review = { id: 'bound-root-post-review', teamId: 'alpha', kind: 'review', status: 'completed',
    subject: 'review', objective: 'review', acceptance: ['reviewed'], dependencies: [root.id],
    assignee: reviewer.name, assigneeId: reviewer.id, reviewedTaskId: root.id,
    reviewMode: 'bound', verdict: 'pass', scores: { overall: 4.5, code: 4.5 }, deliveryGeneration: 0,
    binding: { sourceTaskId: root.id, deliveryUnitId: root.id, deliverySeq: 0, sourceBase: 'base', sourceCommit: 'source', diffHash: 'digest' } };
  store.addTask(root);
  store.addTask(review);
  const verdict = { verdict: 'needs_revision', evidence: 'fix', findings: [{ id: 'f', severity: 'high',
    file: 'src/a.js', line: 1, problem: 'bug', requiredFix: 'fix the bug' }] };
  store.updateTask(root.id, { mergeState: 'rejected', repairPlanPending: true,
    negativeMergeIntent: { operationId: 'post-op', phase: 'settled', verdict: 'needs_revision',
      mergeCommit: root.mergeCommit, evidence: verdict.evidence, findings: verdict.findings, mergeReviewId: 'post-review' } });
  store.updateTask(root.id, { negativeMergeIntent: { ...store.getTask(root.id).negativeMergeIntent, verdict: 'reject' } });
  assert.equal(service.createRepairForRejectedMerge('alpha', root, verdict, 'post-review'), undefined);
  store.updateTask(root.id, { negativeMergeIntent: { ...store.getTask(root.id).negativeMergeIntent, verdict: 'needs_revision' } });
  service.reconcilePostMergeRepairs('alpha');
  const repair = store.listTasks('alpha').find((item) => item.kind === 'repair');
  assert.ok(repair);
  assert.equal(store.getTask(root.id).repairPlanPending, false);
  assert.deepEqual(repair.dependencies, [root.id]);
  assert.equal(repair.parentReviewTaskId, review.id);
  assert.equal(repair.sourceBase, root.sourceCommit);
  assert.equal(repair.repairOrigin, 'postmerge');
  assert.equal(nextReady(store.listTasks('alpha')).some((item) => item.id === repair.id), true);
  const wrongIntent = store.listTasks('alpha').map((item) => item.id === root.id
    ? { ...item, negativeMergeIntent: { ...item.negativeMergeIntent, verdict: 'reject' } } : item);
  assert.equal(nextReady(wrongIntent).some((item) => item.id === repair.id), false);
  const wrongBinding = store.listTasks('alpha').map((item) => item.id === review.id
    ? { ...item, binding: { ...item.binding, deliverySeq: 2 } } : item);
  assert.equal(nextReady(wrongBinding).some((item) => item.id === repair.id), false);
  assert.equal(service.createRepairForRejectedMerge('alpha', root, verdict, 'post-review').id, repair.id);
  store.updateTask(repair.id, { deliveryGeneration: 1 });
  assert.equal(service.createRepairForRejectedMerge('alpha', root, verdict, 'post-review'), undefined);
  store.updateTask(repair.id, { deliveryGeneration: 0 });
  store.updateTask(repair.id, { status: 'cancelled' });
  const replacement = service.createRepairForRejectedMerge('alpha', root, verdict, 'post-review');
  assert.ok(replacement);
  assert.notEqual(replacement.id, repair.id);
  assert.equal(replacement.repairGeneration, 1);
  store.updateTask(replacement.id, { status: 'failed' });
  assert.equal(service.createRepairForRejectedMerge('alpha', root, verdict, 'post-review'), undefined);
  store.close();
});

test('legacy delivery review must still match its recorded attempt and artifact snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-review-snapshot-'));
  const { config, store, service } = setup();
  try {
    config.quality.requireIndependentReview = true;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    const author = service.addMember('alpha', { name: 'author', role: 'engineer' });
    const reviewer = service.addMember('alpha', { name: 'reviewer', role: 'reviewer' });
    writeFileSync(join(root, 'file.js'), 'original');
    store.addTask({ id: 'root', teamId: 'alpha', kind: 'implementation', status: 'completed',
      assigneeId: author.id, lastAttemptId: 'attempt-1', inScope: ['**'], worktree: root });
    const snapshot = snapshotScope(root, ['**']);
    store.addTask({ id: 'review', teamId: 'alpha', kind: 'review', status: 'completed', verdict: 'pass',
      assigneeId: reviewer.id, reviewedTaskId: 'root', reviewedAttemptId: 'attempt-1',
      reviewedArtifacts: snapshot.artifacts, reviewedGaps: snapshot.gaps });
    assert.equal(service.currentMergeReview('alpha', store.getTask('root')).review.id, 'review');
    writeFileSync(join(root, 'file.js'), 'changed');
    assert.equal(service.currentMergeReview('alpha', store.getTask('root')).review, undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('v0.6 rate limiter prevents duplicate dispatch on concurrent ticks', async () => {
  const { config, store, service, adapter } = setup();
  config.zcode.maxRequestsPerMinute = 60000;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await Promise.all([service.tick('alpha'), service.tick('alpha')]);
  assert.equal(adapter.calls.filter((call) => call.kind === 'create').length, 1);
  assert.equal(store.listTasks('alpha').filter((task) => task.attemptId).length, 1);
  store.close();
});

test('a task held while dispatch waits does not start an attempt or session', async () => {
  const { store, service, adapter } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  service.dispatchLimiter = { acquire: async () => store.updateTask('t1', { hold: { class: 'legacy_unbound' } }) };
  const result = await service.tick('alpha');
  assert.equal(result.dispatched, 0);
  assert.equal(store.getTask('t1').attemptId, undefined);
  assert.equal(adapter.calls.filter((call) => call.kind === 'create').length, 0);
  store.close();
});

test('claim rejects held, archived and legacy red tasks before changing a member', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  for (const [id, flags] of [['held', { hold: { class: 'legacy_unbound' } }],
    ['archived', { archived: true }], ['old-red', { legacyRedReview: true }]]) {
    service.addTask('alpha', implementationTask(id));
    store.updateTask(id, flags);
    assert.throws(() => service.claimTask('alpha', id, 'Engineer 01'), (error) => error.code === 'E_STATE');
  }
  store.close();
});

test('restart holds active work and retains sessions until termination is proven', async () => {
  const { config, store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  assert.ok(store.getTask('t1').attemptId);
  const restarted = new TeamService({ homeRoot: testHomeRoot(),
    store,
    adapter: new FakeSessionAdapter(),
    config,
    cwd: process.cwd(),
    now: () => 2000,
  });
  const recovered = await restarted.reconcileAfterRestart();
  assert.deepEqual(recovered.tasks, ['t1']);
  assert.equal(store.getTask('t1').status, 'pending');
  assert.equal(store.getTask('t1').attemptId, undefined);
  assert.ok(store.listMembers('alpha')[0].sessionId);
  assert.equal(store.listMembers('alpha')[0].sessionRecoveryState, 'unknown');
  assert.equal(store.getTask('t1').hold.class, 'restart_session_unknown');
  assert.equal(store.getTeam('alpha').needsCaptain, true);
  await restarted.tick('alpha');
  assert.equal(store.getTask('t1').attemptId, undefined);
  store.close();
});

test('v0.6 applies default model and reasoning to lazy and explicit members', async () => {
  const { config, store, service } = setup();
  config.zcode.defaultModel = 'provider-b/model-x';
  config.zcode.defaultReasoning = 'max';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const lazy = store.listMembers('alpha')[0];
  assert.equal(lazy.model, config.zcode.defaultModel);
  assert.equal(lazy.reasoning, config.zcode.defaultReasoning);
  const explicit = service.addMember('alpha', { name: 'Engineer 02', role: 'engineer' });
  assert.equal(explicit.model, config.zcode.defaultModel);
  assert.equal(explicit.reasoning, config.zcode.defaultReasoning);
  store.close();
});

test('v0.6 waiting members cannot re-license; settled members can, and sessions stay cold', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const engineer = store.listMembers('alpha')[0];
  assert.equal(service.settlementStatus('alpha', engineer.id).settled, false);
  const blocked = await service.relicenseMember('alpha', engineer.id, { label: 'Analyst 01', roleKey: 'analyst', reason: 'reuse' });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.length > 0);

  const task = store.getTask('t1');
  await service.completeTask({
    teamId: 'alpha', taskId: 't1', attemptId: task.attemptId,
    update: { status: 'completed', acceptanceResults: [{ criterion: 'works', status: 'passed' }], changedPaths: ['src/a.js'] },
  });
  assert.equal(service.settlementStatus('alpha', engineer.id).settled, true);
  const rel = await service.relicenseMember('alpha', engineer.id, {
    label: 'Analyst 01', roleKey: 'analyst', reason: 'role change',
  });
  assert.equal(rel.ok, true);
  assert.equal(rel.member.name, 'Analyst 01');
  assert.equal(rel.member.role, 'analyst');
  assert.equal(rel.member.license.allowedTaskKinds.includes('requirements'), true);
  assert.equal(rel.member.sessionId, undefined);
  assert.equal(rel.member.residency, 'cold');
  assert.equal(store.listLicenseHistory('alpha', engineer.id).length >= 2, true);
  store.close();
});

test('v0.6 compression compacts and sleeps idle members, then wakes them', async () => {
  const { store, service, advance } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const task = store.getTask('t1');
  await service.completeTask({
    teamId: 'alpha', taskId: 't1', attemptId: task.attemptId,
    update: { status: 'completed', acceptanceResults: [{ criterion: 'works', status: 'passed' }], changedPaths: ['src/a.js'] },
  });
  const member = store.listMembers('alpha')[0];
  advance(4 * 60 * 1000);
  let tick = await service.lifecycleTick('alpha');
  assert.equal(tick.compacted, 1);
  assert.equal(store.getMember(member.id).residency, 'warm');
  advance(11 * 60 * 1000);
  tick = await service.lifecycleTick('alpha');
  assert.equal(tick.slept, 1);
  assert.equal(store.getMember(member.id).residency, 'cold');
  assert.equal(store.getMember(member.id).sessionId, undefined);
  const woke = service.wakeMember('alpha', member.id);
  assert.equal(woke.member.residency, 'warm');
  store.close();
});

test('v0.6 contractor runs once and returns its verdict', async () => {
  const { store, service, adapter } = setup({
    handler: async ({ session }) => ({
      response: session.prompt.includes('post-merge')
        ? JSON.stringify({ verdict: 'pass', evidence: 'tests passed' })
        : 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const contractor = await service.spawnContractor({
    teamId: 'alpha', purpose: 'post_merge_review:t1',
    prompt: 'post-merge review this patch',
  });
  assert.equal(contractor.status, 'completed');
  assert.match(contractor.result, /pass/);
  assert.ok(adapter.calls.some((call) => call.kind === 'create' && call.input.ephemeral === true));
  assert.equal(store.listContractors('alpha').length, 1);
  assert.equal(store.listContractors('alpha')[0].sessionId, undefined);
  store.close();
});

test('v0.6 contractor inherits default model and reasoning', async () => {
  const { config, store, service } = setup();
  config.zcode.defaultModel = 'provider-b/model-x';
  config.zcode.defaultReasoning = 'max';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const contractor = await service.spawnContractor({
    teamId: 'alpha', purpose: 'audit', prompt: 'read only audit', mode: 'read-only',
  });
  assert.equal(contractor.model, config.zcode.defaultModel);
  assert.equal(contractor.reasoning, config.zcode.defaultReasoning);
  store.close();
});

test('v0.6 post-merge review marks a passing merge and records the verdict', async () => {
  const { config, store, service } = setup({
    handler: async () => ({ response: JSON.stringify({ verdict: 'pass', evidence: 'tests passed' }) }),
  });
  config.quality.postMergeReview = 'contractor';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
  store.addTask({ id: 't1', teamId: 'alpha', subject: 'impl', kind: 'work', assignee: 'Engineer 01', status: 'completed' });
  store.updateTask('t1', { mergeCommit: 'deadbeef', mergeState: 'review_pending' });
  const result = await service.reviewMerge('alpha', 't1');
  assert.equal(result.verdict, 'pass');
  assert.equal(store.getTask('t1').mergeState, 'merged');
  assert.equal(store.listMergeReviews('alpha', 't1')[0].verdict, 'pass');
  store.close();
});

test('v0.6 patrol wakes the captain when idle and uses a contractor when captain is busy', async () => {
  const { store, service, adapter } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }, { name: 'captain' }] });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'Engineer 01' });
  await service.tick('alpha');
  let patrol = await service.patrol('alpha');
  assert.equal(patrol.ran, true);
  assert.equal(patrol.captainBusy, false);
  assert.ok(adapter.calls.some((call) => call.kind === 'send' && call.input.sessionId));

  const { config: config2, store: store2, service: service2 } = setup();
  // The legacy contractor fallback is opt-in; `queue` is the default now.
  config2.patrol.whenCaptainBusy = 'one-shot-contractor';
  service2.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 02' }] });
  service2.addTask('alpha', { id: 't2', subject: 'work', kind: 'work', assignee: 'Engineer 02' });
  await service2.tick('alpha');
  store2.updateTeam('alpha', { captainBusy: true });
  patrol = await service2.patrol('alpha');
  assert.equal(patrol.ran, true);
  assert.equal(patrol.captainBusy, true);
  assert.equal(store2.listContractors('alpha').length, 1);
  store.close();
  store2.close();
});

test('v0.6 patrol writes lastPatrolAt before awaiting a hanging send', async () => {
  let releaseSend;
  let sendStarted;
  const started = new Promise((resolve) => { sendStarted = resolve; });
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const { store, service } = setup({
    handler: async () => {
      sendStarted();
      await sendGate;
      return { response: 'ok' };
    },
  });
  service.createTeam({
    id: 'alpha',
    name: 'Alpha',
    phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }],
  });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'Engineer 01' });
  const pending = service.patrol('alpha');
  await started;
  assert.ok(store.getTeam('alpha').lastPatrolAt > 0);
  releaseSend();
  await pending;
  store.close();
});

test('v0.6 patrol timeout during captain creation never sends after create settles', async () => {
  let releaseCreate;
  let createStarted;
  const started = new Promise((resolve) => { createStarted = resolve; });
  const gate = new Promise((resolve) => { releaseCreate = resolve; });
  const { store, service, adapter } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }, { name: 'captain' }] });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'Engineer 01' });
  service.patrolTimeoutMs = 20;
  const create = adapter.create.bind(adapter);
  adapter.create = async (input) => {
    createStarted();
    await gate;
    return create(input);
  };
  const pending = service.patrol('alpha');
  await started;
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseCreate();
  const result = await pending;
  assert.equal(result.reason, 'patrol-timeout');
  assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, 0);
  assert.equal(service.patrolInFlight.has('alpha'), false);
  store.close();
});

test('v0.6 patrol timeout aborts contractor submit before creating a contractor', async () => {
  let releaseSubmit;
  let submitStarted;
  const started = new Promise((resolve) => { submitStarted = resolve; });
  const gate = new Promise((resolve) => { releaseSubmit = resolve; });
  const { config, store, service } = setup();
  config.patrol.whenCaptainBusy = 'one-shot-contractor';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'Engineer 01' });
  store.updateTeam('alpha', { captainBusy: true });
  service.patrolTimeoutMs = 20;
  service.patrolCancelTimeoutMs = 20;
  const submit = service.submitContractor.bind(service);
  let submitCalls = 0;
  service.submitContractor = async (...args) => {
    submitCalls += 1;
    submitStarted();
    await gate;
    return submit(...args);
  };
  const pending = service.patrol('alpha');
  await started;
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseSubmit();
  const result = await pending;
  assert.equal(result.reason, 'patrol-timeout');
  assert.equal(submitCalls, 1);
  assert.equal(store.listContractors('alpha').length, 0);
  assert.equal(service.patrolInFlight.has('alpha'), false);
  store.close();
});

test('v0.6 patrol cancels a contractor created before delayed submit returns', async () => {
  let releaseReturn;
  let submitStarted;
  const started = new Promise((resolve) => { submitStarted = resolve; });
  const gate = new Promise((resolve) => { releaseReturn = resolve; });
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const { config, store, service, adapter } = setup({ handler: async () => { await sendGate; return { response: 'done' }; } });
  config.patrol.whenCaptainBusy = 'one-shot-contractor';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'Engineer 01' });
  store.updateTeam('alpha', { captainBusy: true });
  service.patrolTimeoutMs = 20;
  service.patrolCancelTimeoutMs = 20;
  service.waitForContractor = async () => new Promise(() => {});
  const submit = service.submitContractor.bind(service);
  let submitCalls = 0;
  service.submitContractor = async (...args) => {
    submitCalls += 1;
    const record = await submit(...args);
    submitStarted();
    await gate;
    return record;
  };
  const pending = service.patrol('alpha');
  await started;
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseReturn();
  const result = await pending;
  assert.equal(result.reason, 'patrol-cancel-failed');
  assert.equal(submitCalls, 1);
  assert.equal(store.listContractors('alpha').length, 1);
  assert.equal(store.listContractors('alpha')[0].status, 'cleanup_error');
  assert.equal(service.patrolInFlight.has('alpha'), true);
  assert.ok(adapter.calls.some((call) => call.kind === 'stop'));
  releaseSend();
  await Promise.all([...service.contractorRuns.values()]);
  await new Promise((resolve) => setTimeout(resolve, 15));
  // Cleanup the pending patrol without starting another external action.
  store.updateTeam('alpha', { phase: 'halted' });
  await service.patrol('alpha');
  store.close();
});

test('v0.6 patrol keeps its guard while a contractor is cancelling until runner settles', async () => {
  let releaseRunner;
  let cancelStarted;
  const started = new Promise((resolve) => { cancelStarted = resolve; });
  const runnerGate = new Promise((resolve) => { releaseRunner = resolve; });
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.patrolTimeoutMs = 20;
  service.patrolCancelTimeoutMs = 20;
  let runs = 0;
  service.patrolOnce = async (_teamId, { onExternal }) => {
    runs += 1;
    onExternal({ type: 'contractor', cancel: async () => { cancelStarted(); return { status: 'cancelling' }; } });
    await runnerGate;
    return { ran: true };
  };
  const pending = service.patrol('alpha');
  await started;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(service.patrolInFlight.has('alpha'), true);
  assert.equal((await service.patrol('alpha')).reason, 'patrol-cancel-failed');
  assert.equal(runs, 1);
  releaseRunner();
  await pending;
  assert.equal(service.patrolInFlight.has('alpha'), true);
  const retry = await service.patrol('alpha');
  assert.equal(retry.ran, true);
  assert.equal(runs, 2);
  assert.equal(service.patrolInFlight.has('alpha'), false);
  store.close();
});

test('v0.6 patrolTickAll does not re-enter a team with a pending patrol send', async () => {
  const { store, service, advance } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  service.patrolOnce = async () => {
    calls += 1;
    await gate;
    return { ran: true };
  };
  advance(60 * 60 * 1000);
  const first = service.patrolTickAll();
  await new Promise((resolve) => setImmediate(resolve));
  advance(60 * 60 * 1000);
  const second = await service.patrolTickAll();
  assert.equal(second.length, 1);
  assert.equal(second[0].reason, 'patrol-in-flight');
  assert.equal(calls, 1);
  release();
  await first;
  store.close();
});

test('v0.6 patrolTickAll isolates a failing team and records patrol.failed', async () => {
  const { store, service, advance } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  service.patrol = async (teamId) => {
    if (teamId === 'alpha') throw new Error('boom');
    return { ran: true };
  };
  advance(60 * 60 * 1000);
  const results = await service.patrolTickAll();
  const alpha = results.find((item) => item.teamId === 'alpha');
  const beta = results.find((item) => item.teamId === 'beta');
  // One team's exception must not cancel the other team's patrol.
  assert.equal(alpha.reason, 'error');
  assert.match(alpha.error, /boom/);
  assert.equal(beta.ran, true);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'patrol.failed'));
  store.close();
});

test('v0.6 a failed cancellation keeps the guard and blocks a duplicate send', async () => {
  const { store, service, adapter, advance } = setup({
    handler: async () => {
      await new Promise(() => {});
      return { response: 'never' };
    },
  });
  service.createTeam({
    id: 'alpha',
    name: 'Alpha',
    phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }],
  });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'Engineer 01' });
  service.patrolTimeoutMs = 20;
  service.patrolCancelTimeoutMs = 20;
  const stop = adapter.stop.bind(adapter);
  adapter.stop = async () => { throw new Error('stop unavailable'); };
  const first = await service.patrol('alpha');
  assert.equal(first.reason, 'patrol-cancel-failed');
  assert.equal(first.cancelled, false);
  assert.equal(service.patrolInFlight.has('alpha'), true);
  advance(60 * 60 * 1000);
  const second = await service.patrol('alpha');
  assert.equal(second.reason, 'patrol-cancel-failed');
  // The abandoned send is still alive: no second send may start.
  assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, 1);
  // A stop acknowledgement alone is insufficient while the original patrol is unsettled.
  adapter.stop = stop;
  const third = await service.patrol('alpha');
  assert.equal(third.reason, 'patrol-cancel-failed');
  assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, 1);
  store.close();
});

test('v0.6 patrol interval is tracked per team', async () => {
  const { store, service, advance } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  advance(60 * 60 * 1000);
  const seen = [];
  service.patrol = async (teamId) => {
    seen.push(teamId);
    return { ran: true };
  };
  // Alpha patrolled just now; beta has never been patrolled.
  service.patrolLastAt.set('alpha', service.now());
  const results = await service.patrolTickAll();
  assert.deepEqual(results.map((item) => item.teamId), ['beta']);
  assert.deepEqual(seen, ['beta']);
  store.close();
});

test('v0.6 a hanging patrol is cancelled before its guard is released', async () => {
  let releaseSend;
  let sendStarted;
  const started = new Promise((resolve) => { sendStarted = resolve; });
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const { store, service, adapter, advance } = setup({
    handler: async () => {
      sendStarted();
      await sendGate;
      return { response: 'settled' };
    },
  });
  service.createTeam({
    id: 'alpha',
    name: 'Alpha',
    phase: 'running',
    members: [{ name: 'Engineer 01' }, { name: 'captain' }],
  });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'Engineer 01' });
  service.patrolTimeoutMs = 20;
  adapter.stop = async (input) => {
    adapter.calls.push({ kind: 'stop', input });
    releaseSend();
    return { ok: true };
  };
  const pending = service.patrol('alpha');
  await started;
  const first = await pending;
  // The original send settles after stop, so the guard is released. Its
  // delivery result is still ambiguous and must not be replayed automatically.
  assert.equal(first.reason, 'patrol-timeout');
  assert.equal(first.ran, false);
  assert.equal(first.cancelled, true);
  assert.equal(adapter.calls.filter((call) => call.kind === 'stop').length, 1);
  assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, 1);
  assert.equal(service.patrolInFlight.has('alpha'), false);
  assert.equal(service.patrolStartedAt.has('alpha'), false);
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'patrol.stalled').length, 1);
  advance(60 * 60 * 1000);
  const second = await service.patrol('alpha');
  assert.equal(second.ran, false);
  assert.equal(second.reason, 'patrol-delivery-unknown');
  assert.equal(store.getTeam('alpha').patrolPending.state, 'unknown');
  assert.equal(adapter.calls.filter((call) => call.kind === 'stop').length, 1);
  store.close();
});

for (const hangingStop of [true, false]) {
  test(`patrol retains ownership when ${hangingStop ? 'stop never acknowledges' : 'stop acknowledges but send remains active'}`, async () => {
    let releaseSend;
    let releaseStop;
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    let active = 0;
    const { store, service, adapter } = setup({ handler: async () => {
      active += 1;
      await sendGate;
      active -= 1;
      return { response: 'done' };
    } });
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
    service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'Engineer 01' });
    service.patrolTimeoutMs = 10;
    service.patrolCancelTimeoutMs = 10;
    let stops = 0;
    adapter.stop = async () => { stops += 1; if (hangingStop) await stopGate; return { ok: true }; };
    const first = await service.patrol('alpha');
    assert.equal(first.reason, 'patrol-cancel-failed');
    assert.equal(first.cancelled, false);
    assert.equal(active, 1);
    assert.equal(service.patrolInFlight.has('alpha'), true);
    const retries = await Promise.all([service.patrol('alpha'), service.patrol('alpha')]);
    assert.ok(retries.every((item) => item.reason === 'patrol-cancel-failed'));
    assert.equal(stops, 1);
    assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, 1);
    releaseStop();
    releaseSend();
    await new Promise((resolve) => setImmediate(resolve));
    store.updateTeam('alpha', { phase: 'halted' });
    await service.patrol('alpha');
    assert.equal(active, 0);
    assert.equal(service.patrolInFlight.has('alpha'), false);
    store.close();
  });
}

test('patrol retains ownership after contractor runner timeout until its raw send settles', async () => {
  let releaseSend;
  const gate = new Promise((resolve) => { releaseSend = resolve; });
  const { config, store, service, adapter } = setup({ handler: async () => { await gate; return { response: 'done' }; } });
  config.patrol.whenCaptainBusy = 'one-shot-contractor';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'Engineer 01' });
  store.updateTeam('alpha', { captainBusy: true });
  const submit = service.submitContractor.bind(service);
  service.submitContractor = (input, options) => submit({ ...input, timeoutMs: 30 }, options);
  service.patrolTimeoutMs = 10;
  service.patrolCancelTimeoutMs = 10;
  assert.equal((await service.patrol('alpha')).reason, 'patrol-cancel-failed');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(service.contractorRuns.size, 0);
  assert.equal(service.contractorSends.size, 1);
  assert.equal(service.patrolInFlight.has('alpha'), true);
  assert.equal((await service.patrol('alpha')).reason, 'patrol-cancel-failed');
  assert.equal(store.listContractors('alpha').length, 1);
  assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, 1);
  releaseSend();
  await new Promise((resolve) => setTimeout(resolve, 15));
  store.updateTeam('alpha', { phase: 'halted' });
  await service.patrol('alpha');
  assert.equal(service.contractorSends.size, 0);
  assert.equal(service.patrolInFlight.has('alpha'), false);
  store.close();
});

test('v0.6 single-team preset leaves room for a larger dual-team pool', async () => {
  const one = setup();
  one.config.scheduler.activeWorkerSlots = 16;
  one.config.scheduler.maxActivePerTeam = 16;
  one.store.close();
  const dual = setup();
  assert.equal(dual.config.scheduler.activeWorkerSlots, 6);
  assert.equal(dual.config.scheduler.maxActivePerTeam, 6);
  assert.equal(dual.config.scheduler.minActivePerTeam, 1);
  dual.store.close();
});

test('v0.6 reduces active slots on a 429 capacity error', async () => {
  const { config, store, service } = setup({ handler: async () => { throw new Error('429 too many requests'); } });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'a1' });
  const before = config.scheduler.activeWorkerSlots;
  await service.tick('alpha');
  assert.equal(config.scheduler.activeWorkerSlots, before - 1);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'concurrency.reduced'));
  store.close();
});

test('v0.6 post-merge reject reverts, needs captain and does not create a repair', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-review-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'two', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'second'], { cwd: repo });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    const { config, store, service } = setup({
      handler: async () => ({ response: JSON.stringify({ verdict: 'reject', evidence: 'broken' }) }),
    });
    service.repo = repo;
    service.cwd = repo;
    config.quality.postMergeReview = 'contractor';
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
    store.addTask({ id: 't1', teamId: 'alpha', subject: 'impl', kind: 'work', assignee: 'Engineer 01', status: 'completed' });
    store.updateTask('t1', { mergeCommit: commit, mergeState: 'review_pending' });
    const result = await service.reviewMerge('alpha', 't1');
    assert.equal(result.verdict, 'reject');
    assert.equal(store.getTask('t1').mergeState, 'rejected');
    assert.equal(result.reverted, true);
    assert.equal(store.getTask('t1').needsCaptain, true);
    assert.equal(store.getTask('t1').negativeMergeIntent.phase, 'settled');
    assert.equal(store.getTask('t1').negativeMergeIntent.verdict, 'reject');
    assert.equal(execFileSync('git', ['show', 'HEAD:a.txt'], { cwd: repo, encoding: 'utf8' }), 'one');
    assert.equal(store.listTasks('alpha').some((task) => task.kind === 'repair'), false);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('restart holds an unsettled negative merge intent without replaying the external action', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'uncertain-rollback', teamId: 'alpha', kind: 'work', status: 'completed',
    negativeMergeIntent: { operationId: 'op-1', phase: 'prepared', verdict: 'reject', mergeCommit: 'old' } });
  await service.reconcileAfterRestart();
  assert.equal(store.getTask('uncertain-rollback').negativeMergeIntent.phase, 'prepared');
  assert.equal(store.getTask('uncertain-rollback').mergeBlockReason, 'negative_merge_outcome_unknown');
  assert.equal(store.getTeam('alpha').needsCaptain, true);
  const count = store.listEvents('alpha').filter((event) => event.type === 'merge.negative_recovery_held').length;
  assert.equal(count, 1);
  await service.reconcileAfterRestart();
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'merge.negative_recovery_held').length, count);
  store.close();
});

test('settled negative intent retries a missing repair once without replaying rollback', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({ id: 'repair-pending', teamId: 'alpha', kind: 'work', status: 'completed',
    subject: 'work', objective: 'work', dependencies: [], inScope: ['src/'], outOfScope: [],
    verify: ['node --test'], acceptance: ['works'], mergeCommit: 'source', mergeState: 'rejected',
    postMergeReview: 'needs_revision', repairPlanPending: true,
    negativeMergeIntent: { operationId: 'op-2', phase: 'settled', verdict: 'needs_revision',
      mergeCommit: 'source', evidence: 'fix it', mergeReviewId: 'mrv-test' } });
  await service.reconcileClosedLoop('alpha');
  const created = store.listTasks('alpha').filter((task) => task.kind === 'repair');
  assert.equal(created.length, 1);
  assert.equal(store.getTask('repair-pending').repairPlanPending, false);
  await service.reconcileClosedLoop('alpha');
  assert.equal(store.listTasks('alpha').filter((task) => task.kind === 'repair').length, 1);
  store.close();
});

test('v0.6 needs_revision creates a repair only after successful real Git rollback', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-revision-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'two', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'second'], { cwd: repo });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { config, store, service } = setup({ handler: async () => ({ response: JSON.stringify({ verdict: 'needs_revision', evidence: 'repair this' }) }) });
    service.repo = repo;
    service.cwd = repo;
    config.quality.postMergeReview = 'contractor';
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
    store.addTask({ id: 't1', teamId: 'alpha', subject: 'impl', kind: 'work', assignee: 'Engineer 01', status: 'completed',
      inScope: ['src/'], outOfScope: ['src/private/'], verify: ['node --test'], acceptance: ['works'] });
    store.updateTask('t1', { mergeCommit: commit, mergeState: 'review_pending' });
    const [result, repeated] = await Promise.all([service.reviewMerge('alpha', 't1'), service.reviewMerge('alpha', 't1')]);
    assert.equal(result.reverted, true);
    assert.equal(repeated.alreadyReviewed, true);
    assert.equal(result.needsCaptain, false);
    assert.equal(store.getTask('t1').needsCaptain, false);
    assert.equal(execFileSync('git', ['show', 'HEAD:a.txt'], { cwd: repo, encoding: 'utf8' }), 'one');
    assert.equal(store.listTasks('alpha').filter((task) => task.kind === 'repair').length, 1);
    const repair = store.listTasks('alpha').find((task) => task.kind === 'repair');
    assert.deepEqual(repair.inScope, ['src/']);
    assert.deepEqual(repair.outOfScope, ['src/private/']);
    assert.deepEqual(repair.dependencies, ['t1']);
    assert.match(repair.id, /^postmerge_[a-f0-9]{40}_g0$/);
    assert.equal(store.listMergeReviews('alpha', 't1').length, 1);
    assert.equal((await service.reviewMerge('alpha', 't1')).alreadyReviewed, true);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('v0.6 needs_revision without nonblank text evidence escalates after rollback', async () => {
  for (const evidence of [undefined, '  ', { issue: 'broken' }]) {
    const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-no-evidence-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      writeFileSync(join(repo, 'a.txt'), 'one');
      execFileSync('git', ['add', 'a.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
      writeFileSync(join(repo, 'a.txt'), 'two');
      execFileSync('git', ['commit', '-am', 'change'], { cwd: repo });
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      const { config, store, service } = setup({ handler: async () => ({ response: JSON.stringify({ verdict: 'needs_revision', evidence }) }) });
      service.repo = repo;
      service.cwd = repo;
      config.quality.postMergeReview = 'contractor';
      service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
      store.addTask({ id: 't1', teamId: 'alpha', subject: 'impl', kind: 'work', status: 'completed' });
      store.updateTask('t1', { mergeCommit: commit, mergeState: 'review_pending' });
      const result = await service.reviewMerge('alpha', 't1');
      assert.equal(result.reverted, true);
      assert.equal(result.needsCaptain, true);
      assert.equal(store.getTask('t1').needsCaptain, true);
      assert.equal(store.listTasks('alpha').some((task) => task.kind === 'repair'), false);
      store.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('v0.6 pass keeps cleanup pending and references when cleanup fails after fast-forward', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-pass-cleanup-'));
  const foreignWorktree = mkdtempSync(join(tmpdir(), 'ai-agent-teams-pass-foreign-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['branch', 'integration-review'], { cwd: repo });
    const { config, store, service } = setup({ handler: async () => ({ response: JSON.stringify({ verdict: 'pass', evidence: 'ok' }) }) });
    service.repo = repo;
    service.cwd = repo;
    config.quality.postMergeReview = 'contractor';
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask({ id: 't1', teamId: 'alpha', subject: 'impl', kind: 'work', status: 'completed' });
    store.updateTask('t1', { mergeCommit: commit, mergeState: 'review_pending', integrationCommit: commit, integrationBranch: 'integration-review', integrationWorktree: foreignWorktree });
    const result = await service.reviewMerge('alpha', 't1');
    assert.equal(result.ok, false);
    assert.equal(result.cleanupPending, true);
    assert.equal(store.getTask('t1').integrationWorktree, foreignWorktree);
    assert.equal(store.getTask('t1').integrationBranch, 'integration-review');
    assert.equal(store.getTask('t1').needsCaptain, true);
    assert.equal((await service.reviewMerge('alpha', 't1')).alreadyReviewed, true);
    assert.equal((await service.mergeTask('alpha', 't1')).cleanupPending, true);
    assert.equal(store.listMergeReviews('alpha', 't1').length, 1);
    store.close();
  } finally {
    rmSync(foreignWorktree, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('v0.6 post-merge cleanup failure preserves integration references and blocks repair', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-cleanup-failure-'));
  const foreignWorktree = mkdtempSync(join(tmpdir(), 'ai-agent-teams-foreign-wt-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { config, store, service } = setup({ handler: async () => ({ response: JSON.stringify({ verdict: 'needs_revision', evidence: 'repair this' }) }) });
    service.repo = repo;
    service.cwd = repo;
    config.quality.postMergeReview = 'contractor';
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
    store.addTask({ id: 't1', teamId: 'alpha', subject: 'impl', kind: 'work', assignee: 'Engineer 01', status: 'completed' });
    store.updateTask('t1', { mergeCommit: commit, mergeState: 'review_pending', integrationBranch: 'integration-revision', integrationWorktree: foreignWorktree });
    const result = await service.reviewMerge('alpha', 't1');
    const task = store.getTask('t1');
    assert.equal(result.reverted, false);
    assert.equal(result.needsCaptain, true);
    assert.equal(task.mergeState, 'revert_failed');
    assert.equal(task.needsCaptain, true);
    assert.equal(task.integrationWorktree, foreignWorktree);
    assert.equal(task.integrationBranch, 'integration-revision');
    assert.equal(store.listTasks('alpha').some((item) => item.kind === 'repair'), false);
    assert.match(result.rollbackError, /ownership evidence is missing/);
    store.close();
  } finally {
    rmSync(foreignWorktree, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('v0.6 failed post-merge revert needs captain and does not create a repair', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-revert-failure-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { config, store, service } = setup({ handler: async () => ({ response: JSON.stringify({ verdict: 'needs_revision', evidence: 'repair this' }) }) });
    service.repo = repo;
    service.cwd = repo;
    config.quality.postMergeReview = 'contractor';
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
    store.addTask({ id: 't1', teamId: 'alpha', subject: 'impl', kind: 'work', assignee: 'Engineer 01', status: 'completed' });
    store.updateTask('t1', { mergeCommit: 'not-a-commit', mergeState: 'review_pending', integrationWorktree: 'retained-worktree-ref' });
    const result = await service.reviewMerge('alpha', 't1');
    const task = store.getTask('t1');
    assert.equal(result.reverted, false);
    assert.equal(task.mergeState, 'revert_failed');
    assert.equal(task.needsCaptain, true);
    assert.equal(task.integrationWorktree, 'retained-worktree-ref');
    assert.equal(store.listTasks('alpha').some((item) => item.kind === 'repair'), false);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), base);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('P0: a failed dispatch closes its attempt and does not wedge the task', async () => {
  const { store, service, advance } = setup({ handler: async () => { throw new Error('boom'); } });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'a1' });
  await service.tick('alpha');
  const task = store.getTask('t1');
  assert.equal(task.status, 'pending');
  assert.equal(task.reassigning, false);
  assert.equal(task.turnFailureCount, 1);
  assert.equal(task.hold, undefined);
  assert.equal(store.listMembers('alpha')[0].workerSessionStart, undefined);
  const attempts = store.listAttempts('alpha');
  assert.equal(attempts[0].status, 'failed');
  const second = await service.tick('alpha');
  assert.equal(second.dispatched, 0);
  assert.equal(store.getTask('t1').attempt, 1);
  advance(3000);
  await service.tick('alpha');
  assert.equal(store.getTask('t1').attempt, 2);
  assert.equal(store.getTask('t1').attemptId, undefined);
  store.close();
});

test('P0: a terminal task cannot be reopened or spoof merge state', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'a1' });
  await service.tick('alpha');
  const attemptId = store.getTask('t1').attemptId;
  await service.completeTask({
    teamId: 'alpha', taskId: 't1', attemptId,
    update: { status: 'completed', mergeState: 'merged', worktree: '/tmp/spoof', output: 'done' },
  });
  const completed = store.getTask('t1');
  assert.equal(completed.mergeState, undefined);
  assert.equal(completed.worktree, undefined);
  assert.equal(completed.attemptId, undefined);
  await assert.rejects(
    service.completeTask({ teamId: 'alpha', taskId: 't1', attemptId, update: { status: 'in_progress' } }),
    /already terminal/,
  );
  store.close();
});

test('P0: a relicensed member cannot review its own work by changing its name', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const task = store.getTask('t1');
  await service.completeTask({
    teamId: 'alpha', taskId: 't1', attemptId: task.attemptId,
    update: { status: 'completed', acceptanceResults: [{ criterion: 'works', status: 'passed' }], changedPaths: ['src/a.js'] },
  });
  const engineer = store.findMember('alpha', 'a1');
  const rel = await service.relicenseMember('alpha', engineer.id, { label: 'Reviewer 90', roleKey: 'reviewer', reason: 'role change' });
  assert.equal(rel.ok, true);
  service.addTask('alpha', {
    id: 'review', subject: 'review', kind: 'review', assigneeRole: 'reviewer',
    objective: 'review', acceptance: ['quality'], reviewedTaskId: 't1', dependencies: ['t1'],
  }, { internal: true });
  await service.tick('alpha');
  const review = store.getTask('review');
  assert.notEqual(review.assigneeId, engineer.id);
  assert.notEqual(review.assignee, 'Reviewer 90');
  store.close();
});

test('P0: contractor read-only mode keeps the write barrier and may run commands', async () => {
  const { store, service, adapter } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  await service.spawnContractor({ teamId: 'alpha', purpose: 'audit', prompt: 'read only', mode: 'read-only' });
  const create = adapter.calls.find((call) => call.kind === 'create');
  assert.equal(create.input.ephemeral, true);
  // Headless sessions cannot answer a permission prompt: plan mode plus a Bash
  // denylist stalled every review. The write barrier is the tool denylist.
  assert.equal(create.input.mode, 'yolo');
  assert.equal(create.input.mcpMode, 'none');
  assert.ok(create.input.disallowedTools.includes('Edit'));
  assert.ok(create.input.disallowedTools.includes('NotebookEdit'));
  assert.equal(create.input.disallowedTools.includes('Bash'), false);
  assert.ok(create.input.disallowedTools.includes('mcp__agent-teams__agent_teams_create'));
  assert.ok(create.input.disallowedTools.includes('mcp__plugin_ai-agent-teams_agent-teams__agent_teams_create'));
  assert.ok(create.input.disallowedTools.includes('mcp__agent-teams-member__agent_teams_create'));
  store.close();
});

test('worktree base missing blocks dispatch before an attempt is created', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-service-nobase-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    const { config, store, service, adapter } = setup();
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.useWorktrees = true;
    service.repo = repo;
    // Keep task worktrees in the temporary repository, not the project tree.
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    service.addTask('alpha', implementationTask('t1'));
    const result = await service.tick('alpha');
    assert.equal(result.dispatched, 0);
    assert.equal(result.blocked, 'worktree-base-missing');
    // The old path created an attempt and invalidated it after `git worktree`
    // failed. Assert the attempt table stays empty.
    assert.equal(store.listAttempts('alpha').length, 0);
    assert.equal(store.getTask('t1').attemptId, undefined);
    assert.equal(adapter.calls.filter((call) => call.kind === 'create').length, 0);
    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'task.dispatch_failed').length, 0);
    // The audit must name the actual blocker instead of only "not completed".
    const blockedAudit = service.audit('alpha');
    assert.equal(blockedAudit.ok, false);
    assert.ok(blockedAudit.blockers.some((item) => /worktree base main is missing/.test(item)));
    // A second tick inside the backoff window returns the cached failure and
    // must not duplicate the event.
    await service.tick('alpha');
    assert.equal(store.listEvents('alpha').filter((event) => event.type === 'worktree.base_missing').length, 1);
    assert.equal(store.listAttempts('alpha').length, 0);
    // A fresh process has no cache; the persisted event still identifies the blocker.
    service.worktreeBaseState.clear();
    assert.ok(service.audit('alpha').blockers.some((item) => /worktree base main is missing/.test(item)));

    // After the base appears, dispatch resumes without a restart.
    execFileSync('git', ['branch', 'main', 'master'], { cwd: repo });
    const recovered = await service.tick('alpha');
    assert.equal(recovered.dispatched, 1);
    assert.equal(store.listAttempts('alpha').length, 1);
    assert.ok(store.listEvents('alpha').some((event) => event.type === 'worktree.base_recovered'));
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('repeated base failures back off but never exceed 60 seconds', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-service-backoff-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    const { config, store, service, advance } = setup();
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.useWorktrees = true;
    service.repo = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work' });
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await service.worktreeBaseCheck('alpha')).ready, false);
      // No advance after the last failure: its 60s backoff starts at t=241s.
      if (i < 4) advance(60000);
    }
    execFileSync('git', ['branch', 'main', 'master'], { cwd: repo });
    advance(59999);
    assert.equal((await service.worktreeBaseCheck('alpha')).ready, false);
    advance(1);
    assert.equal((await service.worktreeBaseCheck('alpha')).ready, true);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('approve forces a base recheck and dispatches after the base appears', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-service-approve-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    const { config, store, service } = setup();
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    service.useWorktrees = true;
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'staged' });
    // Staged teams reject service.addTask; seed the plan row directly so the
    // approve() path below still has work to dispatch.
    store.addTask({ id: 't1', teamId: 'alpha', subject: 'work', kind: 'work', dependencies: [] });
    // Seed the failure cache, then fix the base without advancing the clock.
    assert.equal((await service.worktreeBaseCheck('alpha')).ready, false);
    execFileSync('git', ['branch', 'main', 'master'], { cwd: repo });
    const approved = await service.approve('alpha');
    assert.equal(approved.ok, true);
    assert.equal(approved.blocked, undefined);
    assert.equal(store.listAttempts('alpha').length, 1);
    assert.equal(store.getTask('t1').status, 'in_progress');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a HEAD base is stored as a commit so changed paths are not empty', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-service-head-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    const { config, store, service } = setup();
    // HEAD is the default base; the old path stored the literal string, so
    // `git diff HEAD...HEAD` inside the task worktree was always empty.
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'HEAD';
    service.useWorktrees = true;
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work' });
    const result = await service.tick('alpha');
    assert.equal(result.dispatched, 1);
    const task = store.getTask('t1');
    assert.match(task.worktreeBase, /^[0-9a-f]{40}$/);
    assert.equal(task.worktreeBase, head);

    writeFileSync(join(task.worktree, 'b.txt'), 'two', 'utf8');
    execFileSync('git', ['add', 'b.txt'], { cwd: task.worktree });
    execFileSync('git', ['commit', '-m', 'work'], { cwd: task.worktree });
    const changed = await deriveChangedPaths({ worktree: task.worktree, baseRef: task.worktreeBase });
    assert.deepEqual(changed, ['b.txt']);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a blocked worktree team does not hold dynamic slots from a healthy team', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-service-slot-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    const { config, store, service } = setup();
    config.scheduler.dynamicTeams = true;
    config.scheduler.activeWorkerSlots = 6;
    config.scheduler.maxActivePerTeam = 6;
    config.teams.find((team) => team.id === 'alpha').baseBranch = 'main';
    config.teams.find((team) => team.id === 'beta').baseBranch = 'master';
    service.useWorktrees = true;
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
    for (let i = 0; i < 5; i += 1) service.addTask('alpha', { id: `a${i}`, subject: `a${i}`, kind: 'work' });
    for (let i = 0; i < 6; i += 1) service.addTask('beta', { id: `b${i}`, subject: `b${i}`, kind: 'work' });
    const results = await service.tickAll();
    const alpha = results.find((item) => item.teamId === 'alpha');
    const beta = results.find((item) => item.teamId === 'beta');
    assert.equal(alpha.dispatched, 0);
    assert.equal(alpha.blocked, 'worktree-base-missing');
    // All six slots go to the healthy team; nothing is stranded on the blocked one.
    assert.equal(beta.dispatched, 6);
    assert.equal(store.listAttempts('alpha').length, 0);
    assert.equal(store.listAttempts('beta').length, 6);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('P0: a worktree task is not settled or audited before merge', () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'a1' }] });
  store.addTask({
    id: 'impl', teamId: 'alpha', subject: 'impl', kind: 'implementation', status: 'completed',
    assignee: 'a1', dependencies: [], objective: 'x', acceptance: ['works'], inScope: ['src/'],
    verify: ['node -e "process.exit(0)"'], changedPaths: ['src/a.js'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'x', status: 'passed' }],
    worktree: '/tmp/not-merged', mergeState: 'pending',
  });
  assert.equal(service.audit('alpha').ok, false);
  assert.equal(service.settlementStatus('alpha', store.findMember('alpha', 'a1').id).settled, false);
  store.close();
});

test('P0: soft isolation self-test verifies mode, homes, tokens and read-only policy', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-soft-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    const { store, service, adapter, config } = setup();
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    service.addTask('alpha', implementationTask('t1'));
    service.addTask('alpha', {
      id: 'review', subject: 'review', kind: 'review', assigneeRole: 'reviewer',
      objective: 'review', acceptance: ['quality'], reviewedTaskId: 't1', dependencies: ['t1'],
    }, { internal: true });
    await service.tick('alpha');
    const report = service.softIsolationReport('alpha');
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.ok(report.checks.some((check) => check.name.startsWith('home:')));
    assert.ok(report.checks.some((check) => check.name.startsWith('token:')));
    const create = adapter.calls.find((call) => call.kind === 'create' && call.input.memberName === 'Engineer 01');
    // Headless members run in isolation.workerMode (default yolo) instead of
    // the interactive zcode.mode, so the assertion follows the effective
    // config rather than a hard-coded mode.
    assert.equal(create.input.mode, config.isolation?.workerMode ?? config.zcode.mode);
    assert.ok(create.input.disallowedTools.includes('mcp__plugin_ai-agent-teams_agent-teams__agent_teams_create'));
    assert.ok(!create.input.disallowedTools.includes('mcp__agent-teams-member__agent_teams_create'));
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('P0: reviewer sessions are launched read-only at the adapter layer', async () => {
  const { store, service, adapter } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask({
    id: 'impl', teamId: 'alpha', subject: 'impl', kind: 'implementation', status: 'completed',
    assignee: undefined, assigneeRole: 'engineer', dependencies: [], objective: 'x', acceptance: ['works'],
    inScope: ['src/'], verify: ['node -e "process.exit(0)"'], changedPaths: ['src/a.js'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'x', status: 'passed' }],
  });
  service.addTask('alpha', {
    id: 'review', subject: 'review', kind: 'review', assigneeRole: 'reviewer',
    objective: 'review', acceptance: ['quality'], reviewedTaskId: 'impl', dependencies: ['impl'],
  }, { internal: true });
  await service.tick('alpha');
  const create = adapter.calls.find((call) => call.kind === 'create' && call.input.memberName === 'Reviewer 01');
  assert.ok(create);
  assert.equal(create.input.mode, 'plan');
  assert.ok(create.input.disallowedTools.includes('Edit'));
  assert.ok(create.input.disallowedTools.includes('Bash'));
  store.close();
});

async function waitUntil(predicate, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('v0.6 contractor slots keep merge and main reservations independent', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, service } = setup({
    handler: async () => {
      await gate;
      return { response: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });

  const mergeOne = await service.submitContractor({
    teamId: 'alpha', purpose: 'post_merge_review:t1', prompt: 'merge review one',
  });
  const mergeTwo = await service.submitContractor({
    teamId: 'alpha', purpose: 'post_merge_review:t2', prompt: 'merge review two',
  });
  const mainOne = await service.submitContractor({
    teamId: 'alpha', purpose: 'research', prompt: 'main research',
  });

  assert.equal(mergeOne.slot, 'merge');
  assert.equal(mergeTwo.slot, 'merge');
  assert.equal(mainOne.slot, 'main');
  assert.equal(await waitUntil(() => service.activeContractors('merge').length === 1), true);
  assert.equal(await waitUntil(() => service.activeContractors('main').length === 1), true);

  let pools = service.contractorPools('alpha');
  const mergePool = pools.find((item) => item.slot === 'merge');
  const mainPool = pools.find((item) => item.slot === 'main');
  assert.equal(mergePool.active, 1);
  assert.equal(mergePool.queued, 1);
  assert.equal(mainPool.active, 1);
  assert.equal(mainPool.queued, 0);

  release();
  assert.equal(await waitUntil(() => store.listContractors('alpha').every((item) => item.status === 'completed')), true);
  pools = service.contractorPools('alpha');
  assert.equal(pools.find((item) => item.slot === 'merge').active, 0);
  assert.equal(pools.find((item) => item.slot === 'merge').queued, 0);
  assert.equal(store.listContractors('alpha', 'completed', 'merge').length, 2);
  assert.equal(store.listContractors('alpha', 'completed', 'main').length, 1);

  await assert.rejects(
    () => service.submitContractor({ teamId: 'alpha', slot: 'merge', purpose: 'research', prompt: 'wrong slot' }),
    /only accepts merge review/
  );
  await assert.rejects(
    () => service.submitContractor({ teamId: 'alpha', slot: 'main', purpose: 'post_merge_review:t3', prompt: 'wrong slot' }),
    /must use the merge contractor slot/
  );
  store.close();
});

test('v0.6 killing a main contractor releases only the main slot and starts its queue', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, service } = setup({
    handler: async () => {
      await gate;
      return { response: 'ok' };
    },
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const first = await service.submitContractor({ teamId: 'alpha', purpose: 'research', prompt: 'first' });
  const second = await service.submitContractor({ teamId: 'alpha', purpose: 'review', prompt: 'second' });
  assert.equal(await waitUntil(() => service.activeContractors('main').length === 1), true);
  assert.equal(service.contractorPools('alpha').find((item) => item.slot === 'main').queued, 1);

  await service.killContractor('alpha', first.id);
  assert.equal(await waitUntil(() => service.activeContractors('main').length === 1), true);
  release();
  assert.equal(await waitUntil(() => store.getContractor(second.id).status === 'completed'), true);
  assert.equal(store.getContractor(first.id).status, 'killed');
  assert.equal(store.listContractors('alpha', 'completed', 'merge').length, 0);
  store.close();
});

test('v0.6 main-slot saturation does not borrow or starve the merge slot', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, service } = setup({
    handler: async () => {
      await gate;
      return { response: 'ok' };
    },
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const mainOne = await service.submitContractor({ teamId: 'alpha', purpose: 'research', prompt: 'main one' });
  const mainTwo = await service.submitContractor({ teamId: 'alpha', purpose: 'review', prompt: 'main two' });
  assert.equal(await waitUntil(() => service.activeContractors('main').length === 1), true);
  let pools = service.contractorPools('alpha');
  assert.equal(pools.find((item) => item.slot === 'main').queued, 1);
  assert.equal(pools.find((item) => item.slot === 'merge').active, 0);

  const mergeOne = await service.submitContractor({ teamId: 'alpha', purpose: 'post_merge_review:t1', prompt: 'merge review' });
  assert.equal(mergeOne.slot, 'merge');
  assert.equal(await waitUntil(() => service.activeContractors('merge').length === 1), true);
  pools = service.contractorPools('alpha');
  assert.equal(pools.find((item) => item.slot === 'merge').active, 1);
  assert.equal(pools.find((item) => item.slot === 'main').queued, 1);

  await service.killContractor('alpha', mainOne.id);
  release();
  assert.equal(await waitUntil(() => store.getContractor(mainTwo.id).status === 'completed'), true);
  assert.equal(await waitUntil(() => store.getContractor(mergeOne.id).status === 'completed'), true);
  assert.equal(store.listContractors('alpha', 'completed', 'merge').length, 1);
  store.close();
});

test('v0.6 contractor slots are global across both teams', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter({ handler: async () => { await gate; return { response: 'ok' }; } });
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter, config, cwd: process.cwd(), now: () => 1000,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });

  const alphaMerge = await service.submitContractor({ teamId: 'alpha', purpose: 'post_merge_review:t1', prompt: 'alpha merge' });
  const betaMerge = await service.submitContractor({ teamId: 'beta', purpose: 'post_merge_review:b1', prompt: 'beta merge' });
  const alphaMain = await service.submitContractor({ teamId: 'alpha', purpose: 'research', prompt: 'alpha research' });
  const betaMain = await service.submitContractor({ teamId: 'beta', purpose: 'research', prompt: 'beta research' });

  assert.equal(await waitUntil(() => service.activeContractors('merge').length === 1), true);
  assert.equal(await waitUntil(() => service.activeContractors('main').length === 1), true);
  assert.equal(service.activeContractors().length, 2);
  assert.equal(service.contractorPools().find((item) => item.slot === 'merge').queued, 1);
  assert.equal(service.contractorPools().find((item) => item.slot === 'main').queued, 1);

  release();
  assert.equal(await waitUntil(() => store.listAllContractors().every((item) => item.status === 'completed')), true);
  assert.equal(store.listAllContractors('completed', 'merge').length, 2);
  assert.equal(store.listAllContractors('completed', 'main').length, 2);
  assert.equal(alphaMerge.slot, 'merge');
  assert.equal(betaMerge.slot, 'merge');
  assert.equal(alphaMain.slot, 'main');
  assert.equal(betaMain.slot, 'main');
  store.close();
});

test('v0.6 kill during session creation never sends the prompt or frees the slot early', async () => {
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  class SlowCreateAdapter extends FakeSessionAdapter {
    async create(input) {
      await createGate;
      return super.create(input);
    }
  }
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const adapter = new SlowCreateAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter, config, cwd: process.cwd(), now: () => 1000,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const first = await service.submitContractor({ teamId: 'alpha', purpose: 'research', prompt: 'first' });
  assert.equal(await waitUntil(() => store.getContractor(first.id).status === 'running'), true);

  const killed = await service.killContractor('alpha', first.id);
  assert.equal(killed.status, 'cancelling');
  assert.equal(service.activeContractors('main').length, 1);
  const second = await service.submitContractor({ teamId: 'alpha', purpose: 'research', prompt: 'second' });
  assert.equal(service.contractorPools().find((item) => item.slot === 'main').queued, 1);

  releaseCreate();
  assert.equal(await waitUntil(() => store.getContractor(first.id).status === 'killed'), true);
  assert.equal(await waitUntil(() => store.getContractor(second.id).status === 'completed'), true);
  assert.equal(adapter.calls.some((call) => call.kind === 'send' && call.input.sessionId === `sess_fake_1`), false);
  assert.equal(store.listAllContractors('completed', 'main').length, 1);
  store.close();
});

test('startup reconciliation retains an unverified contractor and does not pump its slot', async () => {
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter, config, cwd: process.cwd(), now: () => 1000,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addContractor({
    id: 'ctr_stale', teamId: 'alpha', slot: 'main', purpose: 'research', mode: 'read-only',
    prompt: 'stale', status: 'running', sessionId: 'sess_stale', timeoutMs: 1000,
  });
  const queued = await service.submitContractor({ teamId: 'alpha', purpose: 'research', prompt: 'queued' });
  const result = await service.reconcileContractors();
  assert.equal(result.orphaned, 0);
  assert.equal(result.held, 1);
  assert.equal(store.getContractor('ctr_stale').status, 'cleanup_error');
  assert.equal(store.getContractor('ctr_stale').sessionId, 'sess_stale');
  assert.equal(store.getContractor(queued.id).status, 'queued');
  assert.equal(adapter.calls.some((call) => call.kind === 'stop' && call.input.sessionId === 'sess_stale'), true);
  store.close();
});

test('v0.6 patrol defers when contractors are disabled or the main slot is restricted', async () => {
  const { config, store, service } = setup();
  config.features.contractors = false;
  config.contractors.enabled = false;
  config.patrol.whenCaptainBusy = 'one-shot-contractor';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
  service.addTask('alpha', { id: 't1', subject: 'work', kind: 'work', assignee: 'Engineer 01' });
  await service.tick('alpha');
  store.updateTeam('alpha', { captainBusy: true });
  const result = await service.patrol('alpha');
  assert.equal(result.ran, false);
  assert.match(result.reason, /contractor-slot-unavailable/);
  assert.equal(store.listContractors('alpha').length, 0);
  // A deferred patrol must not consume the interval; the next tick can retry.
  assert.equal(store.getTeam('alpha').lastPatrolAt ?? 0, 0);
  assert.equal(service.patrolLastAt.has('alpha'), false);
  store.close();
});

test('v0.6 post-merge review falls back safely when the merge slot purpose is restricted', async () => {
  const { config, store, service } = setup({
    handler: async () => ({ response: JSON.stringify({ verdict: 'pass', evidence: 'tests passed' }) }),
  });
  config.quality.postMergeReview = 'contractor';
  config.contractors.slots.merge.kinds = ['merge_verify'];
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
  store.addTask({ id: 't1', teamId: 'alpha', subject: 'impl', kind: 'work', assignee: 'Engineer 01', status: 'completed' });
  store.updateTask('t1', { mergeCommit: 'deadbeef', mergeState: 'review_pending' });
  const result = await service.reviewMerge('alpha', 't1');
  assert.equal(result.verdict, 'internal');
  assert.equal(store.getTask('t1').mergeState, 'review_pending_internal');
  store.close();
});

test('v0.6 a failed session cleanup keeps the slot blocked until an explicit kill releases it', async () => {
  class BadStopAdapter extends FakeSessionAdapter {
    constructor() {
      super();
      this.stopCalls = 0;
    }

    async stop(input) {
      this.stopCalls += 1;
      // The first run and the kill retry fail; the queued contractor's
      // cleanup succeeds so slot reuse is observable.
      if (this.stopCalls <= 2) throw new Error('stop failed');
      return super.stop(input);
    }
  }
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const adapter = new BadStopAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter, config, cwd: process.cwd(), now: () => 1000,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const first = await service.submitContractor({ teamId: 'alpha', purpose: 'research', prompt: 'first' });
  assert.equal(await waitUntil(() => store.getContractor(first.id).status === 'cleanup_error'), true);
  assert.equal(store.getContractor(first.id).cleanupError, 'stop failed');
  assert.equal(service.activeContractors('main').length, 1);
  const second = await service.submitContractor({ teamId: 'alpha', purpose: 'research', prompt: 'second' });
  assert.equal(service.contractorPools().find((item) => item.slot === 'main').queued, 1);
  // An explicit kill is the operator's audited reconciliation when the
  // adapter still cannot prove termination.
  const released = await service.killContractor('alpha', first.id);
  assert.equal(released.status, 'orphaned');
  assert.equal(released.releaseReason, 'kill after unproven cleanup');
  assert.equal(await waitUntil(() => store.getContractor(second.id).status === 'completed'), true,
    'the released slot must let the queued contractor run');
  store.close();
});

test('reconciliation retains legacy orphaned rows when session termination cannot be proven', async () => {
  const { config } = loadConfig('config/example.v06.json');
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  const service = new TeamService({ homeRoot: testHomeRoot(),
    store, adapter, config, cwd: process.cwd(), now: () => 1000,
    memoryUsage: () => ({ rssBytes: 1, budgetBytes: 100 }),
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addContractor({
    id: 'ctr_legacy', teamId: 'alpha', slot: 'main', purpose: 'research', mode: 'read-only',
    prompt: 'legacy', status: 'orphaned', sessionId: 'sess_legacy', timeoutMs: 1000,
  });
  const result = await service.reconcileContractors();
  assert.equal(result.orphaned, 0);
  assert.equal(result.held, 1);
  assert.equal(store.getContractor('ctr_legacy').sessionId, 'sess_legacy');
  assert.equal(store.getContractor('ctr_legacy').status, 'cleanup_error');
  assert.equal(adapter.calls.some((call) => call.kind === 'stop' && call.input.sessionId === 'sess_legacy'), true);
  store.close();
});

test('v0.6 cross-team mail is invisible until captain approval and works both ways', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  const aToB = service.sendMessage('alpha', 'a1', 'captain', 'alpha progress', { toTeam: 'beta' });
  assert.equal(aToB.teamId, 'beta');
  assert.equal(aToB.fromTeamId, 'alpha');
  assert.equal(aToB.approvalState, 'pending_captain');
  assert.equal(service.listPendingMessages().length, 1);
  assert.equal(store.listMessages('beta').filter((message) => message.approvalState === 'pending_captain').length, 1);

  const approved = service.approveMessage(aToB.id, 'captain');
  assert.equal(approved.approvalState, 'approved');
  assert.equal(service.listPendingMessages().length, 0);

  const bToA = service.sendMessage('beta', 'b1', 'captain', 'beta progress', { toTeam: 'alpha' });
  assert.equal(bToA.approvalState, 'pending_captain');
  const rejected = service.rejectMessage(bToA.id, 'captain', 'not needed');
  assert.equal(rejected.approvalState, 'rejected');
  assert.equal(service.listPendingMessages().length, 0);
  assert.equal(store.getMessage(bToA.id).rejectedBy, 'captain');
  store.close();
});

test('v0.6 full-access mode auto-approves cross-team mail', async () => {
  const { config, store, service } = setup();
  config.automation.mode = 'full-access';
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  const message = service.sendMessage('alpha', 'a1', 'captain', 'auto', { toTeam: 'beta' });
  assert.equal(message.approvalState, 'approved');
  assert.equal(message.approvedBy, 'full-access');
  assert.equal(service.listPendingMessages().length, 0);
  store.close();
});

test('v0.6 dynamic tickAll plans both teams together instead of starving one', async () => {
  const { config, store, service } = setup();
  config.scheduler.dynamicTeams = true;
  config.scheduler.activeWorkerSlots = 6;
  config.scheduler.maxActivePerTeam = 3;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  for (let i = 0; i < 10; i += 1) service.addTask('alpha', { id: `a${i}`, subject: `a${i}`, kind: 'work' });
  for (let i = 0; i < 2; i += 1) service.addTask('beta', { id: `b${i}`, subject: `b${i}`, kind: 'work' });
  const results = await service.tickAll();
  const alpha = results.find((item) => item.teamId === 'alpha');
  const beta = results.find((item) => item.teamId === 'beta');
  assert.equal(alpha.dispatched + beta.dispatched, 6);
  assert.ok(beta.dispatched >= 1);
  assert.ok(alpha.dispatched >= beta.dispatched);
  assert.equal(store.listTasks('beta').filter((task) => task.status === 'in_progress').length, beta.dispatched);
  store.close();
});

test('v0.6 pending cross-team mail is not exposed through the target-team event stream', async () => {
  const { store, service } = setup();
  const events = [];
  const unsubscribe = store.subscribe((event) => events.push(event));
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running' });
  service.sendMessage('alpha', 'a1', 'captain', 'secret progress', { toTeam: 'beta' });
  unsubscribe();
  const targetEvent = events.find((event) => event.teamId === 'beta' && event.type === 'message.cross_team_pending');
  assert.ok(targetEvent);
  assert.equal(targetEvent.data.content, undefined);
  assert.equal(targetEvent.data.from, undefined);
  assert.equal(targetEvent.data.approvalState, 'pending_captain');
  assert.equal(events.some((event) => event.teamId === 'beta' && event.data?.content === 'secret progress'), false);
  store.close();
});

test('v0.6 dynamic allocation treats same-named members in different teams independently', async () => {
  const { config, store, service } = setup();
  config.scheduler.dynamicTeams = true;
  config.scheduler.activeWorkerSlots = 4;
  config.scheduler.maxActivePerTeam = 2;
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running', members: [{ name: 'Engineer 01' }] });
  service.createTeam({ id: 'beta', name: 'Beta', phase: 'running', members: [{ name: 'Engineer 01' }] });
  for (let i = 0; i < 3; i += 1) service.addTask('alpha', { id: `a${i}`, subject: `a${i}`, kind: 'work', assignee: 'Engineer 01' });
  for (let i = 0; i < 2; i += 1) service.addTask('beta', { id: `b${i}`, subject: `b${i}`, kind: 'work', assignee: 'Engineer 01' });
  const results = await service.tickAll();
  const alpha = results.find((item) => item.teamId === 'alpha');
  const beta = results.find((item) => item.teamId === 'beta');
  assert.ok(alpha.dispatched >= 1);
  assert.ok(beta.dispatched >= 1);
  assert.equal(store.listTasks('alpha').filter((task) => task.status === 'in_progress').length, alpha.dispatched);
  assert.equal(store.listTasks('beta').filter((task) => task.status === 'in_progress').length, beta.dispatched);
  store.close();
});

test('v0.6 same-process provider failure continues the same task and session', async () => {
  const { store, service, adapter, advance, now } = setup();
  // This test pins the turn-retry layer only; the red-box review that continues
  // a failed task lives in test/red-auto-review.test.mjs.
  service.redReview.enabled = false;
  adapter.turnCursor = async () => 0;
  const watchers = [];
  adapter.watchTurn = (input) => {
    watchers.push(input);
    return { cancel() {} };
  };
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  assert.equal(watchers.length, 1);
  const initial = store.getTask('t1');
  assert.ok(initial.attemptId);
  assert.equal(store.listMembers('alpha')[0].status, 'working');

  for (let failure = 1; failure <= 4; failure += 1) {
    const previousAttemptId = store.getTask('t1').attemptId;
    watchers.at(-1).onFailed({ message: 'task execution failed' });
    const task = store.getTask('t1');
    assert.equal(task.turnFailureCount, failure);
    assert.equal(task.subject, 't1');
    assert.equal(store.listTasks('alpha').length, 1);
    if (failure < 4) {
      assert.equal(task.status, 'in_progress');
      assert.ok(task.attemptId);
      assert.notEqual(task.attemptId, previousAttemptId);
      assert.equal(task.attempt, failure + 1);
      assert.ok(task.retryNotBefore > now());
      advance(task.retryNotBefore - now());
      await service.tick('alpha');
      assert.equal(watchers.length, failure + 1);
      assert.equal(adapter.calls.filter((call) => call.kind === 'send'
        && call.input.message.startsWith('继续')).length, failure);
    } else {
      assert.equal(task.status, 'failed');
      assert.equal(task.attemptId, undefined);
      assert.match(task.error, /task execution failed/);
      assert.equal(task.lastSessionId, store.listMembers('alpha')[0].sessionId);
    }
  }
  store.close();
});

test('v0.6 capacity failures release a worker slot and use the larger capacity retry budget', async () => {
  const { store, service, adapter, advance, now } = setup();
  adapter.turnCursor = async () => 0;
  const watchers = [];
  adapter.watchTurn = (input) => {
    watchers.push(input);
    return { cancel() {} };
  };
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const before = service.config.scheduler.activeWorkerSlots;

  for (let failure = 1; failure <= 4; failure += 1) {
    watchers.at(-1).onFailed(failure % 2 === 0
      ? { message: 'group requests-per-minute limit exceeded' }
      : { message: 'provider business error', code: 'rate_limit_exceeded', type: 'provider_error' });
    const task = store.getTask('t1');
    assert.equal(task.turnFailureCount, failure);
    assert.ok(service.config.scheduler.activeWorkerSlots < before);
    if (failure < 4) {
      assert.equal(task.status, 'in_progress');
      assert.ok(task.attemptId);
      assert.ok(task.retryNotBefore > now());
      advance(task.retryNotBefore - now());
      await service.tick('alpha');
      assert.equal(adapter.calls.filter((call) => call.kind === 'send'
        && call.input.message.startsWith('继续')).length, failure);
    } else {
      assert.equal(task.status, 'failed');
    }
  }
  assert.equal(store.getTask('t1').status, 'failed');
  assert.equal(store.getTask('t1').turnFailureCount, 4);
  const finalAttempt = store.listAttempts('alpha').at(-1);
  assert.equal(finalAttempt.status, 'failed');
  assert.ok(finalAttempt.endedAt);
  assert.equal(store.listMembers('alpha')[0].status, 'idle');
  store.close();
});

test('v0.6 honors a provider retryAfterMs when scheduling the next attempt', async () => {
  const { store, service, adapter, now } = setup();
  adapter.turnCursor = async () => 0;
  const watchers = [];
  adapter.watchTurn = (input) => {
    watchers.push(input);
    return { cancel() {} };
  };
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  watchers.at(-1).onFailed({ message: 'task execution failed', retryAfterMs: 45000 });
  const task = store.getTask('t1');
  assert.equal(task.status, 'in_progress');
  assert.ok(task.attemptId);
  assert.equal(task.retryNotBefore, now() + 45000);
  const scheduled = store.listEvents('alpha').find((event) => event.type === 'task.continue_scheduled');
  assert.equal(scheduled.retryAfterMs, 45000);
  const failed = store.listEvents('alpha').find((event) => event.type === 'task.turn_failed');
  assert.equal(failed.retryAfterMs, 45000);
  assert.equal(failed.retryInMs, 45000);
  store.close();
});

test('v0.6 persists reduced capacity and recovers one slot after sustained successes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-teams-capacity-'));
  const statePath = join(dir, 'runtime-capacity.json');
  try {
    const first = setup({ capacityStatePath: statePath });
    first.adapter.turnCursor = async () => 0;
    const watchers = [];
    first.adapter.watchTurn = (input) => {
      watchers.push(input);
      return { cancel() {} };
    };
    first.service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    first.service.addTask('alpha', implementationTask('t1'));
    await first.service.tick('alpha');
    watchers.at(-1).onFailed({ message: 'provider business error', code: 'rate_limit_exceeded' });
    assert.equal(first.service.config.scheduler.activeWorkerSlots, 5);
    assert.equal(first.service.config.scheduler.maxActivePerTeam, 5);
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(persisted.activeWorkerSlots, 5);
    assert.equal(persisted.configuredWorkerSlots, 6);
    first.service.close();
    first.store.close();

    const second = setup({ capacityStatePath: statePath, startClock: 200000 });
    assert.equal(second.config.scheduler.activeWorkerSlots, 5);
    assert.equal(second.config.scheduler.maxActivePerTeam, 5);
    second.service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    second.service.recordTurnSuccess('alpha');
    second.service.recordTurnSuccess('alpha');
    assert.equal(second.config.scheduler.activeWorkerSlots, 5);
    second.service.recordTurnSuccess('alpha');
    assert.equal(second.config.scheduler.activeWorkerSlots, 6);
    assert.equal(second.config.scheduler.maxActivePerTeam, 6);
    assert.ok(second.store.listEvents('alpha').some((event) => event.type === 'concurrency.recovered'));
    const recovered = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(recovered.activeWorkerSlots, 6);
    assert.equal(recovered.successes, 0);
    second.service.close();
    second.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.6 does not raise capacity during the recovery cooldown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-teams-capacity-'));
  const statePath = join(dir, 'runtime-capacity.json');
  try {
    const { store, service, adapter, advance } = setup({ capacityStatePath: statePath });
    adapter.turnCursor = async () => 0;
    const watchers = [];
    adapter.watchTurn = (input) => {
      watchers.push(input);
      return { cancel() {} };
    };
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    for (let index = 1; index <= 5; index += 1) {
      service.addTask('alpha', implementationTask(`t${index}`));
    }
    await service.tick('alpha');
    assert.equal(watchers.length, 5);
    watchers[0].onFailed({ message: 'group requests-per-minute limit exceeded' });
    assert.equal(service.config.scheduler.activeWorkerSlots, 5);
    watchers[1].onCompleted();
    assert.equal(service.capacitySuccesses, 0);
    assert.equal(service.config.scheduler.activeWorkerSlots, 5);
    advance(60000);
    watchers[2].onCompleted();
    watchers[3].onCompleted();
    assert.equal(service.config.scheduler.activeWorkerSlots, 5);
    watchers[4].onCompleted();
    assert.equal(service.config.scheduler.activeWorkerSlots, 6);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.6 honors a zero capacity recovery cooldown', async () => {
  const { store, service, adapter } = setup({
    patch: (config) => { config.zcode.turnFailureRetry.capacityRecoveryMs = 0; },
  });
  assert.equal(service.capacityRecoveryMs, 0);
  adapter.turnCursor = async () => 0;
  const watchers = [];
  adapter.watchTurn = (input) => {
    watchers.push(input);
    return { cancel() {} };
  };
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  for (let index = 1; index <= 4; index += 1) {
    service.addTask('alpha', implementationTask(`t${index}`));
  }
  await service.tick('alpha');
  watchers[0].onFailed({ message: 'group requests-per-minute limit exceeded' });
  assert.equal(service.config.scheduler.activeWorkerSlots, 5);
  watchers[1].onCompleted();
  watchers[2].onCompleted();
  assert.equal(service.config.scheduler.activeWorkerSlots, 5);
  watchers[3].onCompleted();
  assert.equal(service.config.scheduler.activeWorkerSlots, 6);
  store.close();
});

test('v0.6 ignores corrupt, out-of-range, and configuration-mismatched capacity state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-teams-capacity-'));
  const statePath = join(dir, 'runtime-capacity.json');
  try {
    writeFileSync(statePath, '{"version":1,"activeWorkerSlots":99,"configuredWorkerSlots":6}', 'utf8');
    const high = setup({ capacityStatePath: statePath });
    assert.equal(high.config.scheduler.activeWorkerSlots, 6);
    high.store.close();

    writeFileSync(statePath, 'not json', 'utf8');
    const corrupt = setup({ capacityStatePath: statePath });
    assert.equal(corrupt.config.scheduler.activeWorkerSlots, 6);
    corrupt.store.close();

    writeFileSync(statePath, JSON.stringify({
      version: 1,
      activeWorkerSlots: 3,
      configuredWorkerSlots: 8,
      successes: 1e9,
      nextRecoveryAt: 9e15,
    }), 'utf8');
    const mismatch = setup({ capacityStatePath: statePath, startClock: 1000 });
    assert.equal(mismatch.config.scheduler.activeWorkerSlots, 6);
    assert.equal(mismatch.service.capacitySuccesses, 0);
    mismatch.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.6 clamps untrusted success and recovery fields from a valid state file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-teams-capacity-'));
  const statePath = join(dir, 'runtime-capacity.json');
  try {
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      activeWorkerSlots: 5,
      configuredWorkerSlots: 6,
      successes: 1e9,
      nextRecoveryAt: 9e15,
      reducedAt: 500,
    }), 'utf8');
    const { store, service, adapter, now } = setup({ capacityStatePath: statePath, startClock: 1000 });
    assert.equal(service.config.scheduler.activeWorkerSlots, 5);
    assert.equal(service.capacitySuccesses, 2);
    assert.equal(service.capacityNextRecoveryAt, now() + 60000);
    adapter.turnCursor = async () => 0;
    const watchers = [];
    adapter.watchTurn = (input) => {
      watchers.push(input);
      return { cancel() {} };
    };
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    service.addTask('alpha', implementationTask('t1'));
    await service.tick('alpha');
    watchers[0].onCompleted();
    assert.equal(service.config.scheduler.activeWorkerSlots, 5);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v0.6 dispatch errors consume the retry budget and honor retryAfterMs', async () => {
  const { store, service, adapter, now } = setup();
  const error = new Error('group requests-per-minute limit exceeded');
  error.retryAfterMs = 120000;
  adapter.send = async () => { throw error; };
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const task = store.getTask('t1');
  assert.equal(task.status, 'pending');
  assert.equal(task.turnFailureCount, 1);
  assert.equal(task.retryNotBefore, now() + 120000);
  assert.equal(service.config.scheduler.activeWorkerSlots, 5);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'task.dispatch_failed' && event.retryAfterMs === 120000));
  const sends = adapter.calls.filter((call) => call.kind === 'send').length;
  await service.tick('alpha');
  assert.equal(adapter.calls.filter((call) => call.kind === 'send').length, sends);
  store.close();
});

test('v0.6 retries a transient session/events cursor failure without failing the task', async () => {
  const { store, service, adapter } = setup();
  let calls = 0;
  adapter.turnCursor = async () => {
    calls += 1;
    if (calls <= 3) throw new Error('session/events temporarily unavailable');
    return 0;
  };
  const watchers = [];
  adapter.watchTurn = (input) => {
    watchers.push(input);
    return { cancel() {} };
  };
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const task = store.getTask('t1');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.turnFailureCount, undefined);
  assert.equal(calls, 4);
  assert.equal(watchers.length, 1);
  assert.equal(store.listEvents('alpha').filter((event) => event.type === 'task.turn_watch_unavailable').length, 0);
  store.close();
});

test('v0.6 resets a dead member session so the next attempt creates a fresh one', async () => {
  const { store, service, adapter, advance } = setup();
  let sends = 0;
  adapter.send = async ({ sessionId }) => {
    sends += 1;
    if (sends === 1) throw new Error(`Session is not active: ${sessionId}`);
    return { ok: true, response: 'ok' };
  };
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const dead = store.listMembers('alpha')[0];
  assert.equal(dead.sessionId, undefined);
  assert.equal(dead.residency, 'cold');
  assert.equal(store.getMemberToken(dead.id), undefined);
  assert.ok(store.listEvents('alpha').some((event) => event.type === 'member.session_reset'));
  advance(3000);
  await service.tick('alpha');
  assert.equal(adapter.calls.filter((call) => call.kind === 'create').length, 2);
  assert.ok(store.getMemberToken(dead.id));
  assert.equal(store.getTask('t1').status, 'in_progress');
  store.close();
});

test('v0.6 classifies capacity errors by structured fields before loose keywords', () => {
  assert.equal(isCapacityError({ message: 'group requests-per-minute limit exceeded' }), true);
  assert.equal(isCapacityError({ message: 'anything', code: 'rate_limit_exceeded' }), true);
  assert.equal(isCapacityError({ message: 'too many requests' }), true);
  assert.equal(isCapacityError({ message: 'capacity exceeded' }), true);
  assert.equal(isCapacityError({ message: 'whatever', retryAfterMs: 5000 }), true);
  assert.equal(isCapacityError({ message: 'disk capacity exceeded', code: 'E_INVALID' }), false);
  assert.equal(isCapacityError({ message: 'storage capacity exceeded' }), false);
  assert.equal(isCapacityError({ message: 'x', code: 'insufficient_quota' }), false);
  assert.equal(isCapacityError({ message: 'insufficient_quota: hard quota exhausted' }), false);
  assert.equal(isCapacityError({ message: 'x', code: 'exceeded_current_quota_error' }), false);
  assert.equal(isCapacityError({ message: 'You exceeded your current quota' }), false);
  assert.equal(isCapacityError({ message: 'x', code: '2056' }), false);
  assert.equal(isCapacityError({ message: 'x', code: 429 }), true);
  assert.equal(isCapacityError({ message: 'x', code: 'rateLimitExceeded' }), true);
  assert.equal(isCapacityError({ message: '429 too many requests: 1316 pending' }), true);
  assert.equal(isCapacityError({ message: '429 rate limit for billing account' }), true);
  assert.equal(isCapacityError({ message: '1316 requests pending; rate limit exceeded' }), true);
  assert.equal(isCapacityError({ message: 'requests per minute exceeded, 1316 queued' }), true);
  assert.equal(isCapacityError({ message: 'EMFILE: too many open files' }), false);
  assert.equal(isCapacityError({ message: 'provider business error', code: 'provider_error' }), false);
  assert.equal(isCapacityError({ message: 'x', retryable: false }), false);
});

test('v0.6 preserves structured send failures from the adapter', async () => {
  const { store, service, adapter, now } = setup();
  adapter.send = async () => ({
    ok: false,
    warning: 'CLI provider error: too many requests',
    error: { message: 'too many requests', code: '429', retryAfterSeconds: 30 },
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const task = store.getTask('t1');
  assert.equal(task.status, 'pending');
  assert.equal(task.turnFailureCount, 1);
  assert.equal(task.retryNotBefore, now() + 30000);
  assert.equal(service.config.scheduler.activeWorkerSlots, 5);
  store.close();
});

test('v0.6 non-retryable provider error fails without consuming capacity retries', async () => {
  const { store, service, adapter } = setup();
  adapter.turnCursor = async () => 0;
  const watchers = [];
  adapter.watchTurn = (input) => {
    watchers.push(input);
    return { cancel() {} };
  };
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  watchers.at(-1).onFailed({
    message: 'provider rejected the request',
    code: 'invalid_request',
    type: 'provider_error',
    retryable: false,
  });
  const task = store.getTask('t1');
  assert.equal(task.status, 'failed');
  assert.equal(task.turnFailureCount, 1);
  store.close();
});

test('P0: stale completion cannot overwrite a reassignment during verify', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', {
    ...implementationTask('t1'),
    verify: ['node -e "setTimeout(()=>{},120)"'],
  });
  await service.tick('alpha');
  const dispatched = store.getTask('t1');
  const completion = service.completeTask({
    teamId: 'alpha', taskId: 't1', attemptId: dispatched.attemptId,
    update: { status: 'completed', acceptanceResults: [{ criterion: 'works', status: 'passed' }], changedPaths: ['src/a.js'] },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await service.reassignTask('alpha', 't1', 'a2', 'race test');
  const result = await completion;
  assert.equal(result.ok, false);
  assert.match(result.error, /stale attempt/);
  assert.equal(store.getTask('t1').assignee, 'a2');
  store.close();
});

test('P0: a completion without an explicit status is a deterministic validation error', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  service.addTask('alpha', implementationTask('t1'));
  await service.tick('alpha');
  const task = store.getTask('t1');
  await assert.rejects(
    () => service.completeTask({ teamId: 'alpha', taskId: 't1', attemptId: task.attemptId, update: {} }),
    /requires status/,
  );
  assert.equal(store.getTask('t1').status, 'in_progress');
  store.close();
});

function completedImplementation() {
  return {
    id: 'impl', teamId: 'alpha', subject: 'impl', kind: 'implementation', status: 'completed',
    assignee: 'Engineer 01', dependencies: [], objective: 'x', acceptance: ['works'],
    inScope: ['src/'], verify: ['node -e "process.exit(0)"'], changedPaths: ['src/a.js'],
    acceptanceResults: [{ criterion: 'works', status: 'passed' }],
    commandsRun: [{ command: 'x', status: 'passed' }],
  };
}

const scopeFinding = {
  id: 'f1',
  severity: 'high',
  problem: 'no path is cited',
  requiredFix: 'make the gate deterministic',
};

async function failReview(service, store, taskId) {
  const review = store.getTask(taskId);
  const result = await service.completeTask({
    teamId: 'alpha', taskId, attemptId: review.attemptId,
    update: { status: 'failed', verdict: 'needs_revision', findings: [scopeFinding] },
  });
  assert.equal(result.ok, true, result.error);
}

test('v0.6 emits gate.repair_warning when the repair scope falls back to the source inScope', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(completedImplementation());
  service.addTask('alpha', {
    id: 'review-1', subject: 'review-1', kind: 'review', assigneeRole: 'reviewer',
    objective: 'review', acceptance: ['quality'], reviewedTaskId: 'impl', dependencies: ['impl'],
  }, { internal: true });
  await service.tick('alpha');
  await failReview(service, store, 'review-1');

  const events = store.listEvents('alpha');
  const warning = events.find((event) => event.type === 'gate.repair_warning');
  assert.ok(warning, 'expected a gate.repair_warning event');
  assert.match(String(warning.warning), /inScope/i);
  const repair = store.listTasks('alpha').find((task) => task.kind === 'repair');
  assert.deepEqual(repair.inScope, ['src/']);
  assert.equal(repair.scopeSource, 'source');
  assert.ok(events.some((event) => event.type === 'gate.repair' && event.taskId === repair.id));
  store.close();
});

test('a dispatched review is not queued for merge', async () => {
  // Regression: dispatch stamped `mergeState: 'pending'` on every non-bound
  // worktree task, including reviews. A review never produces a delivery
  // commit, so nothing could ever merge it: the row sat in `pending` forever
  // and every pending-merge guard (worktree reclaim included) pinned its
  // checkout. Only kinds that can deliver a commit may become merge candidates.
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-review-merge-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    const { store, service } = setup();
    service.useWorktrees = true;
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.addTask(completedImplementation());
    service.addTask('alpha', {
      id: 'review-merge', subject: 'review-merge', kind: 'review', assigneeRole: 'reviewer',
      objective: 'review', acceptance: ['quality'], reviewedTaskId: 'impl', dependencies: [],
    }, { internal: true });
    service.addTask('alpha', { id: 'work-merge', subject: 'work-merge', kind: 'work' });

    await service.tick('alpha');
    const review = store.getTask('review-merge');
    assert.equal(review.status, 'in_progress');
    assert.equal(review.mergeState, 'not_applicable', 'a review must not enter the merge queue');

    // A kind that can deliver a commit still does.
    const work = store.getTask('work-merge');
    assert.equal(work.mergeState, 'pending');
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('service worktree reclaim reports per-team summary and preserves report on summary-event failure', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-reclaim-service-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const { store, service } = setup({ startClock: Date.now() });
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    const path = join(repo, '.agent-teams-worktrees', 'alpha', 'reclaim-summary');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', path, base], { cwd: repo });
    store.addTask({ id: 'reclaim-summary', teamId: 'alpha', kind: 'review', status: 'completed',
      mergeState: 'not_applicable', completedAt: Date.now() - 48 * 60 * 60 * 1000, worktree: path });

    const originalAddEvent = store.addEvent.bind(store);
    let failSummary = false;
    store.addEvent = (teamId, type, payload) => {
      if (failSummary && type === 'worktree.reclaim_summary') throw new Error('summary sink unavailable');
      return originalAddEvent(teamId, type, payload);
    };
    const first = await service.reclaimWorktrees();
    assert.equal(first.removed.length, 1);
    assert.ok(store.listEvents('alpha').some((event) => event.type === 'worktree.reclaim_summary'));

    const secondPath = join(repo, '.agent-teams-worktrees', 'alpha', 'reclaim-summary-2');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', secondPath, base], { cwd: repo });
    store.addTask({ id: 'reclaim-summary-2', teamId: 'alpha', kind: 'review', status: 'completed',
      mergeState: 'not_applicable', completedAt: Date.now() - 48 * 60 * 60 * 1000, worktree: secondPath });
    failSummary = true;
    const second = await service.reclaimWorktrees();
    assert.equal(second.removed.length, 1);
    assert.deepEqual(second.logErrors, [{ teamId: 'alpha', error: 'summary sink unavailable' }]);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fully pinned worktrees emit per-team reclaim summary metrics without paths', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-reclaim-pinned-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    const { store, service } = setup();
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    const path = join(repo, '.agent-teams-worktrees', 'alpha', 'pinned-live');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', path, 'HEAD'], { cwd: repo });
    store.addTask({ id: 'pinned-live', teamId: 'alpha', kind: 'implementation', status: 'in_progress',
      attemptId: 'live-attempt', worktree: path });

    const report = await service.reclaimWorktrees();
    assert.equal(report.removed.length, 0);
    assert.equal(report.skipped.length, 0);
    assert.equal(report.errors.length, 0);
    assert.equal(report.byTeam.alpha.remaining, 1);
    assert.equal(report.byTeam.alpha.active, 1);
    assert.equal(report.byTeam.alpha.pinned, 1);
    assert.equal(report.byTeam.alpha.protected, 1);
    const summary = store.listEvents('alpha').find((event) => event.type === 'worktree.reclaim_summary');
    assert.ok(summary, 'a fully pinned team still receives a summary event');
    assert.equal(summary.totalActive, 1);
    assert.equal(summary.totalPinned, 1);
    assert.equal(summary.totalProtected, 1);
    assert.equal(summary.totalRemaining, 1);
    assert.equal(Object.hasOwn(summary, 'path'), false);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('reclaim calls for one repository serialize and honor each orphan-sweep option', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ai-agent-teams-reclaim-queue-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });
    const { store, service } = setup();
    service.repo = repo;
    service.cwd = repo;
    service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
    store.persistent = true;
    const orphan = join(repo, '.agent-teams-worktrees', 'alpha', 'orphan-queue');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', orphan, 'HEAD'], { cwd: repo });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(orphan, old, old);

    const original = service.reclaimWorktreesOnce.bind(service);
    let releaseFirst;
    let notifyFirst;
    const firstStarted = new Promise((resolveFirst) => { notifyFirst = resolveFirst; });
    const holdFirst = new Promise((resolveFirst) => { releaseFirst = resolveFirst; });
    const optionsSeen = [];
    let running = 0;
    let maxRunning = 0;
    service.reclaimWorktreesOnce = async (options) => {
      optionsSeen.push(options.allowOrphanSweep === true);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      if (optionsSeen.length === 1) {
        notifyFirst();
        await holdFirst;
      }
      try {
        return await original(options);
      } finally {
        running -= 1;
      }
    };

    const firstCall = service.reclaimWorktrees({ allowOrphanSweep: false });
    await firstStarted;
    const secondCall = service.reclaimWorktrees({ allowOrphanSweep: true });
    releaseFirst();
    const [first, second] = await Promise.all([firstCall, secondCall]);

    assert.deepEqual(optionsSeen, [false, true]);
    assert.equal(maxRunning, 1, 'same-repository reclamation does not overlap');
    assert.equal(first.removed.length, 0, 'the weaker first call does not orphan-sweep');
    assert.ok(second.removed.includes(orphan), 'the later explicit orphan-sweep option is applied');
    assert.equal(existsSync(orphan), false);
    store.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('v0.6 emits gate.repair_deduplicated for a repeated finding set', async () => {
  const { store, service } = setup();
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  store.addTask(completedImplementation());
  service.addTask('alpha', {
    id: 'review-1', subject: 'review-1', kind: 'review', assigneeRole: 'reviewer',
    objective: 'review', acceptance: ['quality'], reviewedTaskId: 'impl', dependencies: ['impl'],
  }, { internal: true });
  await service.tick('alpha');
  await failReview(service, store, 'review-1');

  service.addTask('alpha', {
    id: 'review-2', subject: 'review-2', kind: 'review', assigneeRole: 'reviewer',
    objective: 'review again', acceptance: ['quality'], reviewedTaskId: 'impl', dependencies: ['impl'],
  }, { internal: true });
  await service.tick('alpha');
  await failReview(service, store, 'review-2');

  const events = store.listEvents('alpha');
  const deduplicated = events.find((event) => event.type === 'gate.repair_deduplicated');
  assert.ok(deduplicated, 'expected a gate.repair_deduplicated event');
  assert.match(String(deduplicated.reason), /same findings/);
  assert.equal(store.listTasks('alpha').filter((task) => task.kind === 'repair').length, 1);
  store.close();
});
