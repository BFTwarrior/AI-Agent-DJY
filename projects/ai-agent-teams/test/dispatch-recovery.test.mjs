import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { FakeSessionAdapter } from '../src/session/adapter.mjs';
import { TeamService } from '../src/scheduler-service.mjs';
import { nextReady } from '../src/domain/scheduler.mjs';
import { beginAttempt } from '../src/domain/attempts.mjs';
import { dispatchPlannedTasks } from '../src/service/task-dispatch.mjs';
import { dispatchTaskSession } from '../src/service/task-dispatch-session.mjs';
import { removeTreeWithRetry } from './support/cleanup.mjs';

const ACTIVE = new Set(['claimed', 'in_progress']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function fixture(t, { worktrees = false, role = 'engineer' } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'dispatch-recovery-'));
  const { config } = loadConfig(fileURLToPath(new URL('../config/example.v06.json', import.meta.url)));
  config.features.lazyMembers = false;
  config.zcode.modelPolicy = 'fixed';
  const store = new Store(':memory:');
  const adapter = new FakeSessionAdapter();
  let clock = 1000;
  const service = new TeamService({ store, adapter, config, cwd, homeRoot: join(cwd, 'homes'),
    useWorktrees: worktrees, now: () => clock });
  t.after(() => {
    service.close();
    store.close();
    removeTreeWithRetry(cwd);
  });
  service.createTeam({ id: 'alpha', name: 'Alpha', phase: 'running' });
  const member = service.addMember('alpha', { name: 'worker', role });
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  let commit;
  if (worktrees) {
    git('init', '-b', 'main');
    git('-c', 'user.name=Dispatch Test', '-c', 'user.email=dispatch@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    commit = git('rev-parse', 'HEAD');
  }
  const add = (id, patch = {}) => store.addTask({ id, teamId: 'alpha', subject: id, kind: 'work',
    status: 'pending', assignee: member.name, assigneeId: member.id, licenseId: member.licenseId,
    attempt: 0, dependencies: [], ...patch });
  const dispatch = (...ids) => dispatchPlannedTasks(service, {
    teamId: 'alpha', team: store.getTeam('alpha'), tasks: store.listTasks('alpha'),
    plan: { dispatch: ids.map((taskId) => ({ taskId, member: member.name })) },
    worktreeBase: { ready: true, commit }, activeStatuses: ACTIVE, terminalStatuses: TERMINAL,
  });
  return { cwd, config, store, service, adapter, member, git, commit, add, dispatch,
    advance: (ms) => { clock += ms; } };
}

function boundReview(f) {
  const source = f.add('source', { kind: 'implementation', status: 'completed', mode: 'bound',
    deliveryUnitId: 'source', deliverySeq: 0, taskEpoch: 0,
    sourceBase: f.commit ?? 'base', sourceCommit: f.commit ?? 'source-commit', diffHash: 'digest' });
  return f.add('review', { kind: 'review', reviewMode: 'bound', reviewedTaskId: source.id,
    deliveryGeneration: 0, dependencies: [source.id], binding: { sourceTaskId: source.id,
      deliveryUnitId: source.id, deliverySeq: 0, sourceCommit: source.sourceCommit,
      sourceBase: source.sourceBase, diffHash: source.diffHash } });
}

function releaseHold(f, id, expectedReason) {
  assert.equal(f.store.getTask(id).hold.reason, expectedReason);
  assert.throws(() => f.service.releaseTaskHold('alpha', id, {
    reason: 'resolved', expectedReason: 'older-reason', actor: { role: 'admin' },
  }), { code: 'E_STALE_HOLD' });
  assert.equal(f.service.releaseTaskHold('alpha', id, {
    reason: 'resolved', expectedReason, actor: { role: 'admin' },
  }).ok, true);
  assert.equal(f.store.getTask(id).hold, undefined);
}

for (const code of ['E_SESSION_CAP', 'E_CONTROL_CAP']) {
  test(`dispatch recovery: ${code} defers without failure budget and retries after capacity returns`, async (t) => {
    const f = fixture(t, { role: code === 'E_CONTROL_CAP' ? 'lead' : 'engineer' });
    f.config.scheduler[code === 'E_CONTROL_CAP' ? 'maxControlSessions' : 'maxTotalSessions'] = 1;
    f.store.updateTeam('alpha', { captainSessionId: 'occupying-captain' });
    f.add('limited', { turnFailureCount: 2 });
    f.add('same-member');
    const token = f.store.getMemberToken(f.member.id);
    assert.equal((await f.dispatch('limited', 'same-member')).dispatched, 0);
    const deferred = f.store.getTask('limited');
    assert.equal(deferred.status, 'pending');
    assert.equal(deferred.turnFailureCount, 2, 'local admission is not a provider/turn failure');
    assert.equal(deferred.reassigning, false, 'same-assignee deferral must remain schedulable');
    assert.equal(deferred.attemptId, undefined);
    assert.equal(deferred.attempt, 1);
    assert.equal(f.store.listAttempts('alpha').filter((attempt) => attempt.taskId === 'limited')[0].status, 'failed');
    assert.equal(f.store.getTask('same-member').attempt, 0, 'retain the member for the rest of this dispatch batch');
    assert.equal(f.store.getMemberToken(f.member.id), token);
    assert.equal(f.store.getMember(f.member.id).workerSessionStart, undefined);
    assert.equal(f.adapter.calls.length, 0);
    const events = f.store.listEvents('alpha');
    assert.ok(events.some((e) => e.type === 'task.dispatch_deferred' && e.reason === code));
    assert.ok(events.some((e) => e.type === 'task.deferred' && e.reason === 'member-busy'));
    assert.equal(events.filter((e) => ['task.dispatch_failed', 'task.turn_failed', 'task.retry_scheduled'].includes(e.type)).length, 0);
    assert.ok(nextReady(f.store.listTasks('alpha'), 1000).some((row) => row.id === 'limited'));
    f.store.updateTeam('alpha', { captainSessionId: undefined });
    assert.equal((await f.dispatch('limited')).dispatched, 1);
    assert.equal(f.store.getTask('limited').attempt, 2);
    assert.equal(f.store.getTask('limited').turnFailureCount, 2);
  });
}

for (const code of ['E_SESSION_CAP', 'E_CONTROL_CAP']) {
  for (const stage of ['create', 'send']) {
    test(`dispatch recovery: adapter ${stage} ${code} is not treated as local admission rejection`, async (t) => {
      const f = fixture(t);
      f.add(`adapter-${stage}`);
      const adapterError = Object.assign(new Error(`adapter ${stage} failed`), { code });
      if (stage === 'create') {
        t.mock.method(f.adapter, 'create', async () => { throw adapterError; });
      } else {
        const { sessionId } = await f.adapter.create({});
        f.store.updateMember(f.member.id, { sessionId, workdir: f.cwd });
        f.adapter.handler = async () => { throw adapterError; };
      }

      assert.equal((await f.dispatch(`adapter-${stage}`)).dispatched, 0);
      const task = f.store.getTask(`adapter-${stage}`);
      assert.equal(f.store.listEvents('alpha').some((event) => event.type === 'task.dispatch_deferred'
        && event.reason === code), false, 'only local admission assertions may emit capacity deferral');
      if (stage === 'create') {
        assert.equal(task.hold.reason, 'session_creation_unknown');
        assert.equal(task.turnFailureCount ?? 0, 0, 'ambiguous creation stays held instead of being retried');
        assert.equal(f.store.listAttempts('alpha').find((attempt) => attempt.taskId === task.id).status, 'orphaned');
      } else {
        assert.equal(task.turnFailureCount, 1, 'send errors use ordinary failure accounting');
        assert.ok(task.retryNotBefore > 1000, 'ordinary retry includes backoff');
        assert.ok(f.store.listEvents('alpha').some((event) => event.type === 'task.dispatch_failed'));
      }
    });
  }
}

test('dispatch recovery: bound task without worktrees has a releasable hold before claim', async (t) => {
  const f = fixture(t, { role: 'reviewer' });
  boundReview(f);
  assert.ok(nextReady(f.store.listTasks('alpha'), 1000).some((row) => row.id === 'review'));
  assert.equal((await f.dispatch('review')).dispatched, 0);
  assert.equal(f.store.listAttempts('alpha').filter((attempt) => attempt.taskId === 'review').length, 0);
  assert.equal(f.adapter.calls.length, 0);
  releaseHold(f, 'review', 'bound_task_requires_worktree');
  assert.equal((await f.dispatch('review')).dispatched, 0, 'release does not bypass the worktree prerequisite');
  assert.equal(f.store.getTask('review').hold.reason, 'bound_task_requires_worktree');
});

test('dispatch recovery: binding drift hold can be released and retried after source reconciliation', async (t) => {
  const f = fixture(t, { worktrees: true, role: 'reviewer' });
  boundReview(f);
  const check = f.service.isCurrentAttempt.bind(f.service);
  let changed = false;
  t.mock.method(f.service, 'isCurrentAttempt', (...args) => {
    if (!changed) {
      changed = true;
      f.store.updateTask('source', { sourceCommit: 'changed-source' });
    }
    return check(...args);
  });
  assert.equal((await f.dispatch('review')).dispatched, 0);
  const held = f.store.getTask('review');
  assert.equal(held.hold.class, 'stale_delivery_binding');
  assert.equal(held.attempt, 1);
  assert.ok(existsSync(held.worktree), 'retain the checkout for captain reconciliation');
  assert.equal(f.store.listAttempts('alpha').filter((attempt) => attempt.taskId === 'review')[0].status, 'failed');
  assert.equal(f.adapter.calls.length, 0);
  releaseHold(f, 'review', 'stale_delivery_binding');
  assert.equal(nextReady(f.store.listTasks('alpha'), 1000).some((row) => row.id === 'review'), false);
  f.store.updateTask('source', { sourceCommit: f.commit });
  assert.ok(nextReady(f.store.listTasks('alpha'), 1000).some((row) => row.id === 'review'));
  assert.equal((await f.dispatch('review')).dispatched, 1);
  assert.equal(f.store.getTask('review').attempt, 2);
});

test('dispatch recovery: unknown create hold is releasable without freeing occupancy or restoring token', async (t) => {
  const f = fixture(t);
  f.add('unknown');
  t.mock.method(f.adapter, 'create', async () => { throw new Error('create response lost'); });
  assert.equal((await f.dispatch('unknown')).dispatched, 0);
  const member = f.store.getMember(f.member.id);
  assert.equal(member.workerSessionStart.state, 'unknown');
  assert.equal(f.store.getMemberToken(f.member.id), undefined);
  assert.equal(f.service.workspaceSessionCount(), 1);
  assert.equal(f.store.listAttempts('alpha').filter((attempt) => attempt.taskId === 'unknown')[0].status, 'orphaned');
  releaseHold(f, 'unknown', 'session_creation_unknown');
  assert.equal(f.store.getTask('unknown').reassigning, false, 'only the explicit hold/session gate should block recovery');
  assert.equal((await f.dispatch('unknown')).dispatched, 0);
  assert.equal(f.adapter.create.mock.callCount(), 1);
  assert.equal(f.service.workspaceSessionCount(), 1);
  assert.equal(f.store.getMemberToken(f.member.id), undefined);
  assert.ok(f.store.listEvents('alpha').some((e) => e.type === 'task.deferred' && e.reason === 'session-reconciliation-required'));
});

test('dispatch recovery: failed retirement produces a named session hold and preserves the occupied session', async (t) => {
  const f = fixture(t);
  f.add('switch');
  const { sessionId } = await f.adapter.create({});
  f.store.updateMember(f.member.id, { sessionId, workdir: join(f.cwd, 'previous') });
  t.mock.method(f.adapter, 'verifySessionTermination', async () => ({ verified: false, sideEffectsRevoked: false }));
  assert.equal((await f.dispatch('switch')).dispatched, 0);
  assert.equal(f.store.getMember(f.member.id).sessionRecoveryState, 'unknown');
  assert.equal(f.store.getMember(f.member.id).sessionId, sessionId);
  releaseHold(f, 'switch', 'session_creation_unknown');
  assert.equal(f.store.getTask('switch').reassigning, false);
  assert.equal((await f.dispatch('switch')).dispatched, 0);
  assert.equal(f.service.workspaceSessionCount(), 1);
  assert.equal(f.store.getMemberToken(f.member.id), undefined);
});

test('dispatch recovery: busy send preserves the prepared checkout and monotonic attempt count', async (t) => {
  const f = fixture(t, { worktrees: true });
  const previous = join(f.cwd, 'previous');
  f.git('worktree', 'add', '-b', 'previous', previous, f.commit);
  writeFileSync(join(previous, 'draft.txt'), 'uncommitted work');
  f.add('busy', { attempt: 4, worktree: previous, worktreeBase: 'old-base', turnFailureCount: 2 });
  let busy = true;
  f.adapter.handler = async () => {
    if (busy) throw new Error('prompt is already running');
    return { response: 'ok' };
  };
  assert.equal((await f.dispatch('busy')).dispatched, 0);
  const pending = f.store.getTask('busy');
  const prepared = join(f.cwd, '.agent-teams-worktrees', 'alpha', 'busy-5');
  assert.equal(pending.worktree, prepared);
  assert.equal(pending.worktreeBase, f.commit);
  assert.equal(pending.attempt, 5);
  assert.equal(pending.turnFailureCount, 2);
  assert.equal(pending.retryNotBefore, 6000);
  assert.equal(readFileSync(join(prepared, 'draft.txt'), 'utf8'), 'uncommitted work');
  assert.equal(f.store.listAttempts('alpha').filter((attempt) => attempt.taskId === 'busy')[0].status, 'failed');
  assert.equal(f.store.listEvents('alpha').filter((e) => e.type === 'task.dispatch_failed').length, 0);
  assert.equal((await f.dispatch('busy')).dispatched, 0, 'honor busy backoff');
  busy = false;
  f.advance(5000);
  assert.equal((await f.dispatch('busy')).dispatched, 1);
  assert.equal(f.store.getTask('busy').attempt, 6);
  assert.equal(readFileSync(join(f.store.getTask('busy').worktree, 'draft.txt'), 'utf8'), 'uncommitted work');
});

test('dispatch recovery: worktree failure closes one attempt, returns zero, and keeps the batch member occupied', async (t) => {
  const f = fixture(t, { worktrees: true });
  f.add('broken', { attempt: 4, turnFailureCount: 2 });
  f.add('sibling');
  f.git('branch', 'agent/alpha/broken/5');
  assert.equal((await f.dispatch('broken', 'sibling')).dispatched, 0);
  assert.equal(f.store.getTask('broken').attempt, 5);
  assert.equal(f.store.getTask('broken').reassigning, false);
  assert.equal(f.store.getTask('broken').turnFailureCount, 2);
  assert.equal(f.store.getTask('sibling').attempt, 0);
  assert.equal(f.store.listAttempts('alpha').filter((attempt) => attempt.taskId === 'broken')[0].status, 'failed');
  assert.equal(f.adapter.calls.length, 0);
  const events = f.store.listEvents('alpha');
  const failure = events.findIndex((e) => e.type === 'task.dispatch_failed');
  assert.match(events[failure].error, /^worktree: /);
  assert.ok(events.findIndex((e) => e.type === 'task.deferred' && e.reason === 'member-busy') > failure);
  assert.equal((await f.dispatch('broken')).dispatched, 1);
  assert.equal(f.store.getTask('broken').attempt, 6);
});

test('dispatch recovery: worktree preservation failure warns but dispatches the prepared checkout', async (t) => {
  const f = fixture(t, { worktrees: true });
  const previous = join(f.cwd, 'previous');
  f.git('worktree', 'add', '-b', 'previous', previous, f.commit);
  writeFileSync(join(previous, 'draft.txt'), 'uncommitted draft');
  f.add('preserve', { worktree: previous });
  const check = f.service.isCurrentAttempt.bind(f.service);
  let injected = false;
  t.mock.method(f.service, 'isCurrentAttempt', (...args) => {
    if (!injected) {
      injected = true;
      // A directory at the destination file makes the actual copy fail.
      mkdirSync(join(f.cwd, '.agent-teams-worktrees', 'alpha', 'preserve-1', 'draft.txt'));
    }
    return check(...args);
  });
  assert.equal((await f.dispatch('preserve')).dispatched, 1);
  const task = f.store.getTask('preserve');
  assert.equal(task.status, 'in_progress');
  assert.equal(task.worktree, join(f.cwd, '.agent-teams-worktrees', 'alpha', 'preserve-1'));
  assert.equal(task.worktreeBase, f.commit);
  const events = f.store.listEvents('alpha');
  const warning = events.findIndex((e) => e.type === 'task.worktree_preserve_failed');
  assert.ok(warning >= 0);
  assert.equal(events[warning].from, previous);
  assert.equal(events[warning].to, task.worktree);
  assert.ok(events.findIndex((e) => e.type === 'task.dispatched') > warning);
  assert.equal(events.filter((e) => e.type === 'task.dispatch_failed').length, 0);
});

function claimedSession(f) {
  const task = f.add('session-task');
  const started = beginAttempt(task, f.member.name, { now: 1000 });
  f.store.updateTask(task.id, started);
  f.store.addAttempt({ id: started.attemptId, teamId: 'alpha', taskId: task.id,
    attempt: started.attempt, assignee: f.member.name, status: 'claimed' });
  return { teamId: 'alpha', team: f.store.getTeam('alpha'), task, started,
    member: f.store.getMember(f.member.id), terminalStatuses: TERMINAL, workdir: f.cwd };
}

test('dispatch recovery: unavailable cursor records diagnostics before reset/failure and never sends', async (t) => {
  const f = fixture(t);
  const context = claimedSession(f);
  const order = [];
  t.mock.method(f.service, 'resetMemberSession', async () => { order.push('reset'); });
  const failure = f.service.handleTurnFailure.bind(f.service);
  t.mock.method(f.service, 'handleTurnFailure', (input) => { order.push('failure'); return failure(input); });
  const addEvent = f.store.addEvent.bind(f.store);
  t.mock.method(f.store, 'addEvent', (...args) => {
    if (args[1] === 'task.turn_watch_unavailable') order.push('unavailable');
    return addEvent(...args);
  });
  const now = t.mock.method(Date, 'now', () => 1000);
  f.adapter.turnCursor = async () => {
    now.mock.mockImplementation(() => 1037);
    throw new Error('session is not active');
  };
  assert.equal(await dispatchTaskSession(f.service, context), false);
  assert.deepEqual(order, ['unavailable', 'reset', 'failure']);
  const event = f.store.listEvents('alpha').find((e) => e.type === 'task.turn_watch_unavailable');
  assert.equal(event.attemptId, context.started.attemptId);
  assert.equal(event.attempts, 1);
  assert.equal(event.elapsedMs, 37);
  assert.equal(event.error, 'session is not active');
  assert.equal(f.adapter.calls.filter((call) => call.kind === 'send').length, 0);
  assert.equal(f.store.getTask(context.task.id).turnFailureCount, 1);
  assert.equal(f.store.getTask(context.task.id).retryNotBefore, 4000);
});

test('dispatch recovery: cursor event write errors stay inside dispatch catch', async (t) => {
  const f = fixture(t);
  const context = claimedSession(f);
  f.adapter.turnCursor = async () => { throw new Error('forbidden cursor'); };
  const addEvent = f.store.addEvent.bind(f.store);
  t.mock.method(f.store, 'addEvent', (...args) => {
    if (args[1] === 'task.turn_watch_unavailable') throw new Error('cursor event write failed');
    return addEvent(...args);
  });
  assert.equal(await dispatchTaskSession(f.service, context), false);
  assert.ok(f.store.listEvents('alpha').some((e) => e.type === 'task.dispatch_failed' && e.error === 'cursor event write failed'));
  assert.equal(f.store.getTask(context.task.id).turnFailureCount, 1);
});

test('dispatch recovery: reset rejection in the failure handler still escapes without a second classification', async (t) => {
  const f = fixture(t);
  const context = claimedSession(f);
  const resetError = new Error('reset rejected');
  f.adapter.handler = async () => { throw new Error('session is not active'); };
  t.mock.method(f.service, 'resetMemberSession', async () => { throw resetError; });
  const failure = t.mock.method(f.service, 'handleTurnFailure');
  await assert.rejects(dispatchTaskSession(f.service, context), (error) => error === resetError);
  assert.equal(failure.mock.callCount(), 0);
  assert.equal(f.store.listEvents('alpha').filter((e) => e.type === 'task.dispatch_failed').length, 1);
});

test('dispatch recovery: stale after send stops before closing the old attempt and never records dispatch/usage/watch', async (t) => {
  const f = fixture(t);
  const context = claimedSession(f);
  const order = [];
  f.adapter.turnCursor = async () => 7;
  f.adapter.watchTurn = () => { assert.fail('stale send must not arm a watcher'); };
  f.adapter.handler = async () => {
    f.store.updateTask(context.task.id, { attemptId: 'new-attempt', attempt: 2, status: 'claimed' });
    return { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
  };
  const stop = f.adapter.stop.bind(f.adapter);
  t.mock.method(f.adapter, 'stop', (input) => { order.push('stop'); return stop(input); });
  const update = f.store.updateAttempt.bind(f.store);
  t.mock.method(f.store, 'updateAttempt', (...args) => {
    if (f.store.inTransaction) order.push('close-attempt');
    return update(...args);
  });
  const refresh = f.service.refreshMemberState.bind(f.service);
  t.mock.method(f.service, 'refreshMemberState', (...args) => { order.push('refresh'); return refresh(...args); });
  const usage = t.mock.method(f.store, 'recordUsage');
  assert.equal(await dispatchTaskSession(f.service, context), false);
  assert.deepEqual(order, ['stop', 'close-attempt', 'refresh']);
  assert.equal(f.store.getTask(context.task.id).attemptId, 'new-attempt');
  assert.equal(f.store.getTask(context.task.id).attempt, 2);
  assert.equal(f.store.listAttempts('alpha').filter((attempt) => attempt.taskId === context.task.id)[0].error, 'stale attempt after send');
  assert.equal(f.store.listEvents('alpha').filter((e) => e.type === 'task.dispatched').length, 0);
  assert.equal(usage.mock.callCount(), 0);
});
