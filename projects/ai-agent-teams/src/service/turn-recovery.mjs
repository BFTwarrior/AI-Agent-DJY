import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  RED_REVIEW_ACTOR, continueBackoffMs, continueMessage, isRetryableTurnError,
} from '../domain/scheduler.mjs';
import { beginAttempt, closeAttempt, invalidateAttempt } from '../domain/attempts.mjs';
import {
  holdNativeModelDispatch, isNativeModelDispatchError,
  withNativeModelForDispatch,
} from './native-model-dispatch.mjs';
import { recordRedReviewDelivery } from './red-review.mjs';
import { retryAfterMsFrom } from '../session/retry-after.mjs';
import { ensureOwnedMemberHome } from '../session/worker-home.mjs';

const CONTINUE_DEFER_BASE_MS = 5000;
const CONTINUE_DEFER_MAX_MS = 60000;
const CONTINUE_DEFER_LIMIT = 60;

export function armTurnWatcher(service, { teamId, taskId, attemptId, member, sessionId, afterSeq }, terminalStatuses) {
  const key = `${teamId}:${taskId}:${attemptId}`;
  service.turnWatchers.get(key)?.cancel?.();
  let settled = false;
  const finish = (handler) => (...args) => {
    if (settled) return;
    settled = true;
    service.turnWatchers.delete(key);
    handler(...args);
  };
  const handle = service.adapter.watchTurn({
    sessionId,
    afterSeq,
    intervalMs: service.turnWatchIntervalMs,
    timeoutMs: service.leaseMs,
    onFailed: finish((failure) => {
      service.handleTurnFailure({
        teamId, taskId, attemptId, memberId: member.id, sessionId,
        message: failure?.message, code: failure?.code, type: failure?.type,
        retryable: failure?.retryable, retryAfterMs: failure?.retryAfterMs,
        turnFailure: true,
      });
    }),
    onCompleted: finish(() => {
      service.recordTurnSuccess(teamId);
      const current = service.store.getTask(taskId);
      if (current && current.attemptId === attemptId && !terminalStatuses.has(current.status)) {
        // A completed turn ends this failure episode; a later failure starts
        // with a fresh three-continue budget, including the red-review budget.
        if (current.turnFailureCount || current.autoContinueCount || current.redContinueCount) {
          service.store.updateTask(taskId, {
            turnFailureCount: 0,
            autoContinueCount: 0,
            redContinueCount: 0,
            redContinueSessionId: undefined,
            redReviewEscalated: false,
          });
        }
        service.store.updateMember(member.id, {
          status: 'idle', workState: 'waiting', residency: 'warm', lastActiveAt: service.now(),
        });
        service.refreshMemberState(teamId, member.id);
      }
    }),
    onWarning: (warning) => {
      service.store.addEvent(teamId, 'task.turn_watch_warning', {
        taskId, attemptId, error: warning?.error instanceof Error ? warning.error.message : String(warning?.error ?? warning?.message ?? 'watcher warning'),
      });
    },
    onError: finish((error) => {
      const message = error instanceof Error ? error.message : String(error);
      service.store.addEvent(teamId, 'task.turn_watch_error', { taskId, attemptId, error: message });
      service.handleTurnFailure({
        teamId, taskId, attemptId, memberId: member.id, sessionId,
        message: `turn watcher stopped: ${message}`,
        retryAfterMs: retryAfterMsFrom(error),
      });
    }),
  });
  if (handle?.cancel) service.turnWatchers.set(key, handle);
}

function requeueAfterSessionChange(service, teamId, task, member, previousSessionId = task.lastSessionId, failure = null) {
  const current = service.store.getTask(task.id);
  if (!current || current.attemptId !== task.attemptId || current.status !== 'in_progress') return false;
  const now = service.now();
  const attemptId = current.attemptId;
  const message = failure?.message ?? 'member session changed before continue';
  service.store.updateAttempt(attemptId, { status: 'failed', endedAt: now, error: message });
  service.store.updateTask(task.id, {
    ...invalidateAttempt(current, { assignee: current.assignee }),
    reassigning: false,
    autoContinue: false,
    pendingRedReviewId: undefined,
    pendingRedReviewBy: undefined,
    redReviewPendingSessionId: undefined,
    autoContinueCount: 0,
    turnFailureCount: 0,
    continueDeferCount: 0,
    retryNotBefore: now,
    redContinueCount: 0,
    redContinueSessionId: undefined,
    lastSessionId: previousSessionId,
    lastAttemptId: attemptId,
    lastTurnError: undefined,
    lastTurnErrorCode: undefined,
    lastTurnErrorType: undefined,
    error: undefined,
    closedAt: undefined,
  });
  if (failure?.event) {
    service.store.addEvent(teamId, 'task.turn_failed', {
      ...failure.event, attempt: failure.count, sessionChanged: true,
    });
  }
  service.store.addEvent(teamId, 'task.continue_session_lost', {
    taskId: task.id,
    attemptId,
    reason: 'session-changed',
    previousSessionId,
    sessionId: member?.sessionId,
  });
  if (member) {
    service.store.updateMember(member.id, {
      status: 'idle', workState: 'waiting', residency: member.sessionId ? 'warm' : 'cold', lastActiveAt: now,
    });
    service.refreshMemberState(teamId, member.id);
  }
  return true;
}

export function handleTurnFailure(service, { teamId, taskId, attemptId, memberId, sessionId: attemptSessionId, message, code, type, retryable, retryAfterMs, turnFailure = false, correlationId = randomUUID(), causedBy }, activeStatuses) {
  service.clearCapacitySuccesses();
  const task = service.store.getTask(taskId);
  if (!task || !activeStatuses.has(task.status) || task.attemptId !== attemptId) return;
  const text = String(message ?? 'provider turn failed').slice(0, 2000);
  const now = service.now();
  const member = service.store.getMember(memberId);
  const count = Number(task.turnFailureCount ?? 0) + 1;
  const retry = service.turnRetry;
  const capacity = service.handleCapacityError(teamId, { message: text, code, type, retryable, retryAfterMs });
  const attemptLimit = capacity
    ? Number(retry.capacityMaxAttempts ?? retry.maxAttempts)
    : Number(retry.maxAttempts);
  const retryableTurn = turnFailure
    ? isRetryableTurnError({ message: text, code, type, retryable, retryAfterMs })
    : retryable !== false;
  const canRetry = retry.enabled && retryableTurn && count <= attemptLimit;
  const backoff = continueBackoffMs(count, retry);
  const hint = Number(retryAfterMs);
  const providerDelay = Number.isFinite(hint) && hint > 0 ? hint : undefined;
  const delay = providerDelay === undefined ? backoff : Math.min(3600000, providerDelay);
  const failureEvent = {
    taskId, attemptId, error: text, errorCode: code, errorType: type,
    retryable, retryAfterMs: providerDelay, capacity,
    // task.continue_failed and the derived task.turn_failed /
    // task.continue_scheduled share this id so audit readers can pair them
    // instead of double-counting one failure (F5).
    correlationId,
    // A failure caused by a failed "继续" send is subordinate to the
    // task.continue_failed record that already described it.
    ...(causedBy ? { causedBy, primary: false } : {}),
  };
  // Record the session the failed attempt actually ran on. The live member
  // session may already be rebuilt; attributing the failure to the new
  // session hides a session change and lets a bare "继续" go to it.
  const sessionId = attemptSessionId ?? member?.sessionId ?? task.lastSessionId;
  const rememberFailure = {
    turnFailureCount: count,
    lastTurnError: text,
    lastTurnErrorCode: code,
    lastTurnErrorType: type,
    lastSessionId: sessionId,
    lastAttemptId: attemptId,
  };
  if (canRetry && attemptSessionId && member
    && attemptSessionId !== member.sessionId) {
    requeueAfterSessionChange(service, teamId, task, member, attemptSessionId, {
      message: text, event: failureEvent, count,
    });
    return;
  }
  service.store.updateAttempt(attemptId, { status: 'failed', endedAt: now, error: text });
  if (turnFailure && canRetry && member?.sessionId) {
    // Same task, same session: close the failed attempt, open the next
    // generation on the same task and schedule "继续" after the backoff.
    const fresh = beginAttempt(task, task.assignee, { now, leaseMs: service.leaseMs });
    service.store.updateTask(task.id, {
      ...fresh,
      status: 'in_progress',
      retryNotBefore: now + delay,
      autoContinue: true,
      autoContinueCount: count,
      continueDeferCount: 0,
      ...rememberFailure,
    });
    service.store.addAttempt({
      id: fresh.attemptId,
      teamId,
      taskId: task.id,
      attempt: fresh.attempt,
      assignee: task.assignee,
      assigneeId: member.id,
      leaseExpiresAt: fresh.leaseExpiresAt,
      status: 'claimed',
      taskEpoch: fresh.taskEpoch ?? task.taskEpoch ?? 0,
      controlEpoch: service.store.getTeam(teamId)?.controlEpoch ?? 0,
      startedAt: now,
    });
    service.store.addEvent(teamId, 'task.turn_failed', {
      ...failureEvent, attempt: count, retryInMs: delay, autoContinue: true,
    });
    service.store.addEvent(teamId, 'task.continue_scheduled', {
      ...failureEvent,
      attempt: count,
      attemptId: fresh.attemptId,
      previousAttemptId: attemptId,
      retryAt: now + delay,
      retryInMs: delay,
      sessionId: member.sessionId,
    });
  } else if (canRetry) {
    const invalidated = invalidateAttempt(task, { assignee: task.assignee });
    service.store.updateTask(task.id, {
      ...invalidated,
      status: 'pending',
      reassigning: false,
      retryNotBefore: now + delay,
      ...rememberFailure,
    });
    service.store.addEvent(teamId, 'task.turn_failed', {
      ...failureEvent, attempt: count, retryInMs: delay,
    });
    service.store.addEvent(teamId, 'task.retry_scheduled', {
      ...failureEvent, attempt: count, retryAt: now + delay, retryInMs: delay,
    });
  } else {
    service.store.updateTask(task.id, {
      ...invalidateAttempt(task, { assignee: task.assignee }),
      status: 'failed',
      reassigning: false,
      handoffId: undefined,
      handoffFromMemberId: undefined,
      attemptId: undefined,
      leaseExpiresAt: undefined,
      retryNotBefore: undefined,
      autoContinue: false,
      ...rememberFailure,
      error: text,
      closedAt: now,
    });
    service.store.addEvent(teamId, 'task.turn_failed', {
      ...failureEvent, attempt: count, exhausted: true,
    });
  }
  if (member) {
    service.store.updateMember(member.id, {
      status: 'idle', workState: 'waiting', residency: 'warm', lastActiveAt: now,
    });
    service.refreshMemberState(teamId, member.id);
  }
  // The task just turned red: schedule the automatic review (one per failure).
  if (service.store.getTask(taskId)?.status === 'failed') service.onTaskFailed(teamId, taskId);
}

export async function continueDueTurns(service, teamId, now) {
  const due = service.store.listTasks(teamId).filter((task) => (
    task.autoContinue === true
    && task.status === 'in_progress'
    && task.attemptId
    && typeof task.retryNotBefore === 'number'
    && task.retryNotBefore <= now
  ));
  let sentCount = 0;
  for (const task of due) {
    if (service.continueInFlight.has(task.id)) continue;
    service.continueInFlight.add(task.id);
    try {
      sentCount += await service.continueOneTask(teamId, task);
    } finally {
      service.continueInFlight.delete(task.id);
    }
  }
  return sentCount;
}

export function deferContinue(service, teamId, task, attemptId, reason, details = {}) {
  const current = service.store.getTask(task.id);
  if (!current || current.attemptId !== attemptId || current.status !== 'in_progress') return 0;
  const deferCount = Number(current.continueDeferCount ?? 0) + 1;
  if (deferCount > CONTINUE_DEFER_LIMIT) {
    const text = `continue deferred too many times (${CONTINUE_DEFER_LIMIT}, ${reason})`;
    service.store.updateAttempt(attemptId, { status: 'failed', endedAt: service.now(), error: text });
    service.store.updateTask(task.id, {
      ...closeAttempt(current, 'failed'),
      reassigning: false,
      autoContinue: false,
      retryNotBefore: undefined,
      continueDeferCount: deferCount,
      lastTurnError: text,
      lastAttemptId: attemptId,
      error: text,
    });
    service.store.addEvent(teamId, 'task.continue_abandoned', {
      taskId: task.id, attemptId, reason, deferCount,
    });
    // This path also reaches `failed`; the direct hook must see it rather
    // than waiting for the next sweep.
    service.onTaskFailed(teamId, task.id);
    const member = details.member;
    if (member) {
      service.store.updateMember(member.id, { status: 'idle', workState: 'waiting', residency: 'warm', lastActiveAt: service.now() });
      service.refreshMemberState(teamId, member.id);
    }
    return 0;
  }
  const retryInMs = Math.min(CONTINUE_DEFER_MAX_MS, CONTINUE_DEFER_BASE_MS * (2 ** Math.min(deferCount - 1, 4)));
  service.store.updateTask(task.id, { retryNotBefore: service.now() + retryInMs, continueDeferCount: deferCount });
  service.store.addEvent(teamId, 'task.continue_deferred', {
    taskId: task.id, attemptId, reason, deferCount, retryInMs,
    ...(details.error ? { error: details.error } : {}),
  });
  return 0;
}

export async function continueOneTask(service, teamId, task) {
  const current = service.store.getTask(task.id);
  if (!current || current.attemptId !== task.attemptId || current.status !== 'in_progress') return 0;
  const member = current.assignee ? service.store.findMember(teamId, current.assignee) : undefined;
  if (!member) {
    return service.deferContinue(teamId, current, current.attemptId, 'member-unavailable');
  }
  if (current.autoContinue === true && current.lastSessionId
    && current.lastSessionId !== member.sessionId) {
    requeueAfterSessionChange(service, teamId, current, member, current.lastSessionId);
    return 0;
  }
  if (!member.sessionId) {
    const requeued = service.store.getTask(task.id);
    if (requeued?.attemptId === current.attemptId) {
      service.store.updateAttempt(current.attemptId, { status: 'failed', endedAt: service.now(), error: 'member session is gone' });
      service.store.updateTask(task.id, {
        ...invalidateAttempt(requeued, { assignee: requeued.assignee }),
        status: 'pending',
        reassigning: false,
        autoContinue: false,
        retryNotBefore: service.now(),
        lastAttemptId: current.attemptId,
      });
      service.store.addEvent(teamId, 'task.continue_session_lost', {
        taskId: task.id, attemptId: current.attemptId, reason: 'member session is gone',
      });
    }
    return 0;
  }
  let afterSeq;
  let cursorError;
  try {
    afterSeq = typeof service.adapter.turnCursor === 'function'
      ? await service.adapter.turnCursor({ sessionId: member.sessionId, timeoutMs: 5000 })
      : undefined;
  } catch (error) {
    cursorError = error;
  }
  // The cursor is an async boundary on both success and failure: re-check the
  // attempt and live session before deferring or sending to the captured session.
  const team = service.store.getTeam(teamId);
  const latestMember = service.store.findMember(teamId, member.name);
  if (team?.phase !== 'running' || team.control !== 'active'
    || !service.isCurrentAttempt(task.id, current.attemptId, member.name)
    || latestMember?.id !== member.id) return 0;
  if (latestMember.sessionId !== member.sessionId) {
    requeueAfterSessionChange(service, teamId, current, latestMember, member.sessionId);
    return 0;
  }
  if (cursorError) {
    const message = cursorError instanceof Error ? cursorError.message : String(cursorError);
    return service.deferContinue(teamId, current, current.attemptId, 'cursor-unavailable', { member: latestMember, error: message });
  }
  const workdir = task.worktree ?? member.workdir ?? service.cwd;
  const home = join(service.memberHomeRoot(), teamId, member.id);
  // Carry the new attempt ID so subsequent writes can provide it explicitly.
  const continuePrompt = continueMessage(current.attemptId);
  try {
    ensureOwnedMemberHome(home, service.cwd);
    const sent = await withNativeModelForDispatch(service, {
      teamId, taskId: task.id, attemptId: current.attemptId,
      memberId: member.id, memberName: member.name, sessionId: member.sessionId,
      controlEpoch: team.controlEpoch ?? 0,
    }, (currentMember) => service.adapter.send({
      sessionId: currentMember.sessionId,
      message: continuePrompt,
      cwd: workdir,
      delivery: 'queue',
      ephemeral: false,
      mode: service.memberPermissionModeFor(currentMember),
      disallowedTools: service.memberDisallowedToolsFor(currentMember),
      home,
      token: service.store.getMemberToken(currentMember.id),
      teamId,
      memberName: currentMember.name,
    }));
    if (!sent.ok) {
      const failure = new Error(sent.warning ?? 'session rejected the continue message');
      if (sent.error && typeof sent.error === 'object') Object.assign(failure, sent.error);
      throw failure;
    }
    if (!service.isCurrentAttempt(task.id, current.attemptId, member.name)) {
      service.store.updateAttempt(current.attemptId, { status: 'failed', endedAt: service.now(), error: 'stale attempt after continue' });
      return 0;
    }
    const pendingRedReviewId = current.pendingRedReviewId;
    const next = service.store.updateTask(task.id, {
      status: 'in_progress',
      retryNotBefore: undefined,
      autoContinue: false,
      continueDeferCount: 0,
      pendingRedReviewId: undefined,
      pendingRedReviewBy: undefined,
      lastContinuedAt: service.now(),
      lastContinuedAttempt: service.store.getTask(task.id).attempt,
    });
    if (pendingRedReviewId) {
      // Only a delivered message consumes the review's continue budget.
      recordRedReviewDelivery(
        service, teamId, next, pendingRedReviewId, member.sessionId,
        current.pendingRedReviewBy ?? RED_REVIEW_ACTOR,
      );
    }
    service.store.updateAttempt(current.attemptId, { status: 'in_progress', leaseExpiresAt: next.leaseExpiresAt });
    service.store.updateMember(member.id, {
      status: 'working', workState: 'busy', residency: 'hot', workdir, lastActiveAt: service.now(),
    });
    service.store.addEvent(teamId, 'task.continued', {
      taskId: task.id,
      attemptId: current.attemptId,
      attempt: next.attempt,
      retries: current.autoContinueCount ?? current.turnFailureCount,
      sessionId: member.sessionId,
      message: continuePrompt,
    });
    if (sent.usage) {
      service.store.recordUsage({
        teamId,
        memberId: member.id,
        taskId: task.id,
        sessionId: member.sessionId,
        ...sent.usage,
      });
    }
    if (afterSeq !== undefined && typeof service.adapter.watchTurn === 'function'
      && service.isCurrentAttempt(task.id, current.attemptId, member.name)) {
      service.armTurnWatcher({
        teamId,
        taskId: task.id,
        attemptId: current.attemptId,
        member,
        sessionId: member.sessionId,
        afterSeq,
      });
    }
    return 1;
  } catch (error) {
    if (isNativeModelDispatchError(error)) {
      holdNativeModelDispatch(service, { teamId, task: current, member, started: current, error });
      return 0;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/prompt is already running/i.test(message)) {
      return service.deferContinue(teamId, current, current.attemptId, 'prompt-already-running', { member });
    }
    const retryAfterMs = retryAfterMsFrom(error);
    const correlationId = randomUUID();
    service.store.addEvent(teamId, 'task.continue_failed', {
      taskId: task.id, attemptId: current.attemptId, error: message,
      errorCode: error?.code, errorType: error?.type, retryAfterMs,
      correlationId, source: 'continue_send', primary: true,
    });
    if (/session is not active|unknown (protocol )?session|session .*closed|session not found/i.test(message)) {
      await service.resetMemberSession(teamId, member.id, member.sessionId);
      const requeued = service.store.getTask(task.id);
      if (requeued?.attemptId === current.attemptId) {
        service.store.updateAttempt(current.attemptId, { status: 'failed', endedAt: service.now(), error: message });
        service.store.updateTask(task.id, {
          ...invalidateAttempt(requeued, { assignee: requeued.assignee }),
          status: 'pending',
          reassigning: false,
          autoContinue: false,
          retryNotBefore: service.now(),
          lastTurnError: message,
          lastSessionId: member.sessionId,
          lastAttemptId: current.attemptId,
        });
        service.store.addEvent(teamId, 'task.continue_session_lost', {
          taskId: task.id, attemptId: current.attemptId, error: message,
        });
      }
      return 0;
    }
    service.handleTurnFailure({
      teamId,
      taskId: task.id,
      attemptId: current.attemptId,
      memberId: member.id,
      sessionId: member.sessionId,
      message: `continue failed: ${message}`,
      code: error?.code,
      type: error?.type,
      retryable: error?.retryable,
      retryAfterMs,
      turnFailure: true,
      correlationId,
      causedBy: 'task.continue_failed',
    });
    return 0;
  }
}
