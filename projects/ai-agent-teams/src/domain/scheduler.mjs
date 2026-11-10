/**
 * Pure scheduler helpers: task graph facade, readiness, leases, slot allocation.
 * No I/O. The daemon is responsible for persistence and dispatch.
 */

import { createHash } from 'node:crypto';
import { isCapacityError, isHardQuotaError } from './provider-errors.mjs';
import { isCurrentReview } from './delivery-review.mjs';
import { RED_REVIEW_KIND, TERMINAL_STATUSES } from './task-graph-policy.mjs';

export {
  RED_REVIEW_KIND,
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TERMINAL_STATUSES,
} from './task-graph-policy.mjs';
export const RED_REVIEW_EXCLUDED_KINDS = new Set([RED_REVIEW_KIND, 'review', 'requirements', 'verification']);
/** Name recorded as the actor of an automatic continue. */
export const RED_REVIEW_ACTOR = 'red-auto-review';
/**
 * Contractor purpose that runs the automatic review. The contractor slot's
 * whole job is the "继续" call, so no model session is needed.
 */
export const RED_REVIEW_PURPOSE = 'red_auto_review';

/** Band 2 = critical chain, 1 = normal, 0 = low priority or an independent retry. */
export const PRIORITY_BANDS = { critical: 2, high: 2, normal: 1, low: 0 };

export { validateTaskGraph } from './task-graph-validation.mjs';

/**
 * Ready tasks: pending, not reassigning, every dependency completed.
 * `now` excludes tasks waiting out a turn-failure backoff. The result is
 * priority-ordered (critical chain first, then FIFO) so a caller that picks the
 * first item cannot let a low-priority task jump a critical one.
 * @param {Array<any>} tasks
 * @param {number} [now]
 * @returns {Array<any>}
 */
export function isDispatchBlocked(task) {
  return !task || task.kind === RED_REVIEW_KIND || task.archived === true || task.historical === true || task.superseded === true || task.legacyRedReview === true
    || task.cancelReason === 'superseded' || ['archived', 'historical', 'superseded'].includes(task.historyState)
    || Boolean(task.hold) || task.bindingPending === true;
}

export function nextReady(tasks, now) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const boundRepairReady = (task) => {
    if (task.kind !== 'repair' || task.mode !== 'bound') return true;
    const review = byId.get(task.parentReviewTaskId);
    const reviewed = byId.get(review?.reviewedTaskId);
    const root = byId.get(task.deliveryUnitId);
    const reviewAllowsRepair = task.repairOrigin === 'postmerge'
      ? review?.status === 'completed' && review.verdict === 'pass'
        && reviewed?.postMergeReview === 'needs_revision' && reviewed.negativeMergeIntent?.phase === 'settled'
        && reviewed.negativeMergeIntent.verdict === 'needs_revision'
        && reviewed.negativeMergeIntent.mergeCommit === reviewed.mergeCommit
      : (review?.verdict === 'needs_revision' && ['failed', 'completed'].includes(review.status))
        || (task.repairOrigin === 'planner' && review?.status === 'completed' && review.verdict === 'pass');
    return Boolean(root && root.kind === 'implementation' && root.status === 'completed'
      && root.teamId === task.teamId && review?.teamId === task.teamId && reviewed?.teamId === task.teamId
      && task.sourceTaskId === root.id && task.deliveryGeneration === (root.taskEpoch ?? 0)
      && Number.isInteger(task.deliverySeq) && task.deliverySeq > 0 && task.sourceBase
      && review?.kind === 'review' && reviewAllowsRepair && isCurrentReview(review, tasks)
      && review.binding?.deliveryUnitId === root.id && review.binding?.sourceCommit === task.sourceBase
      && review.binding?.sourceTaskId === reviewed?.id && review.binding?.deliverySeq === reviewed?.deliverySeq
      && reviewed?.status === 'completed' && reviewed.sourceCommit === task.sourceBase);
  };
  const boundReviewReady = (task) => {
    if (task.kind !== 'review' || task.reviewMode !== 'bound') return true;
    const reviewed = byId.get(task.reviewedTaskId);
    return Boolean(reviewed && reviewed.status === 'completed' && task.binding?.sourceCommit
      && reviewed.teamId === task.teamId && task.binding.sourceTaskId === reviewed.id
      && task.binding.sourceCommit === reviewed.sourceCommit && task.binding.sourceBase === reviewed.sourceBase
      && task.binding.diffHash && task.binding.diffHash === reviewed.diffHash
      && task.binding.deliveryUnitId === reviewed.deliveryUnitId
      && task.binding.deliverySeq === reviewed.deliverySeq && isCurrentReview(task, tasks));
  };
  return orderReadyTasks(tasks.filter((task) => (
    (task.status ?? 'pending') === 'pending'
    && task.reassigning !== true
    && !isDispatchBlocked(task)
    && boundRepairReady(task)
    && boundReviewReady(task)
    && (now === undefined || !task.retryNotBefore || task.retryNotBefore <= now)
    && (task.dependencies ?? []).every((dep) => byId.get(dep)?.status === 'completed')
  )), tasks);
}

/**
 * @param {any} task
 * @returns {'critical'|'high'|'normal'|'low'}
 */
export function taskPriority(task) {
  const raw = String(task?.priority ?? '').trim().toLowerCase();
  if (raw === 'critical' || raw === 'high' || raw === 'p0' || raw === 'p1') return 'critical';
  if (raw === 'low' || raw === 'p3') return 'low';
  return 'normal';
}

/**
 * Transitive dependents of a task: how much work this task unblocks.
 * @param {string} taskId
 * @param {Array<any>} tasks
 * @returns {number}
 */
export function downstreamCount(taskId, tasks = []) {
  const dependents = new Map();
  for (const task of tasks) {
    for (const dep of task?.dependencies ?? []) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(task.id);
    }
  }
  const seen = new Set();
  const queue = [...(dependents.get(taskId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(dependents.get(id) ?? []));
  }
  return seen.size;
}

/**
 * A critical-chain task is either explicitly critical, unblocks downstream
 * work, or is a review/repair that the chain is waiting on. An explicit `low`
 * stays low even when it happens to unblock other work: an operator can always
 * demote a chain on purpose.
 * @param {any} task
 * @param {Array<any>} [tasks]
 * @returns {boolean}
 */
export function isCriticalChainTask(task, tasks = []) {
  if (!task) return false;
  if (!task.priority && (task.kind === 'review' || task.kind === 'repair')) return true;
  const priority = taskPriority(task);
  if (priority === 'critical') return true;
  if (priority === 'low') return false;
  return downstreamCount(task.id, tasks) > 0;
}

/**
 * Scheduling band: critical chain > normal > low/independent-retry.
 * @param {any} task
 * @param {Array<any>} [tasks]
 * @returns {number}
 */
export function priorityBand(task, tasks = []) {
  const priority = taskPriority(task);
  // A preempted task keeps its attempt counter but is not a retry; treating it
  // as one would demote it to band 0 forever and let critical work starve it.
  const retry = task?.preempted !== true
    && (Number(task?.turnFailureCount ?? 0) > 0 || Number(task?.attempt ?? 0) > 0);
  if (priority === 'low') return 0;
  if (isCriticalChainTask(task, tasks)) return 2;
  if (retry && priority === 'normal') return 0;
  return PRIORITY_BANDS[priority] ?? 1;
}

/**
 * Order ready tasks: band descending, then explicit critical priority, then
 * FIFO by createdAt (older waits longer), then id. FIFO inside a band is what
 * keeps a low-priority task from starving forever.
 * @param {Array<any>} ready
 * @param {Array<any>} [tasks]
 * @returns {Array<any>}
 */
export function orderReadyTasks(ready, tasks = ready) {
  const scored = ready.map((task, index) => ({
    task,
    index,
    band: priorityBand(task, tasks),
    explicit: taskPriority(task) === 'critical' ? 1 : 0,
    critical: isCriticalChainTask(task, tasks) ? 1 : 0,
    createdAt: Number.isFinite(task?.createdAt) ? task.createdAt : 0,
  }));
  scored.sort((left, right) => (
    right.band - left.band
    || right.explicit - left.explicit
    || right.critical - left.critical
    || left.createdAt - right.createdAt
    || String(left.task.id).localeCompare(String(right.task.id))
    || left.index - right.index
  ));
  return scored.map((entry) => entry.task);
}

/**
 * Ready tasks that must be protected from low-priority work. Returns the
 * lower-priority tasks to pause so a critical task can use a slot or the only
 * eligible member. One preemption per critical task, critical tasks are never
 * preempted themselves, and `preemptible: false` is always honoured.
 * @param {{ tasks?: Array<any>, members?: Array<any>, slots?: number, now?: number }} input
 * @returns {Array<{ taskId: string, member?: string, reason: string, forTaskId: string }>}
 */
export function planPreemption({ tasks = [], members = [], slots, now } = {}) {
  const ordered = nextReady(tasks, now);
  const critical = ordered.filter((task) => priorityBand(task, tasks) >= 2);
  if (critical.length === 0) return [];
  const activeTasks = tasks.filter((task) => (
    (task.status === 'claimed' || task.status === 'in_progress') && task.attemptId
  ));
  const preemptible = activeTasks
    .filter((task) => {
      if (task.preemptible === false) return false;
      if (priorityBand(task, tasks) >= 2) return false;
      return true;
    })
    // Pause the most recent low-value work first: it has the least to lose.
    .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0) || String(left.id).localeCompare(String(right.id)));

  const freeSlots = slots === undefined ? Number.POSITIVE_INFINITY : Math.max(0, slots - activeTasks.length);
  const plan = [];
  const alreadyPreempted = new Set();
  // A critical task that no member can run (missing role, member cap) must not
  // cause preemption every tick: only preempt for work that can actually start.
  const dispatchable = (task) => {
    if (members.length === 0) return true;
    const kind = task.kind ?? 'work';
    const role = task.assigneeRole;
    const pool = members.filter((member) => (
      member && member.status !== 'removed'
      && (member.license?.allowedTaskKinds ?? []).includes(kind)
      && (!role || (member.license?.roleKey ?? member.role) === role)
    ));
    if (task.assignee) return pool.some((member) => member.name === task.assignee);
    return pool.length > 0;
  };
  const criticalWork = critical.filter(dispatchable);
  if (criticalWork.length === 0) return [];
  const slotPressure = freeSlots < criticalWork.length;
  let slotPreemptions = slotPressure ? Math.min(criticalWork.length - freeSlots, preemptible.length) : 0;

  for (const task of criticalWork) {
    let victim;
    if (slotPreemptions > 0) {
      victim = preemptible.find((item) => !alreadyPreempted.has(item.id));
      if (victim) slotPreemptions -= 1;
    }
    if (!victim && members.length > 0) {
      const kind = task.kind ?? 'work';
      const role = task.assigneeRole;
      const pool = members.filter((member) => (
        member && member.status !== 'removed'
        && (member.license?.allowedTaskKinds ?? []).includes(kind)
        && (!role || (member.license?.roleKey ?? member.role) === role)
      ));
      if (pool.length > 0 && pool.every((member) => activeTasks.some((active) => active.assignee === member.name
        || (active.assigneeId && active.assigneeId === member.id)))) {
        victim = preemptible.find((item) => !alreadyPreempted.has(item.id)
          && pool.some((member) => item.assignee === member.name
            || (item.assigneeId && item.assigneeId === member.id)));
        if (victim) {
          plan.push({ taskId: victim.id, member: victim.assignee, reason: 'member-held-by-low-priority', forTaskId: task.id });
          alreadyPreempted.add(victim.id);
          continue;
        }
      }
    }
    if (victim) {
      plan.push({ taskId: victim.id, member: victim.assignee, reason: 'slot-held-by-low-priority', forTaskId: task.id });
      alreadyPreempted.add(victim.id);
    }
  }
  return plan;
}

/**
 * Delivery state for the UI. `queued` is the "待交付" grey state: the task is
 * ready but has no member or slot yet. Only `failed` (and an explicit
 * `cancelled`) is red, so a queued task is never mistaken for a failure.
 * @param {any} task
 * @param {Array<any>} tasks
 * @returns {'blocked'|'queued'|'running'|'completed'|'failed'|'cancelled'}
 */
export function taskDeliveryState(task, tasks = []) {
  if (task?.status === 'failed') return 'failed';
  if (task?.status === 'cancelled') return 'cancelled';
  if (task?.status === 'completed') return 'completed';
  if (task?.status === 'claimed' || task?.status === 'in_progress') return 'running';
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const blocked = (task?.dependencies ?? []).some((dep) => byId.get(dep)?.status !== 'completed');
  if (blocked) return 'blocked';
  if ((task?.status ?? 'pending') === 'pending' && !task?.attemptId) return 'queued';
  return 'queued';
}

/**
 * @param {{ leaseExpiresAt?: number } | undefined} attempt
 * @param {number} [now]
 * @returns {boolean}
 */
export function isLeaseExpired(attempt, now = Date.now()) {
  return typeof attempt?.leaseExpiresAt === 'number' && attempt.leaseExpiresAt <= now;
}

/**
 * Visual state used by the native tab.
 * @param {any} task
 * @param {Array<any>} tasks
 * @returns {'blocked'|'open'|'claimed'|'running'|'completed'|'failed'|'cancelled'}
 */
export function taskVisualState(task, tasks) {
  if (TERMINAL_STATUSES.includes(task.status)) return task.status;
  if (task.status === 'claimed') return 'claimed';
  if (task.status === 'in_progress') return 'running';
  const byId = new Map(tasks.map((item) => [item.id, item]));
  return (task.dependencies ?? []).every((dep) => byId.get(dep)?.status === 'completed') ? 'open' : 'blocked';
}

function taskWeight(task) {
  const explicit = String(task.complexity ?? task.effort ?? '').toUpperCase();
  if (explicit === 'S') return 1;
  if (explicit === 'M') return 2;
  if (explicit === 'L') return 4;
  if (explicit === 'XL') return 8;
  if (task.priority === 'high') return 3;
  if (task.kind === 'integration') return 3;
  if (task.kind === 'review' || task.kind === 'verification') return 1;
  return 2;
}

/**
 * Allocate the global worker slots across two teams with fair borrowing.
 * @param {{ config: any, tasks: Array<any>, active?: Array<{teamId?: string}>, now?: number }} input
 * @returns {{ dispatch: Array<{teamId:string, taskId:string, member:string, attempt:number}>, freeSlots:number, blocked:string[] }}
 */
export function allocateSlots({ config, tasks, active = [], now }) {
  const slots = config.scheduler.activeWorkerSlots;
  const perTeam = config.scheduler.maxActivePerTeam;
  const capFor = (teamId) => {
    const explicit = Number(config.teams?.find((team) => team.id === teamId)?.maxActiveWorkers);
    return Number.isInteger(explicit) && explicit > 0 ? explicit : perTeam;
  };
  const hardCapFor = (teamId) => {
    const explicit = Number(config.teams?.find((team) => team.id === teamId)?.maxActiveWorkers);
    return Number.isInteger(explicit) && explicit > 0 ? explicit : Number.POSITIVE_INFINITY;
  };
  const free = Math.max(0, slots - active.length);

  const activeByTeam = new Map();
  for (const item of active) {
    if (!item?.teamId) continue;
    activeByTeam.set(item.teamId, (activeByTeam.get(item.teamId) ?? 0) + 1);
  }

  const ready = nextReady(tasks, now);
  const configuredTeams = new Set((config.teams ?? []).map((team) => team.id));
  for (const task of ready) {
    if (configuredTeams.size > 0 && !configuredTeams.has(task.teamId)) {
      throw new Error(`unknown teamId: ${task.teamId}`);
    }
  }
  const byTeam = new Map();
  // nextReady already applied the priority/FIFO order; grouping preserves it.
  for (const task of ready) {
    if (!byTeam.has(task.teamId)) byTeam.set(task.teamId, []);
    byTeam.get(task.teamId).push(task);
  }

  const teams = [...byTeam.keys()];
  const allowed = new Map();
  for (const team of teams) {
    const cap = capFor(team);
    allowed.set(team, Math.max(0, Math.min(free, cap - (activeByTeam.get(team) ?? 0))));
  }

  const dispatch = [];
  const deferred = [];
  const usedMembers = new Set();
  let poolSeq = 0;
  const pushDispatch = (task, team) => {
    const member = task.assignee ?? `${team}-pool-${poolSeq += 1}`;
    const memberKey = `${team}:${member}`;
    if (usedMembers.has(memberKey)) {
      deferred.push({ teamId: team, taskId: task.id, member, reason: 'member-busy' });
      return false;
    }
    usedMembers.add(memberKey);
    dispatch.push({ teamId: team, taskId: task.id, member, attempt: (task.attempt ?? 0) + 1 });
    return true;
  };
  let remaining = free;
  const blockedTasks = () => {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return tasks
      .filter((task) => (task.status ?? 'pending') === 'pending'
        && (task.dependencies ?? []).some((dep) => byId.get(dep)?.status !== 'completed'))
      .map((task) => task.id);
  };
  const dispatchOne = (team) => {
    const list = byTeam.get(team);
    while (list && list.length > 0) {
      const task = list.shift();
      if (pushDispatch(task, team)) return true;
    }
    return false;
  };
  if (config.scheduler.dynamicTeams) {
    // Every team with ready work gets a first worker; remaining capacity goes
    // to the team with the highest remaining difficulty-weighted demand.
    const dispatchedByTeam = new Map();
    const hasCapacity = (team) => (activeByTeam.get(team) ?? 0) + (dispatchedByTeam.get(team) ?? 0) < hardCapFor(team);
    const ranked = [...teams].sort((a, b) => {
      const demandA = (byTeam.get(a) ?? []).reduce((sum, task) => sum + taskWeight(task), 0);
      const demandB = (byTeam.get(b) ?? []).reduce((sum, task) => sum + taskWeight(task), 0);
      return demandB - demandA || (activeByTeam.get(a) ?? 0) - (activeByTeam.get(b) ?? 0);
    });
    for (const team of ranked) {
      if (remaining <= 0) break;
      if ((byTeam.get(team) ?? []).length === 0 || !hasCapacity(team)) continue;
      if (dispatchOne(team)) {
        remaining -= 1;
        dispatchedByTeam.set(team, (dispatchedByTeam.get(team) ?? 0) + 1);
      }
    }
    while (remaining > 0) {
      const candidates = teams
        .filter((team) => (byTeam.get(team) ?? []).length > 0 && hasCapacity(team))
        .sort((a, b) => {
          const demandA = (byTeam.get(a) ?? []).reduce((sum, task) => sum + taskWeight(task), 0);
          const demandB = (byTeam.get(b) ?? []).reduce((sum, task) => sum + taskWeight(task), 0);
          return demandB - demandA || (activeByTeam.get(a) ?? 0) - (activeByTeam.get(b) ?? 0);
        });
      if (candidates.length === 0) break;
      if (!dispatchOne(candidates[0])) continue;
      remaining -= 1;
      dispatchedByTeam.set(candidates[0], (dispatchedByTeam.get(candidates[0]) ?? 0) + 1);
    }
    return { dispatch, deferred, freeSlots: remaining, blocked: blockedTasks() };
  }
  let progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    for (const team of teams) {
      const list = byTeam.get(team);
      while (list.length > 0 && remaining > 0 && (allowed.get(team) ?? 0) > 0) {
        const task = list.shift();
        if (!pushDispatch(task, team)) continue;
        allowed.set(team, allowed.get(team) - 1);
        remaining -= 1;
        progress = true;
      }
    }
  }

  // Borrow: after per-team caps, fill remaining slots from any team with ready
  // work, but never above that team's explicit cap.
  progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    for (const team of teams) {
      const list = byTeam.get(team);
      const cap = hardCapFor(team);
      const used = (activeByTeam.get(team) ?? 0) + dispatch.filter((item) => item.teamId === team).length;
      if (list.length > 0 && remaining > 0 && used < cap) {
        const task = list.shift();
        if (!pushDispatch(task, team)) continue;
        remaining -= 1;
        progress = true;
      }
    }
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const blocked = tasks
    .filter((task) => (task.status ?? 'pending') === 'pending'
      && (task.dependencies ?? []).some((dep) => byId.get(dep)?.status !== 'completed'))
    .map((task) => task.id);

  return { dispatch, deferred, freeSlots: remaining, blocked };
}

/**
 * Permission mode for a member session. Headless members cannot answer an
 * interactive approval prompt, so they run in the worker mode (yolo by
 * default). Read-only licenses stay in plan mode regardless of config.
 */
export function memberPermissionMode({ readOnly = false, isolation, zcode } = {}) {
  if (readOnly) return 'plan';
  return isolation?.workerMode ?? zcode?.mode ?? 'yolo';
}

/**
 * Message sent to the same member session when a turn failed for a transient
 * reason. The task id and subject never change: this is a continuation of the
 * same task, not a new task or a reassignment.
 */
export const CONTINUE_MESSAGE = '继续';

/**
 * One continue prompt carrying the attempt id that was just opened.
 *
 * A continue opens a new attempt. The id travels with the prompt and must be
 * supplied on subsequent claim, heartbeat and update requests.
 *
 * @param {string|undefined|null} attemptId
 * @returns {string}
 */
export function continueMessage(attemptId) {
  if (!attemptId) return CONTINUE_MESSAGE;
  return [
    CONTINUE_MESSAGE,
    `Attempt id: ${attemptId}`,
    'The task id and subject did not change. Supply this attempt id when claiming, heartbeating, or updating the task.',
  ].join('\n');
}

/** License capability that allows a member (the reviewer) to continue a task. */
export const CONTINUE_CAPABILITY = 'task:continue';

const RETRYABLE_TURN_CODE_PATTERN = /ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_(?:HEADERS|BODY|CONNECT)_TIMEOUT/i;
const RETRYABLE_TURN_TEXT_PATTERN = /connection reset|connection aborted|connection refused|socket hang up|other side closed|timed?\s*out|timeout|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|internal server error|overloaded|provider (?:error|failure)|\b(?:HTTP|status|error)[=: ]*5\d\d\b/i;
const NON_RETRYABLE_TURN_PATTERN = /invalid|unauthorized|forbidden|permission|not.?found|auth|context.?length|content.?filter|bad.?request|validation|syntax|enoent|eacces|insufficient.?quota|credit.?balance|spend.?limit|billing|payment|hard.?quota|current.?quota/i;

/**
 * Decide whether a failed member turn can be continued by re-sending "继续" to
 * the same session. Explicit `retryable` wins; hard quota is always final.
 * Unknown turn failures keep the historical retry budget instead of failing on
 * the first provider hiccup.
 *
 * @param {{ message?: unknown, code?: unknown, type?: unknown, retryable?: boolean, retryAfterMs?: number }} error
 * @returns {boolean}
 */
export function isRetryableTurnError({ message, code, type, retryable, retryAfterMs } = {}) {
  if (retryable === true) return true;
  if (retryable === false) return false;
  if (isHardQuotaError({ code, type, message })) return false;
  if (isCapacityError({ message, code, type, retryAfterMs })) return true;
  const codeType = `${code ?? ''} ${type ?? ''}`;
  const text = String(message ?? '');
  if (NON_RETRYABLE_TURN_PATTERN.test(codeType) || NON_RETRYABLE_TURN_PATTERN.test(text)) return false;
  if (RETRYABLE_TURN_CODE_PATTERN.test(codeType) || RETRYABLE_TURN_CODE_PATTERN.test(text)) return true;
  if (RETRYABLE_TURN_TEXT_PATTERN.test(codeType) || RETRYABLE_TURN_TEXT_PATTERN.test(text)) return true;
  return true;
}

/**
 * Exponential delay before the next automatic "继续" (3s, 6s, 12s ...).
 * @param {number} count 1-based retry number
 * @param {{ baseDelayMs?: number, maxDelayMs?: number }} [options]
 * @returns {number}
 */
export function continueBackoffMs(count, options = {}) {
  const base = Math.max(0, Number(options.baseDelayMs) || 0);
  const cap = Math.max(base, Number(options.maxDelayMs) || 0);
  return Math.min(cap, base * 2 ** Math.max(0, Number(count) - 1));
}

/**
 * Stable identity of one failure event ("red box") of a task. The failed
 * attempt id is unique per failure, so two failures of the same task produce
 * two keys and one failure can never produce two review tasks, even after a
 * daemon restart.
 * @param {any} task
 * @returns {string}
 */
export function redReviewKey(task) {
  const attempt = task?.lastAttemptId ?? task?.attemptId;
  const closed = task?.closedAt ?? task?.failedAt;
  return `${task?.id ?? 'unknown'}:${attempt ?? `closed:${closed ?? 'unknown'}`}`;
}

/**
 * Deterministic review task id for a failure key. Deterministic ids make the
 * one-review-per-failure rule survive restarts and concurrent ticks.
 * @param {string} key
 * @returns {string}
 */
export function redReviewTaskId(key) {
  return `redreview_${createHash('sha1').update(String(key)).digest('hex').slice(0, 20)}`;
}

/**
 * Message body sent to the captain when automatic continues are exhausted.
 * Contains everything the captain needs to take over by hand.
 *
 * The body is English because it is delivered to a captain model as an urgent
 * message; only the bracketed title stays a literal protocol identifier.
 * @param {{ taskId: string, subject?: string, error?: string, count: number, sessionId?: string, reason?: string }} input
 * @returns {string}
 */
export function redReviewEscalationText({ taskId, subject, error, count, sessionId, reason } = {}) {
  // Literal message title: the header `[自动继续审查上报]` is a stable
  // identifier (prompts/captain.md and the panel match on it), not prose.
  const lines = [
    `[自动继续审查上报] Task ${taskId} still fails after ${count} automatic continue(s); automatic continues are stopped and the task waits for a human.`,
    `- taskId: ${taskId}`,
  ];
  if (subject) lines.push(`- subject: ${subject}`);
  lines.push(`- automatic continues: ${count}`);
  lines.push(`- sessionId: ${sessionId ?? '(none)'}`);
  lines.push(`- last error: ${String(error ?? '(unknown)').slice(0, 500)}`);
  if (reason) lines.push(`- reason: ${reason}`);
  lines.push('Suggested action: inspect the failure, then use agent_teams_continue_task to continue the task by hand, or reassign it.');
  return lines.join('\n');
}

/**
 * A red review can fail for a transient reason (member still owns another open
 * task, team busy). Those are retried; anything else is escalated.
 * @param {any} error
 * @returns {boolean}
 */
export function isRetryableRedReviewError(error) {
  const status = Number(error?.status);
  const code = String(error?.code ?? '');
  if (code === 'E_STATE' || code === 'E_CONFLICT' || status === 409) return true;
  const text = String(error?.message ?? error ?? '');
  return /already owns an open task|prompt is already running|network|ECONNRESET|timed?\s*out/i.test(text);
}
