// Dispatch ready tasks while preserving the scheduler's exact sequencing: a slot is
// claimed before workspace/session work, and every await is followed by freshness checks.
import { join } from 'node:path';
import { isDispatchBlocked, nextReady } from '../domain/scheduler.mjs';
import { beginAttempt, invalidateAttempt } from '../domain/attempts.mjs';
import { createWorktree, ensureWorktreeBase, removeWorktree, copyUncommittedChanges } from '../git/worktree.mjs';
import { snapshotScope } from '../domain/artifacts.mjs';
import { dispatchTaskSession } from './task-dispatch-session.mjs';

export async function dispatchPlannedTasks(service, { teamId, team, plan, tasks, worktreeBase, activeStatuses, terminalStatuses }) {
  let dispatched = 0;
  const busyMembers = new Set(tasks
    .filter((task) => activeStatuses.has(task.status) && task.assignee)
    .map((task) => task.assignee));

  const blocked = worktreeBase.ready ? undefined : worktreeBase.blocked;
  for (const item of plan.dispatch) {
    if (!worktreeBase.ready) break;
    const task = service.store.getTask(item.taskId);
    if (!task || task.attemptId || task.status !== 'pending' || isDispatchBlocked(task)) continue;
    let member;
    try {
      member = service.features.lazyMembers
        ? service.ensureAssignee(teamId, task)
        : (service.store.findMember(teamId, item.member) ?? service.store.findMember(teamId, task.assignee));
    } catch (error) {
      service.store.addEvent(teamId, 'task.assignee_failed', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!member) {
      service.store.addEvent(teamId, 'task.deferred', { taskId: task.id, member: item.member, reason: 'member-unavailable' });
      continue;
    }
    if (member.sessionRecoveryState === 'unknown' || member.workerSessionStart) {
      service.store.addEvent(teamId, 'task.deferred', { taskId: task.id, member: member.name, reason: 'session-reconciliation-required' });
      continue;
    }
    if (busyMembers.has(member.name)) {
      service.store.addEvent(teamId, 'task.deferred', { taskId: task.id, member: member.name, reason: 'member-busy' });
      continue;
    }
    if (service.memberIsShadow(member)) {
      service.store.addEvent(teamId, 'task.deferred', {
        taskId: task.id, member: member.name, reason: 'shadow-control-seat',
      });
      continue;
    }
    if (service.features.licenses && member.license?.allowedTaskKinds
      && !member.license.allowedTaskKinds.includes(task.kind ?? 'work')) {
      service.store.addEvent(teamId, 'task.deferred', {
        taskId: task.id, member: member.name, reason: 'license-scope',
      });
      continue;
    }
    if (task.assignee !== member.name || task.assigneeId !== member.id || task.licenseId !== member.licenseId) {
      service.store.updateTask(task.id, {
        assignee: member.name,
        assigneeId: member.id,
        licenseId: member.licenseId,
      });
      task.assignee = member.name;
      task.assigneeId = member.id;
      task.licenseId = member.licenseId;
    }
    if (service.dispatchLimiter) await service.dispatchLimiter.acquire();
    const currentTask = service.store.getTask(task.id);
    if (!currentTask || currentTask.status !== 'pending' || currentTask.attemptId
      || !nextReady(service.store.listTasks(teamId), service.now()).some((ready) => ready.id === currentTask.id)) {
      // Another tick/approve may have dispatched this task while we waited.
      continue;
    }
    if (!service.useWorktrees && ((currentTask.kind === 'repair' && currentTask.mode === 'bound')
      || (currentTask.kind === 'review' && currentTask.reviewMode === 'bound'))) {
      service.store.updateTask(currentTask.id, {
        hold: { class: 'bound_task_requires_worktree', reason: 'bound_task_requires_worktree' }, needsCaptain: true,
      });
      service.store.updateTeam(teamId, { needsCaptain: true });
      service.store.addEvent(teamId, 'task.deferred', { taskId: currentTask.id, reason: 'bound-task-requires-worktree' });
      continue;
    }
    const previousWorktree = currentTask.worktree;
    const started = beginAttempt(currentTask, member.name, { now: service.now(), leaseMs: service.leaseMs });
    service.store.updateTask(task.id, started);
    service.store.addAttempt({
      id: started.attemptId,
      teamId,
      taskId: task.id,
      attempt: started.attempt,
      assignee: member.name,
      assigneeId: member.id,
      leaseExpiresAt: started.leaseExpiresAt,
      status: 'claimed',
      taskEpoch: started.taskEpoch ?? 0,
      controlEpoch: team.controlEpoch ?? 0,
      leaseId: started.attemptId,
      startedAt: service.now(),
    });
    busyMembers.add(member.name);
    let workdir = service.cwd;
    if (service.useWorktrees) {
      const prepared = await prepareTaskWorktree(service, {
        teamId, task, currentTask, member, started, previousWorktree, worktreeBase,
      });
      if (prepared.continueDispatch) continue;
      workdir = prepared.workdir;
    }
    if (task.kind === 'review' || (task.kind === 'verification' && task.reviewedTaskId)) {
      const reviewed = service.store.getTask(task.reviewedTaskId);
      if (reviewed?.worktree && currentTask.reviewMode !== 'bound') workdir = reviewed.worktree;
      if (task.kind === 'review') {
        service.store.updateTask(task.id, { verdictStartSnapshot: snapshotScope(workdir, reviewed?.inScope ?? []) });
      }
    }
    // dispatchTaskSession resolves to true only after send/bookkeeping succeeds;
    // handled dispatch failures resolve to false without changing this count.
    if (await dispatchTaskSession(service, {
      teamId, team, task, member, started, terminalStatuses, workdir,
    })) {
      dispatched += 1;
    }
  }
  return { dispatched, blocked };
}


/**
 * Prepare the isolated checkout for one task dispatch. A stale attempt or a
 * failed worktree operation is fully recorded before the caller advances.
 */
async function prepareTaskWorktree(service, { teamId, task, currentTask, member, started, previousWorktree, worktreeBase }) {
  let workdir = service.cwd;
  const boundReview = currentTask.kind === 'review' && currentTask.reviewMode === 'bound';
  // Review/verification work never produces a delivery commit, so marking
  // it `pending` put it in the merge queue forever: no merge was possible,
  // and every guard that protects pending merges (including worktree
  // reclaim) kept its checkout alive indefinitely. Only kinds that can
  // deliver a commit become merge candidates.
  const DELIVERABLE_KINDS = new Set(['implementation', 'repair', 'integration', 'work']);
  const initialMergeState = currentTask.kind && !DELIVERABLE_KINDS.has(currentTask.kind)
    ? { mergeState: 'not_applicable' } : { mergeState: 'pending' };
  const safeTaskId = String(task.id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const path = join(service.cwd, '.agent-teams-worktrees', teamId, `${safeTaskId}-${started.attempt}`);
  const base = service.config.teams.find((team) => team.id === teamId)?.baseBranch ?? 'HEAD';
  // worktreeBaseCheck already resolved (and cached) a concrete commit, so
  // the worktree and the later `git diff` use the same base even with HEAD.
  const repairSourceBase = currentTask.kind === 'repair' ? currentTask.sourceBase : undefined;
  const resolvedBase = boundReview ? currentTask.binding?.sourceCommit
    : repairSourceBase
    ?? (currentTask.mode === 'bound' && currentTask.sourceBase
      ? currentTask.sourceBase : (worktreeBase.commit ?? base));
  try {
    if (boundReview || repairSourceBase) {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolvedBase ?? '')) throw new Error('repair requires a full source commit');
      const checked = await ensureWorktreeBase({ repo: service.repo, base: resolvedBase });
      if (checked.commit !== resolvedBase) throw new Error('bound repair source commit changed');
    }
    await createWorktree({
      repo: service.repo,
      path,
      branch: `agent/${teamId}/${safeTaskId}/${started.attempt}`,
      base: resolvedBase,
      detached: boundReview,
      // Kept for callers that bypass tick()'s preflight; normal dispatch
      // creates the base in worktreeBaseCheck, so this rarely fires.
      onBaseCreated: (info) => service.store.addEvent(teamId, 'worktree.base_created', {
        base: info.base,
        commit: info.commit,
        reason: 'empty repository; created an empty baseline ref',
      }),
    });
    if (!service.isCurrentAttempt(task.id, started.attemptId, member.name)) {
      await removeWorktree({ repo: service.repo, path }).catch(() => {});
      service.store.updateAttempt(started.attemptId, { status: 'failed', endedAt: service.now(), error: 'stale attempt after worktree creation' });
      return { continueDispatch: true };
    }
    if (boundReview || (currentTask.kind === 'repair' && currentTask.mode === 'bound')) {
      const latest = service.store.getTask(task.id);
      const rows = service.store.listTasks(teamId).map((row) => row.id === task.id
        ? { ...row, status: 'pending', attemptId: undefined } : row);
      if (!latest || !nextReady(rows, service.now()).some((row) => row.id === task.id)) {
        service.store.updateAttempt(started.attemptId, { status: 'failed', endedAt: service.now(), error: 'delivery binding changed during worktree creation' });
        service.store.updateTask(task.id, { ...invalidateAttempt(latest ?? started, { assignee: task.assignee }), reassigning: false,
          worktree: path, worktreeBase: resolvedBase,
          hold: { class: 'stale_delivery_binding', reason: 'stale_delivery_binding' }, needsCaptain: true });
        service.store.updateTeam(teamId, { needsCaptain: true });
        service.store.addEvent(teamId, 'task.dispatch_failed', { taskId: task.id, error: 'delivery binding changed during worktree creation' });
        return { continueDispatch: true };
      }
    }
    workdir = path;
    if (!boundReview && previousWorktree && previousWorktree !== path) {
      try {
        const preserved = await copyUncommittedChanges({ from: previousWorktree, to: path });
        if (preserved.copied || preserved.deleted || preserved.skipped) {
          service.store.addEvent(teamId, 'task.worktree_preserved', {
            taskId: task.id, from: previousWorktree, to: path, ...preserved,
          });
        }
      } catch (error) {
        service.store.addEvent(teamId, 'task.worktree_preserve_failed', {
          taskId: task.id,
          from: previousWorktree,
          to: path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    service.store.updateTask(task.id, boundReview
      ? { worktree: path, reviewWorktree: path, worktreeBase: resolvedBase, mergeState: 'not_applicable' }
      : { worktree: path, worktreeBase: resolvedBase, ...initialMergeState,
        ...(currentTask.mode === 'bound' ? { sourceBase: resolvedBase, bindingState: 'pending_commit' } : {}) });
  } catch (error) {
    if (!service.isCurrentAttempt(task.id, started.attemptId, member.name)) {
      service.store.updateAttempt(started.attemptId, { status: 'failed', endedAt: service.now(), error: 'stale attempt after worktree failure' });
      return { continueDispatch: true };
    }
    service.store.updateAttempt(started.attemptId, { status: 'failed', endedAt: service.now() });
    service.store.updateTask(task.id, { ...invalidateAttempt(started, { assignee: task.assignee }), reassigning: false });
    service.store.addEvent(teamId, 'task.dispatch_failed', { taskId: task.id, error: `worktree: ${error instanceof Error ? error.message : String(error)}` });
    return { continueDispatch: true };
  }

  return { continueDispatch: false, workdir };
}
