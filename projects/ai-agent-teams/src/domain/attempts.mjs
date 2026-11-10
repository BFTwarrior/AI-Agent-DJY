import { randomUUID } from 'node:crypto';

export const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const RESULT_FIELDS = ['output', 'verdict', 'scores', 'findings', 'changedPaths', 'acceptanceResults', 'commandsRun', 'reviewedArtifacts', 'reviewedScope', 'reviewedDuringDrift', 'reviewedGaps', 'reviewedAttempt', 'reviewedAttemptId', 'disposition', 'reviewResult', 'reviewResultValid', 'noChanges', 'partialFindings', 'needsCaptain', 'evidence_note'];

function clearResult(task) {
  for (const field of RESULT_FIELDS) delete task[field];
}

/**
 * Start a new execution generation. Old results are cleared.
 * @param {any} task
 * @param {string} assignee
 * @param {{ now?: number, leaseMs?: number }} [options]
 * @returns {any}
 */
export function beginAttempt(task, assignee, options = {}) {
  const now = options.now ?? Date.now();
  const attempt = (task.attempt ?? 0) + 1;
  const next = {
    ...task,
    status: 'claimed',
    assignee,
    attempt,
    attemptId: randomUUID(),
    handoffId: undefined,
    handoffFromMemberId: undefined,
    reassigning: false,
    parked: false,
    parkedAt: undefined,
    leaseExpiresAt: now + (options.leaseMs ?? DEFAULT_LEASE_MS),
    attemptStartedAt: now,
    retryNotBefore: undefined,
  };
  clearResult(next);
  return next;
}

/**
 * @param {any} task
 * @param {{ now?: number, leaseMs?: number }} [options]
 * @returns {any}
 */
export function activateAttempt(task, options = {}) {
  const now = options.now ?? Date.now();
  if (task.status !== 'claimed') throw new Error(`cannot activate task in status ${task.status}`);
  return { ...task, status: 'in_progress', leaseExpiresAt: now + (options.leaseMs ?? DEFAULT_LEASE_MS) };
}

/**
 * @param {any} task
 * @param {{ now?: number, leaseMs?: number }} [options]
 * @returns {any}
 */
export function heartbeatAttempt(task, options = {}) {
  const now = options.now ?? Date.now();
  if (!task.attemptId) throw new Error('task has no open attempt');
  return { ...task, leaseExpiresAt: now + (options.leaseMs ?? DEFAULT_LEASE_MS) };
}

/**
 * Revoke the current capability and return the task to the pool.
 * @param {any} task
 * @param {{ assignee?: string, now?: number }} [options]
 * @returns {any}
 */
export function invalidateAttempt(task, options = {}) {
  const next = {
    ...task,
    status: 'pending',
    attemptId: undefined,
    handoffId: randomUUID(),
    handoffFromMemberId: task.assignee,
    assignee: options.assignee,
    reassigning: true,
    parked: false,
    parkedAt: undefined,
    leaseExpiresAt: undefined,
  };
  clearResult(next);
  return next;
}

/**
 * @param {any} task
 * @param {{ now?: number }} [options]
 * @returns {any}
 */
export function parkAttempt(task, options = {}) {
  if (!task.attemptId) throw new Error('cannot park a task without an open attempt');
  return { ...task, parked: true, parkedAt: options.now ?? Date.now() };
}

/**
 * @param {any} task
 * @param {{ now?: number, leaseMs?: number }} [options]
 * @returns {any}
 */
export function unparkAttempt(task, options = {}) {
  return {
    ...task,
    parked: false,
    parkedAt: undefined,
    leaseExpiresAt: (options.now ?? Date.now()) + (options.leaseMs ?? DEFAULT_LEASE_MS),
  };
}

/**
 * @param {any} task
 * @param {string} attemptId
 * @returns {void}
 */
export function assertAttempt(task, attemptId) {
  if (!task?.attemptId || task.attemptId !== attemptId) {
    // Distinguish the two stale shapes: a live task that moved on to a new
    // attempt ("继续" opened it) versus a task with no open attempt
    // (reassigned, closed, stalled or expired).
    const reason = task?.attemptId
      ? 'the task continued to a new attempt'
      : 'the task has no open attempt (reassigned, closed or stalled)';
    throw new Error(`stale attempt: ${reason}`);
  }
}

/**
 * @param {any} task
 * @param {number} [now]
 * @returns {boolean}
 */
export function isLeaseExpired(task, now = Date.now()) {
  return typeof task?.leaseExpiresAt === 'number' && task.leaseExpiresAt <= now;
}

/**
 * Close the current attempt. Terminal results are immutable.
 * @param {any} task
 * @param {'completed'|'failed'|'cancelled'} status
 * @param {any} [result]
 * @returns {any}
 */
export function closeAttempt(task, status, result = {}) {
  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    throw new Error(`task is already terminal: ${task.status}`);
  }
  const accepted = {};
  for (const field of RESULT_FIELDS) {
    if (result[field] !== undefined) accepted[field] = result[field];
  }
  return {
    ...task,
    ...accepted,
    status,
    lastAttemptId: task.attemptId,
    attemptId: undefined,
    leaseExpiresAt: undefined,
    parked: false,
    parkedAt: undefined,
    closedAt: Date.now(),
  };
}

/**
 * Mark a task stalled after its lease expired.
 * @param {any} task
 * @param {number} [now]
 * @returns {any}
 */
export function stallAttempt(task, now = Date.now()) {
  return {
    ...task,
    stalled: true,
    stalledAt: now,
    parked: false,
    parkedAt: undefined,
  };
}
