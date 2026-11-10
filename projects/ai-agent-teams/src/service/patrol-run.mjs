import { classifyChangedPath } from '../domain/gates.mjs';
import { formatDateTime } from '../i18n.mjs';

// A deadline ends the caller's wait, not the underlying action. Keep ownership
// until cancellation succeeds AND the original patrol has settled.
export function createPatrolRun(work) {
  const controller = new AbortController();
  let external;
  let cancellation;
  const result = Promise.resolve().then(() => work({
    signal: controller.signal,
    onExternal: (handle) => { external = handle; },
  }));
  // Observe rejection even after the deadline has won the race.
  const settled = result.then(() => undefined, () => undefined);
  const cancel = () => {
    controller.abort();
    if (!cancellation) {
      cancellation = (async () => {
        const handle = external;
        if (handle) await handle.cancel();
        await settled;
        // A delayed submit may expose its handle only after we aborted.
        if (external && external !== handle) await external.cancel();
      })().catch((error) => {
        cancellation = undefined;
        throw error;
      });
    }
    return cancellation;
  };
  return { result, cancel, get kind() { return external?.type; } };
}

export async function withPatrolCancelDeadline(cancel, timeoutMs, label = 'patrol cancellation') {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(cancel),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const ACTIVE_STATUSES = new Set(['claimed', 'in_progress']);
const REVIEW_FAILURE_VERDICTS = new Set(['needs_revision', 'reject']);
const NETWORK_ERROR_PATTERN = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|timed?[ -]?out/i;
const EMPTY = 'none';

/**
 * A member is executing when the daemon owns a live turn for it. Lazy v0.6
 * members carry both `status` and `workState`; either is authoritative.
 * @param {any} member
 * @returns {boolean}
 */
export function isExecutingMember(member) {
  if (!member || member.status === 'removed') return false;
  return member.status === 'working' || member.workState === 'busy';
}

function asNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatMinutes(ms) {
  const minutes = Math.max(0, Math.round(asNumber(ms, 0) / 60000));
  if (minutes < 1) return 'under 1 minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursText = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rest === 0 ? hoursText : `${hoursText} ${rest} minute${rest === 1 ? '' : 's'}`;
}

function formatStamp(ms, locale, timeZone) {
  return formatDateTime(ms, {
    locale, timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function formatClock(ms, locale, timeZone) {
  return formatDateTime(ms, { locale, timeZone, hour: '2-digit', minute: '2-digit' });
}

function joinIds(items) {
  return items.length > 0 ? items.join(', ') : EMPTY;
}

/**
 * Build the 15-minute inspection report from team state.
 *
 * Pure and read-only: it never touches the store, creates tasks, edits files,
 * or merges. The report is delivered to the captain model, so its text is
 * always English (internal prompts and instructions are English by rule);
 * timestamps follow the configured display locale and time zone.
 *
 * @param {{
 *   team?: any, tasks?: any[], members?: any[], attempts?: any[],
 *   now?: number, windowStart?: number, intervalMinutes?: number, quota?: number,
 *   taskTimeoutMinutes?: number, noProgressMinutes?: number, captainName?: string,
 *   locale?: string, timeZone?: string,
 * }} input
 * @returns {{ text: string, conclusion: 'normal'|'attention'|'risk'|'off-course', direction: 'on-track'|'off-course', facts: any }}
 */
export function buildPatrolReport(input = {}) {
  const {
    team = {},
    tasks: inputTasks = [],
    members = [],
    attempts = [],
    now = Date.now(),
    windowStart,
    intervalMinutes = 15,
    quota,
    taskTimeoutMinutes = 120,
    noProgressMinutes = 30,
    captainName = 'captain',
    locale,
    timeZone,
  } = input;
  // The task tree hides historical rows; the patrol report must use the same
  // visible set or a restart's legacy failures look like live broken chains.
  const tasks = inputTasks.filter((task) => task?.hidden !== true);
  const intervalMs = Math.max(1, asNumber(intervalMinutes, 15)) * 60000;
  // Broken-chain/drift findings are about work that can still be acted on. A
  // terminal row older than a few patrol windows is history: reporting it every
  // 15 minutes forever would make every established repo look off-course.
  const terminalCutoff = now - Math.max(intervalMs * 4, 60 * 60000);
  const recentTerminal = { completed: true, failed: true, cancelled: true };
  const chainTasks = tasks.filter((task) => !recentTerminal[task.status]
    || asNumber(task.closedAt ?? task.createdAt, now) >= terminalCutoff);
  const from = Number.isFinite(windowStart) ? windowStart : now - intervalMs;
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const memberByName = new Map(members.map((member) => [member.name, member]));
  const attemptsByTask = new Map();
  for (const attempt of attempts) {
    if (!attempt?.taskId) continue;
    const list = attemptsByTask.get(attempt.taskId) ?? [];
    list.push(attempt);
    attemptsByTask.set(attempt.taskId, list);
  }
  const attemptFor = (task) => {
    const list = attemptsByTask.get(task.id) ?? [];
    return list.find((attempt) => attempt.id === task.attemptId) ?? list[list.length - 1];
  };

  const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  const waiting = tasks.filter((task) => task.status === 'pending');
  const failed = tasks.filter((task) => task.status === 'failed');
  const teamQuota = Math.max(0, asNumber(quota, 0));
  const usedSlots = active.length;
  const freeSlots = Math.max(0, teamQuota - usedSlots);
  const workers = members.filter((member) => member.name !== captainName
    && member.status !== 'removed' && member.status !== 'lost');
  const idleMembers = workers.filter((member) => !isExecutingMember(member));

  // --- window stats -------------------------------------------------------
  const completedInWindow = new Set();
  const failedInWindow = new Set();
  for (const attempt of attempts) {
    const at = asNumber(attempt?.endedAt, 0);
    if (!at || at < from || at > now) continue;
    if (attempt.status === 'completed') completedInWindow.add(attempt.taskId);
    else if (attempt.status === 'failed') failedInWindow.add(attempt.taskId);
  }

  // --- executing ----------------------------------------------------------
  const executing = active.map((task) => {
    const attempt = attemptFor(task);
    const startedAt = asNumber(attempt?.startedAt, 0) || asNumber(task.claimedAt, 0) || now;
    const member = memberByName.get(task.assignee);
    const lastActiveAt = asNumber(member?.lastActiveAt, 0) || startedAt;
    return {
      taskId: task.id,
      subject: task.subject ?? task.kind ?? '',
      member: task.assignee ?? 'unassigned',
      runningMs: now - startedAt,
      idleMs: now - lastActiveAt,
      startedAt,
      lastActiveAt,
    };
  });

  // --- waiting ------------------------------------------------------------
  const waitingReasons = waiting.map((task) => {
    const dependencies = (task.dependencies ?? []).filter((id) => taskById.get(id)?.status !== 'completed');
    let reason;
    if (dependencies.length > 0) reason = `waiting on ${dependencies.join(', ')}`;
    else if (teamQuota > 0 && freeSlots === 0) reason = `waiting for a free slot (used ${usedSlots}/${teamQuota})`;
    else if (idleMembers.length === 0) reason = 'waiting for an eligible idle member';
    else reason = 'ready, waiting for dispatch';
    return { taskId: task.id, subject: task.subject ?? task.kind ?? '', reason, ageMs: now - (asNumber(task.createdAt, now)) };
  });
  const stalledWaiting = waitingReasons.filter((item) => item.ageMs >= intervalMs && item.reason === 'ready, waiting for dispatch');

  // --- broken chains ------------------------------------------------------
  // A cancelled review/repair does not close the chain: it is work that was
  // scheduled and then abandoned.
  const reviewTargets = new Set(tasks
    .filter((task) => task.kind === 'review' && task.reviewedTaskId && task.status !== 'cancelled')
    .map((task) => task.reviewedTaskId));
  const completedMissingReview = chainTasks.filter((task) => task.kind === 'implementation'
    && task.status === 'completed' && !reviewTargets.has(task.id));
  const failedReviews = chainTasks.filter((task) => task.kind === 'review' && task.status === 'failed'
    && REVIEW_FAILURE_VERDICTS.has(task.verdict));
  const reviewFailedMissingRepair = failedReviews.filter((review) => review.verdict === 'needs_revision' && !tasks.some((task) => task.kind === 'repair'
    && task.status !== 'cancelled'
    && (task.findingSourceTaskIds ?? []).includes(review.id)));
  const repairCompletedMissingRereview = chainTasks.filter((task) => task.kind === 'repair'
    && task.status === 'completed' && !reviewTargets.has(task.id));
  const longUnclaimed = waiting.filter((task) => !task.assignee
    && now - asNumber(task.createdAt, now) >= intervalMs);

  // --- risk ---------------------------------------------------------------
  const recentAttempts = attempts.filter((attempt) => {
    const at = asNumber(attempt?.endedAt, 0) || asNumber(attempt?.startedAt, 0);
    return at >= from && at <= now;
  });
  const networkByTask = new Map();
  for (const attempt of recentAttempts) {
    const message = String(attempt?.error ?? '');
    if (!message || !NETWORK_ERROR_PATTERN.test(message)) continue;
    networkByTask.set(attempt.taskId, (networkByTask.get(attempt.taskId) ?? 0) + 1);
  }
  const repeatedErrors = [...networkByTask.entries()]
    .filter(([, count]) => count >= 2)
    .map(([taskId, count]) => ({ taskId, count }));

  const runtimeIssues = [];
  for (const task of active) {
    const attempt = attemptFor(task);
    const startedAt = asNumber(attempt?.startedAt, 0) || asNumber(task.claimedAt, 0);
    const member = memberByName.get(task.assignee);
    const lastActiveAt = asNumber(member?.lastActiveAt, 0) || startedAt;
    if (startedAt && now - startedAt > Math.max(1, taskTimeoutMinutes) * 60000) {
      runtimeIssues.push({ taskId: task.id, kind: 'timeout', minutes: now - startedAt });
    } else if (lastActiveAt && now - lastActiveAt > Math.max(1, noProgressMinutes) * 60000) {
      runtimeIssues.push({ taskId: task.id, kind: 'no-progress', minutes: now - lastActiveAt });
    }
  }

  const driftPaths = new Map();
  const scopeClassifications = new Map();
  for (const task of chainTasks) {
    if (Array.isArray(task.reviewedDuringDrift) && task.reviewedDuringDrift.length > 0) {
      driftPaths.set(task.id, [...(driftPaths.get(task.id) ?? []), ...task.reviewedDuringDrift]);
    }
    if (!['implementation', 'repair'].includes(task.kind) || task.status !== 'completed') continue;
    if (!Array.isArray(task.changedPaths) || task.changedPaths.length === 0) continue;
    const scope = Array.isArray(task.inScope) ? task.inScope : [];
    const excluded = Array.isArray(task.outOfScope) ? task.outOfScope : [];
    const counts = new Map();
    for (const path of task.changedPaths) {
      const classification = classifyChangedPath(path, scope, excluded);
      // Illegal paths are always actionable, even when the task has no declared
      // scope. Preserve the legacy no-scope behavior for ordinary paths.
      if (classification === 'illegal'
        || (scope.length > 0 && ['out_of_scope', 'undeclared'].includes(classification))) {
        counts.set(classification, (counts.get(classification) ?? 0) + 1);
      }
    }
    if (counts.size > 0) {
      driftPaths.set(task.id, [...(driftPaths.get(task.id) ?? []), ...counts.keys()]);
      scopeClassifications.set(task.id, Object.fromEntries(counts));
    }
  }
  const scopeDrift = [...driftPaths.keys()];

  const reviewsByTarget = new Map();
  for (const task of chainTasks) {
    if (task.kind !== 'review' || !task.reviewedTaskId) continue;
    const list = reviewsByTarget.get(task.reviewedTaskId) ?? [];
    list.push(task);
    reviewsByTarget.set(task.reviewedTaskId, list);
  }
  const consecutiveReviews = [];
  for (const [targetId, list] of reviewsByTarget.entries()) {
    const ordered = [...list].sort((left, right) => (asNumber(left.round, 1) - asNumber(right.round, 1))
      || (asNumber(left.createdAt, 0) - asNumber(right.createdAt, 0)));
    let rounds = 0;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const review = ordered[index];
      if (review.status !== 'failed' || !REVIEW_FAILURE_VERDICTS.has(review.verdict)) break;
      rounds += 1;
    }
    if (rounds >= 2) consecutiveReviews.push({ taskId: targetId, rounds });
  }

  const failedUnhandled = chainTasks.filter((task) => task.status === 'failed'
    && !tasks.some((item) => item.kind === 'repair'
    && item.status !== 'cancelled'
    && ((item.findingSourceTaskIds ?? []).includes(task.id)
      || (item.sourceTaskId !== undefined && (item.sourceTaskId === task.id || item.sourceTaskId === task.reviewedTaskId)))));

  // --- conclusion ---------------------------------------------------------
  const drift = scopeDrift.length > 0 || consecutiveReviews.length > 0;
  const chainCount = completedMissingReview.length + reviewFailedMissingRepair.length
    + repairCompletedMissingRereview.length + longUnclaimed.length;
  const bottleneck = (() => {
    if (waiting.length === 0) return null;
    if (teamQuota > 0 && freeSlots === 0) return `${waiting.length} pending task(s); worker slots full (${usedSlots}/${teamQuota})`;
    if (idleMembers.length === 0) return `${waiting.length} pending task(s); no idle eligible member`;
    if (stalledWaiting.length > 0) {
      return `${waiting.length} pending task(s); ${idleMembers.length} idle eligible member(s), ${freeSlots} free slot(s); undispatched for over ${asNumber(intervalMinutes, 15)} minutes (${stalledWaiting.map((item) => item.taskId).join(', ')})`;
    }
    return null;
  })();
  const risk = chainCount > 0 || repeatedErrors.length > 0 || runtimeIssues.length > 0
    || Boolean(bottleneck) || failedUnhandled.length > 0
    || (Boolean(team.control) && team.control !== 'active');
  const longButActive = executing.some((item) => item.runningMs > 60 * 60000);
  const attention = waiting.length > 0 || longButActive;
  const conclusion = drift ? 'off-course' : risk ? 'risk' : attention ? 'attention' : 'normal';
  const direction = drift ? 'off-course' : 'on-track';

  // --- suggestion actions -------------------------------------------------
  const swapCandidates = [...new Set(runtimeIssues
    .filter((item) => item.kind === 'no-progress')
    .map((item) => item.taskId))];
  const pauseCandidates = repeatedErrors.map((item) => item.taskId);
  const repairCandidates = [...new Set([
    ...reviewFailedMissingRepair.map((task) => task.id),
    ...failedUnhandled.filter((task) => task.kind !== 'review' || task.verdict === 'needs_revision').map((task) => task.id),
  ])];
  const escalateCandidates = [...new Set([
    ...scopeDrift,
    ...consecutiveReviews.map((item) => item.taskId),
    ...failedReviews.filter((review) => review.verdict === 'reject').map((review) => review.id),
  ])];
  const actions = {
    continue: active.map((task) => task.id),
    swap: swapCandidates,
    repair: repairCandidates,
    pause: pauseCandidates,
    escalate: escalateCandidates,
  };

  // --- text ---------------------------------------------------------------
  const roleCounts = new Map();
  for (const member of idleMembers) {
    const role = member.license?.roleKey ?? member.role ?? 'member';
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  const roleText = roleCounts.size > 0
    ? ` (${[...roleCounts.entries()].map(([role, count]) => `${role} ${count}`).join(' / ')})`
    : '';
  const chainLine = (label, items) => `- ${label}: ${items.length > 0 ? `${items.length} (${items.map((task) => task.id).join(', ')})` : EMPTY}`;

  const lines = [
    `[Patrol Report] ${team.name ?? team.id ?? 'team'} · ${formatStamp(now, locale, timeZone)} (window ${formatClock(from, locale, timeZone)}–${formatClock(now, locale, timeZone)})`,
    '',
    `Conclusion: ${conclusion}${drift ? '' : ` (${direction})`}`,
    '',
    '1. Overview',
    `- Unfinished: ${active.length + waiting.length + failed.length} (in progress ${active.length} / waiting ${waiting.length} / failed ${failed.length})`,
    `- Completed in window: ${completedInWindow.size}`,
    `- New failures in window: ${failedInWindow.size}`,
    '',
    '2. In progress',
    ...(executing.length > 0
      ? executing.map((item) => `- ${item.taskId} ${item.subject} · ${item.member} · running ${formatMinutes(item.runningMs)} · last activity ${formatMinutes(item.idleMs)} ago`)
      : [`- ${EMPTY}`]),
    '',
    '3. Waiting (member / slot / dependency)',
    ...(waitingReasons.length > 0
      ? waitingReasons.map((item) => `- ${item.taskId} ${item.subject} · ${item.reason}`)
      : [`- ${EMPTY}`]),
    '',
    '4. Broken chains',
    chainLine('Completed without review', completedMissingReview),
    chainLine('Review failed without repair', reviewFailedMissingRepair),
    chainLine('Repair completed without re-review', repairCompletedMissingRereview),
    chainLine(`Unclaimed (over ${asNumber(intervalMinutes, 15)} minutes)`, longUnclaimed),
    '',
    '5. Schedule and capacity',
    `- Worker slots: ${teamQuota}, used ${usedSlots}, free ${freeSlots}`,
    `- Idle eligible members: ${idleMembers.length}${roleText}`,
    `- Queue bottleneck: ${bottleneck ?? EMPTY}`,
    '',
    '6. Risks and errors',
    `- Repeated ECONNRESET/timeout: ${repeatedErrors.length > 0 ? repeatedErrors.map((item) => `${item.taskId} (${item.count} time(s))`).join(', ') : EMPTY}`,
    `- Runtime timeout / no progress: ${runtimeIssues.length > 0 ? runtimeIssues.map((item) => `${item.taskId} (${item.kind === 'timeout' ? 'running' : 'inactive'} ${formatMinutes(item.minutes)})`).join(', ') : EMPTY}`,
    `- Scope drift: ${joinIds(scopeDrift)}`,
    `- Scope classification: ${scopeClassifications.size > 0
      ? [...scopeClassifications].map(([taskId, counts]) => `${taskId} (${Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join(', ')})`).join(', ')
      : EMPTY}`,
    `- Consecutive review failures: ${consecutiveReviews.length > 0 ? consecutiveReviews.map((item) => `${item.taskId} (${item.rounds} round(s))`).join(', ') : EMPTY}`,
    '',
    '7. Suggested actions',
    `- Continue: ${joinIds(actions.continue)}`,
    `- Swap: ${joinIds(actions.swap)}`,
    `- Repair: ${joinIds(actions.repair)}`,
    `- Pause: ${joinIds(actions.pause)}`,
    `- Escalate to captain: ${joinIds(actions.escalate)}`,
    '',
    'Note: this report is read-only; it does not modify code, create tasks or merge.',
  ];

  return {
    text: lines.join('\n'),
    conclusion,
    direction,
    facts: {
      overview: {
        unfinished: active.length + waiting.length + failed.length,
        active: active.length,
        waiting: waiting.length,
        failed: failed.length,
        completedInWindow: completedInWindow.size,
        failedInWindow: failedInWindow.size,
      },
      executing,
      waiting: waitingReasons,
      chains: {
        completedMissingReview: completedMissingReview.map((task) => task.id),
        reviewFailedMissingRepair: reviewFailedMissingRepair.map((task) => task.id),
        repairCompletedMissingRereview: repairCompletedMissingRereview.map((task) => task.id),
        longUnclaimed: longUnclaimed.map((task) => task.id),
      },
      capacity: { quota: teamQuota, used: usedSlots, free: freeSlots, idleMembers: idleMembers.length, bottleneck },
      risks: {
        repeatedErrors,
        runtimeIssues,
        scopeDrift,
        scopeClassifications: Object.fromEntries(scopeClassifications),
        consecutiveReviews,
        failedUnhandled: failedUnhandled.map((task) => task.id),
      },
      actions,
    },
  };
}
