import { evidenceBackedCompletion, planCompletionFanOut, planFailedReviewFollowUp } from '../domain/gates.mjs';
import { isInactiveHistory } from '../domain/delivery-review.mjs';
import { validateTaskGraph } from '../domain/scheduler.mjs';
import { isLeaseExpired } from '../domain/attempts.mjs';

const ACTIVE_STATUSES = new Set(['claimed', 'in_progress']);

/**
 * One closed-loop step for a task that just became terminal. The planner
 * reads the persisted task list, so the same call after a restart, after a
 * repeated tick, or after a review retry resolves to the same answer.
 * Each team serializes planning and application, including asynchronous steps.
 * @param {string} teamId
 * @param {any} task
 */
export async function withClosedLoopLock(service, teamId, action) {
  const previous = service.closedLoopLocks.get(teamId) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  service.closedLoopLocks.set(teamId, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (service.closedLoopLocks.get(teamId) === tail) service.closedLoopLocks.delete(teamId);
  }
}

export async function applyClosedLoop(service, teamId, task) {
  return service.withClosedLoopLock(teamId, async () => {
    const current = task?.id ? service.store.getTask(task.id) : undefined;
    return service.applyClosedLoopUnlocked(teamId, current);
  });
}

/**
 * Archive legacy reviews bound to an older source commit. The caller replans
 * immediately, so the task does not stop for a human merely because its
 * artifact changed after the review was written.
 */
export function supersedeLegacyReviews(service, teamId, task, plan) {
  return service.store.transaction(() => {
    const current = service.store.getTask(task.id);
    if (!current || current.teamId !== teamId || current.status !== 'completed'
      || current.sourceCommit !== plan.expectedSourceCommit) {
      return { ok: false, reason: 'legacy-review-source-changed-again' };
    }
    const candidates = [];
    for (const id of plan.staleReviewIds ?? []) {
      const review = service.store.getTask(id);
      if (!review || review.kind !== 'review' || review.reviewedTaskId !== task.id
        || isInactiveHistory(review)) continue;
      // A concurrent re-bind means this plan is stale. Abandon the whole
      // transaction instead of archiving a review that points at the new
      // commit.
      if (review.reviewedSourceCommit === plan.expectedSourceCommit) {
        return { ok: false, reason: 'legacy-review-binding-changed' };
      }
      const active = ['pending', 'claimed', 'in_progress'].includes(review.status);
      if (!active && !(review.status === 'completed' && review.verdict === 'pass')) {
        return { ok: false, reason: 'legacy-review-not-supersedable', reviewId: id };
      }
      candidates.push({ review, active });
    }
    const archived = [];
    const cancelled = [];
    for (const { review, active } of candidates) {
      if (active) {
        if (review.attemptId) {
          service.store.updateAttempt(review.attemptId, {
            status: 'cancelled', endedAt: service.now(), error: 'superseded legacy review',
          });
        }
        cancelled.push(review.id);
      }
      service.store.updateTask(review.id, {
        archived: true, superseded: true, archivedAt: service.now(),
        archivedReason: 'legacy-review-source-changed',
        ...(active ? { status: 'cancelled', cancelledAt: service.now(), cancelReason: 'stale_binding',
          historical: true } : {}),
      });
      archived.push(review.id);
    }
    service.store.addEvent(teamId, 'loop.legacy_reviews_superseded', {
      taskId: task.id, archived, cancelled, expectedSourceCommit: plan.expectedSourceCommit,
    });
    return { ok: true, archived, cancelled };
  });
}

export async function applyClosedLoopUnlocked(service, teamId, task) {
  if (!task || task.teamId !== teamId) return { created: [], escalated: 0 };
  const policy = service.config.quality.reviewPolicy ?? {};
  if (task.status === 'completed' && (task.kind === 'implementation' || task.kind === 'repair')) {
    // One pass creates every independent follow-up: review, verification
    // when the task asks for one, and a repair of already-reported findings.
    let plan = planCompletionFanOut({
      task,
      tasks: service.store.listTasks(teamId),
      members: service.store.listMembers(teamId),
      policy,
    });
    if (plan.action === 'supersede_legacy_reviews'
      || (Array.isArray(plan.staleReviewIds) && plan.staleReviewIds.length > 0)) {
      const superseded = service.supersedeLegacyReviews(teamId, task, plan);
      if (!superseded.ok) {
        const escalated = service.escalateClosedLoop(teamId, task, { reason: superseded.reason });
        return { created: [], escalated: escalated.escalated, action: 'escalate' };
      }
      plan = planCompletionFanOut({
        task: service.store.getTask(task.id),
        tasks: service.store.listTasks(teamId),
        members: service.store.listMembers(teamId),
        policy,
      });
    }
    const created = service.createLoopTasks(teamId, plan.created ?? [], task);
    const escalated = created.escalated + (plan.action === 'escalate' || plan.needsCaptain === true
      ? service.escalateClosedLoop(teamId, task, plan).escalated
      : 0);
    if (created.created.length === 0 && escalated === 0) {
      return { created: [], escalated: 0, skipped: plan.reason };
    }
    return { created: created.created, escalated, action: plan.action };
  }
  if (task.kind === 'review' && (task.status === 'failed'
    || (task.status === 'completed' && task.verdict !== 'pass'))) {
    const plan = planFailedReviewFollowUp({
      task,
      tasks: service.store.listTasks(teamId),
      members: service.store.listMembers(teamId),
      policy,
    });
    for (const warning of plan.warnings ?? []) {
      service.store.addEvent(teamId, 'gate.repair_warning', { taskId: task.id, warning });
    }
    if (plan.deduplicated) {
      service.store.addEvent(teamId, 'gate.repair_deduplicated', { taskId: task.id, reason: plan.reason });
    }
    if (plan.action === 'repair') {
      service.store.addEvent(teamId, 'gate.repair', {
        taskId: plan.task.id,
        sourceTaskId: plan.task.sourceTaskId ?? task.id,
        ...(plan.task.scopeSource ? { scopeSource: plan.task.scopeSource } : {}),
      });
      return service.createLoopTask(teamId, plan.task, 'loop.repair_created', task);
    }
    if (plan.action === 'escalate' || plan.needsCaptain === true) return service.escalateClosedLoop(teamId, task, plan);
    if (plan.action === 'link') {
      // A human already opened a repair for this source; record the link
      // once and let that repair's completion create the re-review.
      service.store.updateTask(task.id, {
        closedLoop: {
          ...(task.closedLoop ?? {}),
          state: 'manual-repair',
          repairTaskId: plan.existingTaskId,
          round: plan.round ?? task.round ?? 1,
          linkedAt: service.now(),
        },
      });
      service.store.addEvent(teamId, 'loop.manual_repair', {
        taskId: task.id, repairTaskId: plan.existingTaskId, round: plan.round ?? task.round ?? 1,
      });
      return { created: [], escalated: 0, state: 'manual-repair' };
    }
    return { created: [], escalated: 0, skipped: plan.reason };
  }
  return { created: [], escalated: 0, skipped: 'not-in-loop' };
}

/**
 * Create several planned follow-ups in dependency order. Each row is created
 * independently: a failure on one (say a member cap) is recorded and does not
 * drop the others, because they run in parallel.
 * @param {string} teamId
 * @param {Array<any>} planned
 * @param {any} anchorTask
 */
export function createLoopTasks(service, teamId, planned, anchorTask) {
  if (planned.length === 0) return { created: [], escalated: 0 };
  // Validate the whole batch against the persisted graph before creating any
  // row. Per-row addTask validation can leave half a fan-out behind when a
  // later row is invalid; V15 B48 requires one atomic planning decision.
  const existing = service.store.listTasks(teamId);
  const existingIds = new Set(existing.map((task) => task.id));
  const batch = planned.filter((task) => !existingIds.has(task.id));
  const errors = validateTaskGraph([...existing, ...batch], service.store.listMembers(teamId), {
    teamIds: [teamId],
    requiredReviewers: service.config.quality.reviewPolicy.requiredReviewers ?? [],
    allowUnassigned: Boolean(service.features.lazyMembers),
  });
  if (errors.length > 0) {
    const reason = `planned follow-up batch is invalid: ${errors.join('; ')}`;
    const escalated = service.escalateClosedLoop(teamId, anchorTask, { reason });
    return { created: [], escalated: escalated.escalated, error: reason };
  }
  const created = [];
  let escalated = 0;
  let failed = false;
  for (const item of planned) {
    if (failed) break;
    const result = service.createLoopTask(teamId, item, service.loopEventFor(item), anchorTask);
    created.push(...result.created);
    escalated += result.escalated;
    // Never create a dependent follow-up after its prerequisite failed. The
    // planner will retry the whole batch on the next reconcile.
    if (result.error) failed = true;
  }
  return { created, escalated, ...(failed ? { error: 'follow-up batch stopped after a create failure' } : {}) };
}

export function loopEventFor(service, task) {
  if (task?.kind === 'review') return 'loop.review_created';
  if (task?.kind === 'verification') return 'loop.verify_created';
  return 'loop.repair_created';
}

export function createLoopTask(service, teamId, planned, eventType, anchorTask) {
  const task = { ...planned };
  if (!task.assignee && !service.features.lazyMembers) {
    try {
      const member = service.materializeMember(teamId, { role: task.assigneeRole ?? service.roleForTask(task) });
      task.assignee = member.name;
      task.assigneeId = member.id;
    } catch (error) {
      // The task stays visible and unassigned; the captain gets the reason
      // instead of a silent dead end.
      service.store.addEvent(teamId, 'loop.assignee_failed', {
        taskId: task.id,
        role: task.assigneeRole,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    const created = service.addTask(teamId, task, { internal: true });
    service.store.addEvent(teamId, eventType, {
      taskId: created.id,
      kind: created.kind,
      sourceTaskId: created.reviewedTaskId ?? created.sourceTaskId,
      round: created.round,
      assignee: created.assignee,
      findingSourceTaskIds: created.findingSourceTaskIds,
    });
    return { created: [created], escalated: 0, state: created.kind };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    service.store.addEvent(teamId, 'loop.create_failed', { taskId: task.id, kind: task.kind, error: message });
    const escalated = service.escalateClosedLoop(teamId, anchorTask ?? task, {
      reason: `cannot create ${task.kind} ${task.id}: ${message}`,
      round: task.round,
    });
    return { created: [], escalated: escalated.escalated, error: message };
  }
}

export function escalateClosedLoop(service, teamId, task, { reason, round, findings } = {}) {
  if (!task?.id) return { created: [], escalated: 0 };
  const current = service.store.getTask(task.id);
  if (!current) return { created: [], escalated: 0, skipped: 'unknown-task' };
  if (current.closedLoop?.state === 'escalated') {
    if (current.needsCaptain !== true) service.store.updateTask(current.id, { needsCaptain: true });
    if (service.store.getTeam(teamId)?.needsCaptain !== true) service.store.updateTeam(teamId, { needsCaptain: true });
    return { created: [], escalated: 0, skipped: 'already-escalated' };
  }
  const member = current.assignee ? service.store.findMember(teamId, current.assignee) : undefined;
  const list = (Array.isArray(findings) ? findings : current.findings ?? []).filter((finding) => !finding?.resolved);
  const lines = list.slice(0, 20).map((finding, index) => (
    `${index + 1}. [${finding.severity}] ${finding.problem} (file: ${finding.file ?? 'n/a'}; fix: ${finding.requiredFix})`
  ));
  const roundValue = round ?? current.round ?? 1;
  const content = [
    `Closed loop stopped: ${reason}`,
    `taskId: ${current.id}`,
    `subject: ${current.subject ?? current.id}`,
    `kind: ${current.kind ?? 'work'}`,
    `round: ${roundValue}`,
    `sessionId: ${member?.sessionId ?? '(none)'}`,
    `assignee: ${current.assignee ?? '(unassigned)'}`,
    `sourceTaskId: ${current.reviewedTaskId ?? current.sourceTaskId ?? '(none)'}`,
    `findings (${list.length}):`,
    ...(lines.length > 0 ? lines : ['(none)']),
    'Action: review the chain, then reassign, continue manually, or close it. Automatic repair will not restart by itself.',
  ].join('\n');
  let message;
  try {
    message = service.sendMessage(teamId, 'closed-loop', 'captain', content, {
      taskId: current.id,
      attemptId: current.lastAttemptId,
      urgent: true,
    });
  } catch (error) {
    service.store.addEvent(teamId, 'loop.escalation_message_failed', {
      taskId: current.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  service.store.updateTask(current.id, {
    needsCaptain: true,
    closedLoop: {
      ...(current.closedLoop ?? {}),
      state: 'escalated',
      round: roundValue,
      reason,
      escalatedAt: service.now(),
      messageId: message?.id,
    },
  });
  service.store.updateTeam(teamId, { needsCaptain: true });
  service.store.addEvent(teamId, 'loop.escalated', {
    taskId: current.id,
    round: roundValue,
    reason,
    messageId: message?.id,
    findings: list.length,
  });
  return { created: [], escalated: 1, state: 'escalated', messageId: message?.id };
}

/**
 * Re-scan a team for closed-loop gaps: a completed implementation/repair
 * without a review, or a failed review without a repair and without an
 * escalation. Runs on every tick and after a restart; creation is idempotent
 * because the task ids are deterministic and existing rows win.
 * @param {string} teamId
 */
export async function reconcileClosedLoop(service, teamId) {
  return service.withClosedLoopLock(teamId, () => service.reconcileClosedLoopUnlocked(teamId));
}

export async function reconcileClosedLoopUnlocked(service, teamId) {
  const team = service.store.getTeam(teamId);
  if (!team || team.phase === 'staged' || team.phase === 'archived' || team.control !== 'active') {
    return { created: 0, escalated: 0, skipped: 'team-not-active' };
  }
  if (service.store.getPublicationGuard(teamId)) {
    const adoption = await service.adoptPendingCandidatesUnlocked([team]);
    return { created: 0, escalated: 0, skipped: 'publication-held', adoption };
  }
  const adoption = await service.adoptPendingCandidatesUnlocked([team]);
  // A deferred retry is deliberately silent: the next scheduler tick is
  // expected, not a new sweep worth adding to the event table. Emit only
  // when adoption actually changed state or produced a captain-visible block.
  const newlyBlocked = adoption.blocked.some((taskId) => !adoption.deferred.includes(taskId));
  if (adoption.adopted.length > 0 || newlyBlocked) {
    service.store.addEvent(teamId, 'loop.adoption_sweep', {
      adopted: adoption.adopted.length, blocked: adoption.blocked.length,
      deferred: adoption.deferred.length,
    });
  }
  let created = 0;
  let escalated = 0;
  service.reconcilePostMergeRepairs(teamId);
  for (const task of service.store.listTasks(teamId)) {
    if (task.hidden === true) continue;
    const kind = task.kind ?? 'work';
    const inLoop = (task.status === 'completed' && (kind === 'implementation' || kind === 'repair'))
      || (kind === 'review' && (task.status === 'failed'
        || (task.status === 'completed' && task.verdict !== 'pass')));
    if (!inLoop) continue;
    const result = await service.applyClosedLoopUnlocked(teamId, service.store.getTask(task.id));
    created += result.created.length;
    escalated += result.escalated;
  }
  return { created, escalated };
}

/**
 * Recover work whose member session went idle or dropped after the evidence
 * was already recorded, instead of failing or stalling a task that is in
 * fact done. A missing session or expired lease only triggers consideration;
 * attempt-specific termination proof is required before recovery. Completion
 * still goes through the daemon-owned verify gate and the closed loop.
 * @param {string} teamId
 * @returns {Promise<string[]>} recovered task ids
 */
export async function recoverEvidenceBackedTasks(service, teamId) {
  const recovered = [];
  for (const task of service.store.listTasks(teamId)) {
    if (!ACTIVE_STATUSES.has(task.status) || !task.attemptId) continue;
    const member = task.assignee ? service.store.findMember(teamId, task.assignee) : undefined;
    const sessionGone = !member?.sessionId;
    const leaseExpired = isLeaseExpired(task, service.now());
    if (!sessionGone && !leaseExpired) continue;
    // Expiry or a missing local ID is not proof that the previous runtime
    // lost the ability to write. Recovery needs an attempt-specific proof.
    if (member?.sessionTerminationConfirmedAttemptId !== task.attemptId) continue;
    const evidence = evidenceBackedCompletion(task);
    if (!evidence.ok) {
      service.store.addEvent(teamId, 'loop.recovery_skipped', {
        taskId: task.id,
        reason: evidence.reason,
        sessionGone,
        leaseExpired,
      });
      continue;
    }
    const result = await service.completeTask({
      teamId,
      taskId: task.id,
      attemptId: task.attemptId,
      update: {
        ...evidence.update,
        evidence_note: 'recovered from recorded evidence after the member session went idle or dropped',
      },
    });
    if (result?.ok && result.task?.status === 'completed') {
      recovered.push(task.id);
      service.store.addEvent(teamId, 'loop.recovered', {
        taskId: task.id,
        reason: sessionGone ? 'session-gone' : 'lease-expired',
        changedPaths: evidence.update.changedPaths ?? [],
      });
    } else {
      service.store.addEvent(teamId, 'loop.recovery_rejected', {
        taskId: task.id,
        error: result?.error ?? 'completion rejected',
      });
    }
  }
  return recovered;
}

