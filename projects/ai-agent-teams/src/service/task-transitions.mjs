import { assertAttempt, beginAttempt, invalidateAttempt } from '../domain/attempts.mjs';
import { RED_REVIEW_ACTOR, isDispatchBlocked, nextReady } from '../domain/scheduler.mjs';

const ACTIVE_STATUSES = new Set(['claimed', 'in_progress']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TASK_AMENDABLE_FIELDS = ['objective', 'acceptance', 'verify', 'inScope', 'outOfScope'];

export async function continueTask(service, teamId, taskId, options = {}) {
  const actor = options.actor;
  const redReviewId = options.redReviewId;
  const systemRedReview = Boolean(redReviewId) || actor?.system === true;
  if (!service.canContinueTask(teamId, actor)) {
    throw Object.assign(new Error('continue_task requires a captain token or a reviewer license'), {
      status: 403, code: 'E_FORBIDDEN',
    });
  }
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) {
    throw Object.assign(new Error(`unknown task: ${taskId}`), { status: 404, code: 'E_NOT_FOUND' });
  }
  if (task.status !== 'failed') {
    throw Object.assign(new Error(`only a failed task can be continued: ${task.status}`), {
      status: 400, code: 'E_STATE',
    });
  }
  if (!task.assignee) {
    throw Object.assign(new Error('task has no assignee to continue'), { status: 400, code: 'E_STATE' });
  }
  const team = service.store.getTeam(teamId);
  if (!team || team.phase === 'staged' || team.phase === 'archived' || team.control !== 'active') {
    throw Object.assign(new Error('team is not active; resume it before continuing a task'), {
      status: 409, code: 'E_STATE',
    });
  }
  const member = service.store.findMember(teamId, task.assignee);
  if (!member) {
    throw Object.assign(new Error(`assignee is not on the roster: ${task.assignee}`), {
      status: 400, code: 'E_STATE',
    });
  }
  const open = service.store.listTasks(teamId)
    .filter((item) => item.id !== task.id && ACTIVE_STATUSES.has(item.status) && item.assignee === task.assignee);
  if (open.length > 0) {
    throw Object.assign(new Error(`member ${task.assignee} already owns an open task: ${open[0].id}`), {
      status: 409, code: 'E_STATE',
    });
  }
  // A rebuilt member session must not receive a bare "继续": the new session
  // never saw the task prompt. Requeue the same task so dispatch sends the
  // full prompt, and start the red-review budget from zero on the new session.
  if (task.lastSessionId && member.sessionId && task.lastSessionId !== member.sessionId) {
    const now = service.now();
    service.store.updateTask(task.id, {
      status: 'pending',
      attemptId: undefined,
      leaseExpiresAt: undefined,
      autoContinue: false,
      retryNotBefore: now,
      redContinueCount: 0,
      redContinueSessionId: undefined,
      pendingRedReviewId: systemRedReview ? redReviewId : undefined,
      pendingRedReviewBy: systemRedReview ? (actor?.name ?? RED_REVIEW_ACTOR) : undefined,
      redReviewEscalated: systemRedReview ? task.redReviewEscalated === true : false,
      lastTurnError: undefined,
      error: undefined,
      closedAt: undefined,
    });
    service.store.addEvent(teamId, 'task.continue_session_lost', {
      taskId: task.id, reason: 'session-changed', previousSessionId: task.lastSessionId,
      sessionId: member.sessionId,
    });
    return {
      ok: true,
      sent: false,
      warning: 'member session changed; the same task was requeued for a fresh session',
      task: service.store.getTask(task.id),
    };
  }
  const now = service.now();
  const reason = String(options.reason ?? '').trim() || 'manual continue';
  const fresh = beginAttempt(task, task.assignee, { now, leaseMs: service.leaseMs });
  service.store.updateTask(task.id, {
    ...fresh,
    status: 'in_progress',
    retryNotBefore: now,
    autoContinue: true,
    autoContinueCount: 0,
    continueDeferCount: 0,
    turnFailureCount: 0,
    // A human takeover clears the red-review history. The daemon's own
    // review keeps the running count and marks the attempt so the increment
    // happens only when the "继续" is actually sent.
    ...(systemRedReview
      ? {
        pendingRedReviewId: redReviewId,
        pendingRedReviewBy: actor?.name ?? RED_REVIEW_ACTOR,
        redReviewPendingSessionId: member?.sessionId,
        redContinueCount: task.redContinueSessionId && member?.sessionId
          && task.redContinueSessionId !== member.sessionId
          ? 0 : task.redContinueCount,
        // Never reopen an escalated task; a fresh task simply starts false.
        redReviewEscalated: task.redReviewEscalated === true,
      }
      : {
        redContinueCount: 0,
        redContinueSessionId: undefined,
        pendingRedReviewId: undefined,
        pendingRedReviewBy: undefined,
        redReviewPendingSessionId: undefined,
        redReviewEscalated: false,
      }),
    lastContinueAt: now,
    lastContinueBy: actor?.role === 'admin' ? 'captain' : actor?.name,
    lastContinueReason: reason,
    error: undefined,
    closedAt: undefined,
    ...(member?.sessionId ? { lastSessionId: member.sessionId } : {}),
  });
  service.store.addAttempt({
    id: fresh.attemptId,
    teamId,
    taskId: task.id,
    attempt: fresh.attempt,
    assignee: task.assignee,
    assigneeId: member?.id,
    leaseExpiresAt: fresh.leaseExpiresAt,
    status: 'claimed',
    taskEpoch: fresh.taskEpoch ?? task.taskEpoch ?? 0,
    controlEpoch: service.store.getTeam(teamId)?.controlEpoch ?? 0,
    startedAt: now,
  });
  service.store.addEvent(teamId, 'task.continue_requested', {
    taskId: task.id,
    attemptId: fresh.attemptId,
    attempt: fresh.attempt,
    reason,
    actor: actor?.role === 'admin' ? 'captain' : actor?.name,
  });
  if (!member?.sessionId) {
    // The session is gone: requeue the same task so dispatch creates a new
    // session. The task id and subject still never change.
    const current = service.store.getTask(task.id);
    service.store.updateAttempt(fresh.attemptId, { status: 'failed', endedAt: now, error: 'no member session' });
    service.store.updateTask(task.id, {
      ...invalidateAttempt(current, { assignee: current.assignee }),
      status: 'pending',
      reassigning: false,
      autoContinue: false,
      retryNotBefore: now,
      redContinueCount: 0,
      redContinueSessionId: undefined,
      pendingRedReviewId: redReviewId,
    });
    service.store.addEvent(teamId, 'task.continue_session_lost', { taskId: task.id, reason: 'no member session' });
    await service.tick(teamId);
    return {
      ok: true,
      sent: false,
      warning: 'member session is gone; the same task was requeued for a fresh session',
      task: service.store.getTask(task.id),
    };
  }
  const continued = await service.continueDueTurns(teamId, service.now());
  const current = service.store.getTask(task.id);
  const sent = Boolean(current && current.attemptId === fresh.attemptId && current.autoContinue !== true);
  return {
    ok: true,
    sent,
    continued: continued > 0,
    ...(sent ? {} : { warning: 'continue was scheduled but not sent yet' }),
    task: current,
  };
}

export async function reassignTask(service, teamId, taskId, assignee, reason = 'reassigned') {
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  if (['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error('cannot reassign a terminal task');
  if (assignee === 'captain' || assignee === (service.config.captain.name ?? 'captain')) {
    if (service.features.lazyMembers) throw new Error('captain is a control identity in v0.6');
    const captainOpen = service.store.listTasks(teamId).some((item) => item.assignee === 'captain'
      && !['completed', 'failed', 'cancelled'].includes(item.status));
    if (captainOpen) throw new Error('captain can own only one unfinished task');
  }
  const oldMember = task.assignee ? service.store.findMember(teamId, task.assignee) : undefined;
  if (oldMember?.sessionId) await service.adapter.stop({ sessionId: oldMember.sessionId });
  const current = service.store.getTask(taskId);
  if (!current || TERMINAL_STATUSES.has(current.status) || current.attemptId !== task.attemptId) {
    return { ok: false, error: 'task changed during reassignment; refusing to overwrite it' };
  }
  if (current.attemptId) service.store.updateAttempt(current.attemptId, { status: 'reassigned', endedAt: service.now() });
  service.store.updateTask(taskId, { ...invalidateAttempt(current, { assignee }), reassigning: false });
  if (oldMember) service.refreshMemberState(teamId, oldMember.id);
  service.store.addEvent(teamId, 'task.reassigned', { taskId, assignee, reason });
  await service.tick(teamId);
  return service.store.getTask(taskId);
}

export function claimTask(service, teamId, taskId, memberName, attemptId, actor) {
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  if (isDispatchBlocked(task)) throw Object.assign(new Error('task is held or historical'), { status: 409, code: 'E_STATE' });
  if (actor?.role === 'member' && actor.name !== memberName) throw Object.assign(new Error('member may only claim for itself'), { status: 403, code: 'E_FORBIDDEN' });
  if (actor?.role === 'member' && task.assignee && task.assignee !== actor.name) {
    throw Object.assign(new Error('task is assigned to another member'), { status: 403, code: 'E_FORBIDDEN' });
  }
  assertAttempt(task, attemptId);
  service.assertAttemptEpoch(task, attemptId);
  if ((task.kind === 'review' && task.reviewMode === 'bound') || (task.kind === 'repair' && task.mode === 'bound')) {
    const rows = service.store.listTasks(teamId).map((row) => row.id === taskId ? { ...row, status: 'pending' } : row);
    if (!nextReady(rows, service.now()).some((row) => row.id === taskId)) {
      throw Object.assign(new Error('delivery binding changed before claim'), { status: 409, code: 'E_STATE' });
    }
  }
  if (task.assignee && task.assignee !== memberName) throw Object.assign(new Error('task is assigned to another member'), { status: 403, code: 'E_FORBIDDEN' });
  const member = service.store.findMember(teamId, memberName);
  if (!member) throw new Error(`unknown member: ${memberName}`);
  service.store.updateMember(member.id, { status: 'working' });
  service.store.addEvent(teamId, 'task.claimed', { taskId, member: memberName, attemptId });
  return service.store.getTask(taskId);
}

export function heartbeatTask(service, teamId, taskId, attemptId, actor) {
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  if (actor?.role === 'member' && task.assignee !== actor.name) {
    throw Object.assign(new Error('member may only heartbeat its own task'), { status: 403, code: 'E_FORBIDDEN' });
  }
  assertAttempt(task, attemptId);
  service.assertAttemptEpoch(task, attemptId);
  const next = service.store.updateTask(taskId, { leaseExpiresAt: service.now() + service.leaseMs });
  service.store.updateAttempt(attemptId, { leaseExpiresAt: next.leaseExpiresAt });
  return next;
}

export function amendTask(service, teamId, taskId, fields, reason, actor) {
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  // Public amendments follow the same team-state gate as addTask; internal
  // recovery callers (actor undefined) may still repair bookkeeping.
  if (actor) service.assertTeamWritable(teamId, {}, 'amendTask');
  if (['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error('cannot amend a terminal task');
  if (task.verdict === 'pass' || (task.reviewedArtifacts ?? []).length > 0) {
    throw new Error('contract is frozen after a passing review');
  }
  if (!reason || !String(reason).trim()) throw new Error('amendment requires a reason');
  const input = fields ?? {};
  service.assertTaskContractAuthority(teamId, input, actor);
  const changed = TASK_AMENDABLE_FIELDS.filter((field) => input[field] !== undefined);
  // Non-contract, lifecycle, merge and evidence fields are dropped instead
  // of being written straight into the stored task.
  if (changed.length === 0) return task;
  const update = Object.fromEntries(changed.map((field) => [field, input[field]]));
  const by = actor?.role === 'admin' ? 'captain' : (actor?.name ?? 'captain');
  const revision = {
    at: service.now(),
    by,
    reason,
    fields: changed,
    previous: Object.fromEntries(changed.map((field) => [field, task[field]])),
  };
  const next = service.store.updateTask(taskId, { ...update, revisions: [...(task.revisions ?? []), revision] });
  service.store.addEvent(teamId, 'task.amended', { taskId, reason, fields: changed, by });
  return next;
}

export function releaseTaskHold(service, teamId, taskId, { reason, expectedReason, actor } = {}) {
  if (!service.canActAsCaptain(teamId, actor)) {
    throw Object.assign(new Error('releasing a hold requires captain authority'), {
      status: 403, code: 'E_FORBIDDEN',
    });
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw Object.assign(new Error('hold release requires a reason'), { status: 400, code: 'E_INVALID' });
  }
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  if (!task.hold) return { ok: true, task, alreadyReleased: true };
  if (task.hold.class === 'legacy_repair_manual'
    || task.hold.reason === 'legacy_repair_manual') {
    throw Object.assign(new Error('legacy_repair_manual hold cannot be released; cancel and rebuild'), {
      status: 409, code: 'E_STATE',
    });
  }
  if (typeof expectedReason !== 'string' || !expectedReason) {
    throw Object.assign(new Error('hold release requires expectedReason to avoid clearing a newer hold'), {
      status: 400, code: 'E_INVALID',
    });
  }
  if (expectedReason !== task.hold.reason) {
    throw Object.assign(new Error(`hold reason changed: expected ${expectedReason}, current ${task.hold.reason}`), {
      status: 409, code: 'E_STALE_HOLD',
    });
  }
  const current = task.hold;
  // Clearing a hold must not erase an unrelated escalation: only the
  // escalation recorded on this hold may be cleared.
  const residualEscalation = task.bindingState === 'blocked'
    || ['blocked', 'ff_exhausted', 'revert_failed'].includes(task.mergeState);
  const clearEscalation = current.escalated === true && !residualEscalation;
  const next = service.store.updateTask(task.id, {
    hold: undefined,
    holdReleasedAt: service.now(),
    holdReleaseReason: reason,
    needsCaptain: clearEscalation ? false : task.needsCaptain,
  });
  service.store.addEvent(teamId, 'task.hold_released', {
    taskId: task.id, hold: current, reason, actor: actor?.name ?? actor?.role ?? 'captain',
  });
  return { ok: true, task: next, hold: current };
}

export function cancelTask(service, teamId, taskId, { reason, actor } = {}) {
  if (!service.canActAsCaptain(teamId, actor)) {
    throw Object.assign(new Error('cancelling a task requires captain authority'), { status: 403, code: 'E_FORBIDDEN' });
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw Object.assign(new Error('task cancel requires a reason'), { status: 400, code: 'E_INVALID' });
  }
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  const tasks = service.store.listTasks(teamId);
  const ids = new Set([task.id]);
  // Cancel the delivery unit, its reviews/repairs, and direct dependants so
  // they cannot be dispatched against a cancelled artifact.
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of tasks) {
      if (ids.has(item.id)) continue;
      if ((item.deliveryUnitId && ids.has(item.deliveryUnitId))
        || (item.kind === 'review' && ids.has(item.reviewedTaskId))
        || (item.kind === 'repair' && ids.has(item.sourceTaskId))
        || (item.dependencies ?? []).some((dependency) => ids.has(dependency))) {
        ids.add(item.id);
        changed = true;
      }
    }
  }
  const cancelled = [];
  service.store.transaction(() => {
    for (const id of ids) {
      const current = service.store.getTask(id);
      if (!current || TERMINAL_STATUSES.has(current.status)) continue;
      if (current.attemptId) {
        service.store.updateAttempt(current.attemptId, {
          status: 'cancelled', endedAt: service.now(), error: `cancelled: ${reason}`,
        });
      }
      service.store.updateTask(id, {
        status: 'cancelled',
        attemptId: undefined,
        leaseExpiresAt: undefined,
        hold: undefined,
        reassigning: false,
        parked: false,
        cancelledAt: service.now(),
        cancelReason: reason,
        taskEpoch: (current.taskEpoch ?? 0) + 1,
        controlEpoch: service.store.getTeam(teamId)?.controlEpoch ?? 0,
        needsCaptain: false,
        ...(current.kind === 'review' ? { archived: true, archivedAt: service.now() } : {}),
      });
      cancelled.push(id);
    }
    service.store.addEvent(teamId, 'task.cancelled', {
      taskId, reason, actor: actor?.name ?? actor?.role ?? 'captain', cancelled,
    });
  });
  // A cancelled task's checkout is dead weight. Reclaim immediately when it
  // is clean; the reclaimer skips a dirty tree so uncommitted work survives.
  service.reclaimWorktrees().catch(() => {});
  return { ok: true, cancelled, task: service.store.getTask(taskId) };
}

export function reopenTask(service, teamId, taskId, { reason, actor } = {}) {
  if (!service.canActAsCaptain(teamId, actor)) {
    throw Object.assign(new Error('reopening a task requires captain authority'), { status: 403, code: 'E_FORBIDDEN' });
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw Object.assign(new Error('task reopen requires a reason'), { status: 400, code: 'E_INVALID' });
  }
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  const reopenableMerge = ['rejected', 'revert_failed', 'publication_unknown', 'ff_exhausted',
    'review_stale', 'review_pending_internal'].includes(task.mergeState)
    || task.postMergeReview === 'unknown';
  const reopenable = task.status === 'cancelled' || task.status === 'failed'
    || (task.status === 'completed' && reopenableMerge);
  if (!reopenable) {
    throw Object.assign(new Error('only cancelled, failed, rejected or recoverable publication-unknown tasks can be reopened'),
      { status: 409, code: 'E_STATE' });
  }
  if (task.legacyRepair === true || task.hold?.class === 'legacy_repair_manual') {
    // Quarantined pre-V15 repairs have no provable parent. Reopening the same
    // row would be quarantined again on the next boot; require a new task.
    throw Object.assign(new Error('a quarantined legacy repair must be recreated as a new repair, not reopened'),
      { status: 409, code: 'E_STATE' });
  }
  const next = service.store.transaction(() => {
    const tasks = service.store.listTasks(teamId);
    const team = service.store.getTeam(teamId);
    // A captain reopen is an explicit takeover of this task's publication.
    // Clear a matching guard before any row write: assertPublicationWritable
    // rejects every non-owner write while the guard is held.
    if (team?.publicationGuard?.taskId === task.id) {
      if (team.publicationGuard.state === 'publishing') {
        throw Object.assign(new Error('the task publication is still in progress; reconcile it before reopening'),
          { status: 409, code: 'E_PUBLICATION_HELD' });
      }
      service.store.updateTeam(teamId, { publicationGuard: undefined },
        { publicationOwner: team.publicationGuard.operationId });
      service.store.addEvent(teamId, 'merge.publication_guard_cleared_by_reopen', {
        taskId: task.id, operationId: team.publicationGuard.operationId, reason,
      });
    }
    // Repairs from the previous delivery generation must not survive as the
    // newest completed deliverable: that would block the reopened root with
    // newer_delivery_unreviewed even though its epoch was replaced. Walk the
    // whole repair/review chain: legacy roots predate deliveryUnitId, and a
    // failed re-review can create a second-generation repair whose
    // sourceTaskId points at the first repair rather than the root.
    const deliveryIds = new Set([task.id]);
    const reviewIds = new Set();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const item of tasks) {
        if (item.id === task.id) continue;
        if (item.kind === 'review') {
          if (item.reviewedTaskId && deliveryIds.has(item.reviewedTaskId) && !reviewIds.has(item.id)) {
            reviewIds.add(item.id);
            expanded = true;
          }
          continue;
        }
        if (deliveryIds.has(item.id) || !['repair', 'integration'].includes(item.kind)) continue;
        const linked = (item.sourceTaskId && deliveryIds.has(item.sourceTaskId))
          || (item.deliveryUnitId && deliveryIds.has(item.deliveryUnitId))
          || (item.parentIntegrationId && deliveryIds.has(item.parentIntegrationId))
          || (item.parentReviewTaskId && reviewIds.has(item.parentReviewTaskId))
          // Dependency-only links are for repairs. An unrelated unit's
          // integration can list this root as a dependency; archiving it
          // here would cancel another team's delivery.
          || (item.kind === 'repair' && Array.isArray(item.dependencies)
            && item.dependencies.some((dep) => deliveryIds.has(dep)));
        if (linked) {
          deliveryIds.add(item.id);
          expanded = true;
        }
      }
    }
    const oldRepairs = new Set([...deliveryIds].filter((id) => id !== task.id));
    // Archive the old reviews so a reopened epoch cannot reuse a pass from
    // the cancelled generation. Reviews of the old repairs must go with
    // them, otherwise deliveryAudit reports a review that references a
    // missing/historical task forever.
    for (const review of tasks) {
      if (review.kind !== 'review') continue;
      if (review.reviewedTaskId !== task.id && !oldRepairs.has(review.reviewedTaskId)) continue;
      const active = ['pending', 'claimed', 'in_progress'].includes(review.status);
      if (active && review.attemptId && service.store.getAttempt(review.attemptId)) {
        service.store.updateAttempt(review.attemptId, {
          status: 'cancelled', endedAt: service.now(), error: 'reopen',
        });
      }
      service.store.updateTask(review.id, {
        archived: true, archivedAt: review.archivedAt ?? service.now(), archivedReason: `reopen: ${reason}`,
        ...(oldRepairs.has(review.reviewedTaskId) ? { historical: true, superseded: true } : {}),
        ...(active ? { status: 'cancelled', cancelledAt: service.now(), cancelReason: 'reopen' } : {}),
      });
    }
    for (const id of oldRepairs) {
      const repair = tasks.find((item) => item.id === id);
      if (!repair) continue;
      const active = ['pending', 'claimed', 'in_progress'].includes(repair.status);
      if (active && repair.attemptId && service.store.getAttempt(repair.attemptId)) {
        service.store.updateAttempt(repair.attemptId, {
          status: 'cancelled', endedAt: service.now(), error: 'reopen',
        });
      }
      service.store.updateTask(repair.id, {
        archived: true, historical: true,
        archivedAt: repair.archivedAt ?? service.now(), archivedReason: `reopen: ${reason}`,
        ...(active ? { status: 'cancelled', cancelledAt: service.now(), cancelReason: 'reopen' } : {}),
      });
    }
    const reopened = service.store.updateTask(task.id, {
      status: 'pending',
      attemptId: undefined,
      leaseExpiresAt: undefined,
      cancelledAt: undefined,
      cancelReason: undefined,
      hold: undefined,
      needsCaptain: false,
      reopenedAt: service.now(),
      reopenReason: reason,
      reviewResultValid: false,
      // A reopened task must produce a fresh artifact. Keeping sourceCommit
      // let a completed work row skip closeout and publish the previous
      // commit after the member had already changed files.
      previousSourceCommit: task.sourceCommit ?? task.previousSourceCommit,
      previousSourceBase: task.sourceBase ?? task.previousSourceBase,
      // A repair must be rebuilt from the commit it reviews. Work and
      // implementation roots start a new generation from the current target
      // base; keeping the old sourceBase made dispatch use the new base while
      // commit/merge diffed from the old one.
      sourceBase: task.kind === 'repair' || task.kind === 'integration' ? task.sourceBase : undefined,
      sourceCommit: undefined,
      diffHash: undefined,
      changedPaths: undefined,
      noChanges: false,
      bindingState: undefined,
      ...(task.kind === 'review' ? {
        archived: false, archivedAt: undefined, archivedReason: undefined,
        superseded: false, historical: false, historyState: undefined,
      } : {}),
      integrationIntent: undefined,
      postMergeClaim: undefined,
      integrationBranch: undefined,
      integrationWorktree: undefined,
      integrationOwnership: undefined,
      // A reopened delivery is a new publication generation. Keeping the
      // previous post-merge verdict/claim/repair pointers makes
      // reviewMergeUnlocked return alreadyReviewed forever and leaves the
      // task stuck in review_pending after the new integration.
      postMergeReview: undefined,
      mergeReviewError: undefined,
      negativeMergeIntent: undefined,
      repairPlanPending: false,
      repairTaskId: undefined,
      ffAttempt: 0,
      integrationCommit: undefined,
      mergeReverted: false,
      mergeRevertedAt: undefined,
      publicationRecovery: undefined,
      publicationRecoveryState: undefined,
      cleanupPending: false,
      closedLoop: task.closedLoop
        ? { ...task.closedLoop, state: undefined, error: undefined, nextAction: undefined,
          deliveredBy: undefined, deliveredAt: undefined }
        : undefined,
      taskEpoch: (task.taskEpoch ?? 0) + 1,
      controlEpoch: team?.controlEpoch ?? 0,
      ...(reopenableMerge
        ? { mergeState: undefined, mergeCommit: undefined, mergedCommit: undefined, mergeReverted: false,
          mergeBlockReason: undefined, mergeError: undefined, reviewEvidence: undefined }
        : {}),
    });
    service.store.addEvent(teamId, 'task.reopened', {
      taskId, reason, actor: actor?.name ?? actor?.role ?? 'captain',
    });
    return reopened;
  });
  return { ok: true, task: next };
}
