// Automatic red-box review lifecycle extracted from SchedulerService.
// TeamService supplies persistence, authorization, task continuation, and scheduling adapters.
import {
  CONTINUE_CAPABILITY,
  RED_REVIEW_ACTOR,
  RED_REVIEW_EXCLUDED_KINDS,
  RED_REVIEW_KIND,
  RED_REVIEW_PURPOSE,
  isRetryableRedReviewError,
  redReviewEscalationText,
  redReviewKey,
  redReviewTaskId,
  validateTaskGraph,
} from '../domain/scheduler.mjs';

const RED_REVIEW_CREATE_FAILURE_EVENT_MS = 60000;

function canRunRedReview(service, teamId) {
  const team = service.store.getTeam(teamId);
  return Boolean(team && team.control === 'active' && !['staged', 'archived'].includes(team.phase));
}

function reopenRedReview(service, teamId, review) {
  const reopened = service.store.updateTask(review.id, {
    status: 'in_progress',
    outcome: undefined,
    // Halt is a pause, not a new failure or a fresh retry budget.
    ...(review.status === 'cancelled' ? { retryAt: undefined, redReviewAttempts: 0, lastRedReviewError: undefined } : {}),
    completedAt: undefined,
    archivedAt: undefined,
    closedAt: undefined,
  });
  service.store.addEvent(teamId, 'red_review.reopened', { reviewTaskId: review.id, taskId: review.reviewedTaskId });
  return reopened;
}

/** @param {any} service @param {string} teamId @param {string} taskId */
export function onTaskFailed(service, teamId, taskId) {
  if (service.redReview.enabled !== true) return undefined;
  const task = service.store.getTask(taskId);
  if (!task || task.status !== 'failed') return undefined;
  // A hidden row is history, not a live red box: legacy smoke/retry copies
  // must not be resurrected by a restart sweep.
  if (task.hidden === true) return undefined;
  if (RED_REVIEW_EXCLUDED_KINDS.has(task.kind)) return undefined;
  if (task.redReviewEscalated === true) return undefined;
  return service.ensureRedReview(teamId, task);
}

/** @param {any} service @param {string} teamId @param {any} task @param {{ autoRun?: boolean }} [options] */
export function ensureRedReview(service, teamId, task, options = {}) {
  if (!task || task.hidden === true) return undefined;
  if (!task?.id || task.status !== 'failed' || RED_REVIEW_EXCLUDED_KINDS.has(task.kind)) return undefined;
  const key = redReviewKey(task);
  const id = redReviewTaskId(key);
  const existing = service.store.getTask(id);
  if (existing) {
    if (!['pending', 'cancelled'].includes(existing.status) || !canRunRedReview(service, teamId)) return existing;
    // Halt makes daemon-owned rows pending too; recover the same failure id.
    const reopened = reopenRedReview(service, teamId, existing);
    if (options.autoRun !== false) service.scheduleRedReview(teamId, id);
    return reopened;
  }
  const failedAttempt = task.lastAttemptId ?? task.attemptId;
  let created;
  try {
    created = service.addRedReviewTask(teamId, {
      id,
      subject: 'Automatic continue review',
      kind: RED_REVIEW_KIND,
      // Executed by the daemon: no assignee, no worker slot, no attempt.
      status: 'in_progress',
      dependencies: [],
      objective: `Send the literal continue token to failed task ${task.id}.`,
      acceptance: [
        `Failed task ${task.id} receives the continue token.`,
        'Do not review code, create implementation tasks, or change the subject.',
        `Report to the captain after ${service.redReview.maxContinues} consecutive failures.`,
      ],
      autoReview: true,
      hidden: true,
      reviewedTaskId: task.id,
      sourceTaskId: task.id,
      reviewedAttemptId: failedAttempt,
      redReviewKey: key,
      redReviewAttempts: 0,
      executor: RED_REVIEW_ACTOR,
    });
  } catch (error) {
    const raced = service.store.getTask(id);
    if (raced) return raced;
    const message = error instanceof Error ? error.message : String(error);
    service.redReviewCreateFailures.set(id, { taskId: task.id, error: message, at: service.now() });
    service.recordRedReviewCreateFailure(teamId, id, task.id, message);
    return undefined;
  }
  service.redReviewCreateFailures.delete(id);
  service.store.updateTask(task.id, { redReviewKey: key, redReviewTaskId: created.id });
  service.store.addEvent(teamId, 'red_review.created', {
    reviewTaskId: created.id,
    taskId: task.id,
    attemptId: failedAttempt,
    continueCount: Number(task.redContinueCount ?? 0),
    maxContinues: service.redReview.maxContinues,
  });
  if (options.autoRun !== false) service.scheduleRedReview(teamId, created.id);
  return created;
}

/** @param {any} service @param {string} teamId @param {any} input */
export function addRedReviewTask(service, teamId, input) {
  const task = {
    status: 'in_progress',
    dependencies: [],
    createdAt: service.now(),
    ...input,
    teamId,
  };
  const errors = validateTaskGraph([task], [], { teamIds: [teamId], allowUnassigned: true });
  if (errors.length > 0) throw new Error(`invalid red review task: ${errors.join('; ')}`);
  const created = service.store.addTask(task);
  service.store.addEvent(teamId, 'task.created', { taskId: created.id, kind: created.kind ?? 'work' });
  return created;
}

/** @param {any} service @param {string} teamId @param {string} reviewId @param {string} taskId @param {string} message */
export function recordRedReviewCreateFailure(service, teamId, reviewId, taskId, message) {
  const now = service.now();
  const last = service.redReviewCreateFailureAt.get(reviewId);
  if (last !== undefined && now - last < RED_REVIEW_CREATE_FAILURE_EVENT_MS) return;
  service.redReviewCreateFailureAt.set(reviewId, now);
  service.store.addEvent(teamId, 'red_review.create_failed', { taskId, reviewTaskId: reviewId, error: message });
}

/** @param {any} service @param {string} teamId @param {string} reviewId @param {{ force?: boolean }} [options] */
export function scheduleRedReview(service, teamId, reviewId, options = {}) {
  if (service.redReviewInFlight.has(reviewId)) return service.redReviewJobs.get(reviewId);
  service.redReviewInFlight.add(reviewId);
  const job = Promise.resolve()
    .then(() => service.runRedReview(teamId, reviewId, options))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        service.store.addEvent(teamId, 'red_review.error', { reviewTaskId: reviewId, error: message });
        const review = service.store.getTask(reviewId);
        if (review && review.status === 'in_progress') service.finishRedReview(teamId, review, 'error', { error: message });
        return service.store.getTask(reviewId);
      } catch {
        // The store can already be closed while the daemon shuts down. The
        // review row stays open and the next start's sweep resumes it.
        return undefined;
      }
    })
    .finally(() => {
      service.redReviewInFlight.delete(reviewId);
      service.redReviewJobs.delete(reviewId);
    });
  service.redReviewJobs.set(reviewId, job);
  return job;
}

/** @param {any} service @returns {Promise<Array<PromiseSettledResult<any>>>} */
export async function awaitRedReviews(service) {
  return Promise.allSettled([...service.redReviewJobs.values()]);
}

export function redReviewActorFor(service, teamId, contractorId) {
  if (!contractorId) return { role: 'admin', name: RED_REVIEW_ACTOR, system: true };
  const contractor = service.store.getContractor(contractorId);
  if (!contractor || contractor.teamId !== teamId) return undefined;
  return { role: 'contractor', contractorId, teamId, name: `contractor:${contractorId}` };
}

export async function runRedReview(service, teamId, reviewId, options = {}) {
  const review = service.store.getTask(reviewId);
  if (!review || review.kind !== RED_REVIEW_KIND) return review;
  if (!canRunRedReview(service, teamId) || review.status !== 'in_progress') return review;
  if (!options.force && typeof review.retryAt === 'number' && review.retryAt > service.now()) return review;
  const task = review.reviewedTaskId ? service.store.getTask(review.reviewedTaskId) : undefined;
  if (!task) return service.finishRedReview(teamId, review, 'missing-source');
  if (task.status !== 'failed') {
    // The continue opened the next attempt but was deferred: the turn layer
    // owns delivery now. Keep this row open; continueOneTask closes it when
    // the "继续" actually reaches the session.
    if (task.status === 'in_progress' && task.pendingRedReviewId === reviewId) {
      service.store.updateTask(reviewId, { retryAt: service.now() + Math.max(0, Number(service.redReview.retryDelayMs) || 0) });
      return service.store.getTask(reviewId);
    }
    return service.finishRedReview(teamId, review, 'source-active');
  }

  const member = task.assignee ? service.store.findMember(teamId, task.assignee) : undefined;
  // Compare against the live member session: a rebuilt session starts a new
  // per-session budget even if the failed attempt still carries the old id.
  const sessionId = member?.sessionId ?? task.lastSessionId;
  const sameSession = !task.redContinueSessionId || !sessionId || task.redContinueSessionId === sessionId;
  const count = sameSession ? Number(task.redContinueCount ?? 0) : 0;

  if (task.redReviewEscalated === true) {
    // Another review for this task already reported to the captain; close
    // this row without a second message.
    return service.finishRedReview(teamId, review, 'escalated', {
      continueCount: count,
      escalationReason: task.redEscalatedReason ?? 'already escalated',
      reported: false,
    });
  }
  if (count >= Number(service.redReview.maxContinues)) {
    return service.escalateRedReview(teamId, review, task, {
      count,
      sessionId,
      reason: `reached ${count} automatic continues`,
    });
  }

  // An explicit actor (contractor or a caller-supplied identity) must pass the
  // same permission gate as a manual continue. A plain member never does.
  const actor = options.actor ?? service.redReviewActorFor(teamId, options.contractorId ?? review.contractorId);
  if (!actor || !service.canContinueTask(teamId, actor)) {
    service.store.addEvent(teamId, 'red_review.denied', {
      reviewTaskId: reviewId,
      taskId: task.id,
      actor: actor?.name ?? options.contractorId ?? RED_REVIEW_ACTOR,
    });
    return service.finishRedReview(teamId, review, 'denied', { deniedActor: actor?.name ?? null });
  }

  try {
    const result = await service.continueTask(teamId, task.id, {
      actor,
      reason: `automatic red review (${reviewId})`,
      redReviewId: reviewId,
    });
    if (result?.sent === false) {
      // The task was requeued but the "继续" never reached the session (the
      // prompt is still running, the cursor is unavailable, the session was
      // lost). Counting it would fabricate "three automatic continues" that
      // never happened and could report a false escalation.
      return service.deferRedReview(teamId, review, task, {
        count,
        sessionId,
        error: result?.warning ?? 'continue was not sent',
      });
    }
    // continueTask delegates the actual send to continueOneTask, which owns the
    // single delivery receipt and closes this review only after the send succeeds.
    return service.store.getTask(reviewId);
  } catch (error) {
    const current = service.store.getTask(reviewId);
    if (!canRunRedReview(service, teamId) || current?.status !== 'in_progress') return current;
    const message = error instanceof Error ? error.message : String(error);
    const attempts = Number(current.redReviewAttempts ?? 0) + 1;
    if (isRetryableRedReviewError(error) && attempts < Number(service.redReview.maxAttempts)) {
      const retryAt = service.now() + Math.max(0, Number(service.redReview.retryDelayMs) || 0);
      service.store.updateTask(reviewId, { redReviewAttempts: attempts, retryAt, lastRedReviewError: message });
      service.store.addEvent(teamId, 'red_review.deferred', {
        reviewTaskId: reviewId,
        taskId: task.id,
        attempts,
        retryAt,
        error: message,
      });
      return service.store.getTask(reviewId);
    }
    service.store.addEvent(teamId, 'red_review.failed', {
      reviewTaskId: reviewId,
      taskId: task.id,
      attempts,
      error: message,
      errorCode: error?.code,
    });
    return service.escalateRedReview(teamId, review, service.store.getTask(task.id) ?? task, {
      count,
      sessionId,
      reason: `automatic continue failed: ${message}`,
      error: message,
    });
  }
}

/**
 * Record the review only after the queued continue reaches the member session.
 * @param {any} service
 * @param {string} teamId
 * @param {any} task
 * @param {string} reviewId
 * @param {string} sessionId
 * @param {string} actor
 * @returns {any}
 */
export function recordRedReviewDelivery(service, teamId, task, reviewId, sessionId, actor) {
  const count = Number(task.redContinueCount ?? 0) + 1;
  service.store.updateTask(task.id, {
    redContinueCount: count,
    redContinueSessionId: sessionId,
    redReviewKey: task.redReviewKey,
    redReviewTaskId: reviewId,
    lastRedReviewAt: service.now(),
    lastRedReviewBy: actor,
  });
  service.store.addEvent(teamId, 'red_review.continued', {
    reviewTaskId: reviewId,
    taskId: task.id,
    count,
    maxContinues: Number(service.redReview.maxContinues),
    sessionId,
    sent: true,
    actor,
  });
  const review = service.store.getTask(reviewId);
  if (review?.status === 'in_progress') service.finishRedReview(teamId, review, 'continued', { continueCount: count });
  return count;
}

export function deferRedReview(service, teamId, review, task, details = {}) {
  const current = service.store.getTask(review.id) ?? review;
  if (!canRunRedReview(service, teamId) || current.status !== 'in_progress') return current;
  const message = String(details.error ?? 'continue was not sent');
  const attempts = Number(current.redReviewAttempts ?? 0) + 1;
  if (attempts >= Number(service.redReview.maxAttempts)) {
    service.store.addEvent(teamId, 'red_review.failed', {
      reviewTaskId: review.id,
      taskId: task.id,
      attempts,
      error: message,
      errorCode: 'E_NOT_SENT',
    });
    return service.escalateRedReview(teamId, current, task, {
      count: details.count,
      sessionId: details.sessionId,
      reason: `automatic continue not delivered: ${message}`,
      error: message,
    });
  }
  const retryAt = service.now() + Math.max(0, Number(service.redReview.retryDelayMs) || 0);
  service.store.updateTask(review.id, { redReviewAttempts: attempts, retryAt, lastRedReviewError: message });
  service.store.addEvent(teamId, 'red_review.deferred', {
    reviewTaskId: review.id,
    taskId: task.id,
    attempts,
    retryAt,
    reason: 'not-sent',
    error: message,
  });
  return service.store.getTask(review.id);
}

export function escalateRedReview(service, teamId, review, task, details = {}) {
  const current = service.store.getTask(review.id) ?? review;
  if (!canRunRedReview(service, teamId) || current.status !== 'in_progress') return current;
  const count = Number(details.count ?? task.redContinueCount ?? 0);
  const sessionId = details.sessionId ?? task.lastSessionId;
  const error = details.error ?? task.lastTurnError ?? task.error;
  const text = redReviewEscalationText({
    taskId: task.id,
    subject: task.subject,
    error,
    count,
    sessionId,
    reason: details.reason,
  });
  let message;
  try {
    message = service.sendMessage(teamId, RED_REVIEW_ACTOR, 'captain', text, { taskId: task.id, attemptId: task.lastAttemptId, urgent: true });
  } catch (sendError) {
    service.store.addEvent(teamId, 'red_review.report_failed', {
      reviewTaskId: review.id,
      taskId: task.id,
      error: sendError instanceof Error ? sendError.message : String(sendError),
    });
  }
  service.store.updateTask(task.id, {
    redReviewEscalated: true,
    redEscalatedAt: service.now(),
    redEscalatedReason: details.reason,
    redEscalatedCount: count,
    redEscalatedMessageId: message?.id,
  });
  service.store.addEvent(teamId, 'task.red_escalated', {
    taskId: task.id,
    count,
    sessionId,
    messageId: message?.id,
    reason: details.reason,
  });
  service.store.addEvent(teamId, 'red_review.escalated', {
    reviewTaskId: review.id,
    taskId: task.id,
    count,
    maxContinues: Number(service.redReview.maxContinues),
    sessionId,
    messageId: message?.id,
    reason: details.reason,
  });
  return service.finishRedReview(teamId, current, 'escalated', {
    continueCount: count,
    escalationMessageId: message?.id,
    escalationReason: details.reason,
  });
}

export function finishRedReview(service, teamId, review, outcome, extra = {}) {
  const now = service.now();
  const next = service.store.updateTask(review.id, {
    ...extra,
    status: 'completed',
    hidden: true,
    outcome,
    retryAt: undefined,
    attemptId: undefined,
    leaseExpiresAt: undefined,
    completedAt: now,
    archivedAt: now,
    closedAt: now,
  });
  service.store.addEvent(teamId, 'red_review.completed', {
    reviewTaskId: review.id,
    reviewedTaskId: review.reviewedTaskId,
    outcome,
    ...(extra.error ? { error: extra.error } : {}),
  });
  return next;
}

export function sweepRedReviews(service, teamId) {
  if (service.redReview.enabled !== true || !canRunRedReview(service, teamId)) return 0;
  const tasks = service.store.listTasks(teamId);
  const keys = new Set();
  for (const task of tasks) {
    // Legacy cancelled rows do not count as a handled failure event.
    if (task.kind === RED_REVIEW_KIND && task.redReviewKey && task.status !== 'cancelled') keys.add(task.redReviewKey);
  }
  let started = 0;
  const now = service.now();
  for (const task of tasks) {
    if (task.kind === RED_REVIEW_KIND) {
      // Restore daemon ownership synchronously, even while backoff is pending.
      const review = task.status === 'pending' ? reopenRedReview(service, teamId, task) : task;
      if (review.status !== 'in_progress') continue;
      if (service.redReviewInFlight.has(task.id)) continue;
      if (typeof review.retryAt === 'number' && review.retryAt > now) continue;
      service.scheduleRedReview(teamId, task.id, { force: true });
      started += 1;
      continue;
    }
    if (task.status !== 'failed' || task.redReviewEscalated === true) continue;
    // Hidden rows are history (legacy retry copies, smoke tasks); a restart
    // sweep must not revive them as fresh work.
    if (task.hidden === true) continue;
    // Gate kinds repair through their own round-based flow (SPEC 5.4).
    if (RED_REVIEW_EXCLUDED_KINDS.has(task.kind)) continue;
    const key = redReviewKey(task);
    if (keys.has(key)) continue;
    if (!service.ensureRedReview(teamId, task)) continue;
    keys.add(key);
    started += 1;
  }
  return started;
}

export function redReviewSummary(service, teamId) {
  const reviews = service.store.listTasks(teamId).filter((task) => task.kind === RED_REVIEW_KIND);
  const byOutcome = {};
  for (const review of reviews) {
    const key = review.outcome ?? (review.status === 'in_progress' ? 'running' : review.status);
    byOutcome[key] = (byOutcome[key] ?? 0) + 1;
  }
  const last = reviews
    .slice()
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))[0];
  const failures = [...service.redReviewCreateFailures.values()]
    .filter((failure) => service.store.getTask(failure.taskId)?.teamId === teamId);
  const lastFailure = failures.slice().sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))[0];
  return {
    enabled: service.redReview.enabled === true,
    maxContinues: Number(service.redReview.maxContinues),
    total: reviews.length,
    running: reviews.filter((review) => review.status === 'in_progress').length,
    escalated: reviews.filter((review) => review.outcome === 'escalated').length,
    byOutcome,
    // A review that could not be created is not silent: the captain sees the
    // count and the last error instead of an empty, healthy-looking summary.
    createFailures: failures.length,
    lastCreateError: lastFailure?.error,
    last: last
      ? {
        reviewTaskId: last.id,
        taskId: last.reviewedTaskId,
        outcome: last.outcome ?? last.status,
        at: last.createdAt,
      }
      : undefined,
  };
}

export function hasRedReviewPurpose(contractorOrPurpose) {
  const purpose = typeof contractorOrPurpose === 'string'
    ? contractorOrPurpose
    : contractorOrPurpose?.purpose;
  return String(purpose ?? '').split(':')[0] === RED_REVIEW_PURPOSE;
}

export function contractorCanRedReview(contractor) {
  if (!contractor) return false;
  if (hasRedReviewPurpose(contractor)) return true;
  const capabilities = Array.isArray(contractor.capabilities) ? contractor.capabilities : [];
  return capabilities.includes(CONTINUE_CAPABILITY);
}

export async function runContractorRedReview(service, teamId, contractor) {
  const id = contractor.id;
  const latest = service.store.getContractor(id);
  if (!latest || ['killed', 'cancelled', 'orphaned'].includes(latest.status)) return latest;
  service.store.updateContractor(id, { status: 'running', startedAt: service.now() });
  service.store.addEvent(teamId, 'contractor.started', { contractorId: id, slot: contractor.slot, purpose: contractor.purpose });
  try {
    const review = service.store.listTasks(teamId)
      .filter((task) => task.kind === RED_REVIEW_KIND && task.status === 'in_progress')
      .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))[0];
    if (!review) {
      const idle = service.store.updateContractor(id, { status: 'completed', result: 'no pending red review', endedAt: service.now() });
      service.store.addEvent(teamId, 'contractor.completed', { contractorId: id, slot: contractor.slot, purpose: contractor.purpose, outcome: 'idle' });
      return idle;
    }
    service.store.updateContractor(id, { redReviewTaskId: review.id });
    // Never run the same review twice: if the daemon already has a job for
    // this row, wait for it instead of racing a second "继续".
    const result = service.redReviewInFlight.has(review.id)
      ? await (service.redReviewJobs.get(review.id) ?? Promise.resolve())
      : await service.runRedReview(teamId, review.id, { contractorId: id, force: true });
    const after = service.store.getContractor(id);
    if (after?.cancelRequested || after?.status === 'cancelling') {
      service.store.addEvent(teamId, 'contractor.killed', { contractorId: id, slot: contractor.slot });
      return service.store.updateContractor(id, { status: 'killed', endedAt: service.now() });
    }
    const settled = service.store.getTask(review.id) ?? result;
    const outcome = settled?.outcome
      ?? (settled?.status === 'in_progress' ? 'deferred' : settled?.status)
      ?? 'noop';
    const done = service.store.updateContractor(id, {
      status: 'completed', result: `red review ${review.id}: ${outcome}`, endedAt: service.now(),
    });
    service.store.addEvent(teamId, 'contractor.completed', {
      contractorId: id, slot: contractor.slot, purpose: contractor.purpose, outcome, reviewTaskId: review.id,
    });
    return done;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    service.store.addEvent(teamId, 'contractor.failed', { contractorId: id, slot: contractor.slot, error: message });
    return service.store.updateContractor(id, { status: 'failed', error: message, endedAt: service.now() });
  }
}
