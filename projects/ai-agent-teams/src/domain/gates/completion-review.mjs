/** Review admission, current-review selection and deterministic review construction. Pure logic; no I/O. */
import { isInactiveHistory, selectCurrentReview } from '../delivery-review.mjs';
import { CLOSED_LOOP_REVIEW_KINDS, CLOSED_LOOP_DEFAULT_MAX_ROUNDS } from './policy.mjs';
import { closedLoopRound, closedLoopTaskId, closedLoopReviewTaskId, reviewDeliveryGeneration } from './identity.mjs';
import { pickReviewAssignee } from './members.mjs';
import { REVIEW_SCORE_MIN_OVERALL, REVIEW_SCORE_MIN_CODE } from './findings.mjs';

/**
 * Plan the review task for a completed implementation/repair.
 * The id is deterministic (`review-<taskId>`) and an existing review of the
 * same task (manual or automatic, any status) always wins, so a restart or a
 * repeated scan cannot create a second one.
 * @param {{ task: any, tasks?: Array<any>, members?: Array<any>, policy?: any }} input
 * @returns {{ action: 'create'|'none'|'escalate', task?: any, round?: number, reason?: string, existingTaskId?: string }}
 */
export function planCompletionReview({ task, tasks = [], members = [], policy = {} } = {}) {
  if (!task || task.status !== 'completed') return { action: 'none', reason: 'not-completed' };
  if (isInactiveHistory(task) || task.legacyUnbound === true || task.legacyRepair === true) {
    return { action: 'none', reason: 'task-is-historical-or-unbound' };
  }
  if (!CLOSED_LOOP_REVIEW_KINDS.includes(task.kind ?? 'work')) {
    return { action: 'none', reason: 'kind-not-reviewable' };
  }
  if (task.hidden === true) return { action: 'none', reason: 'task-is-hidden' };
  const bound = task.mode === 'bound';
  if (bound && (!task.sourceCommit || !task.sourceBase || !task.diffHash || !task.deliveryUnitId
    || !Number.isInteger(task.deliverySeq) || task.deliverySeq < 0)) {
    return { action: 'none', needsCaptain: true, reason: 'bound-review-artifact-incomplete' };
  }
  if (bound && task.kind === 'implementation'
    && (task.deliveryUnitId !== task.id || task.deliverySeq !== 0)) {
    return { action: 'none', needsCaptain: true, reason: 'bound-root-unit-mismatch' };
  }
  const activeReviews = tasks.filter((item) => item?.kind === 'review' && item.reviewedTaskId === task.id
    && !isInactiveHistory(item) && item.status !== 'cancelled'
    && (!bound || (item.binding?.sourceCommit === task.sourceCommit
      && (item.deliveryGeneration ?? 0) === (task.deliveryGeneration ?? task.taskEpoch ?? 0))));
  // Pick the current row explicitly; find() made the plan depend on row order
  // when a task had both an old pass and an old failed review.
  const existing = selectCurrentReview(activeReviews, bound ? 'bound' : 'legacy');
  if (existing) {
    if (!bound && task.sourceCommit && existing.reviewedSourceCommit !== task.sourceCommit) {
      // Supersede stale pass and active rows only. A failed review is evidence
      // for the commit it inspected, not for the new artifact, and must stay
      // available as the repair basis.
      const staleActive = activeReviews.filter((item) =>
        ['pending', 'claimed', 'in_progress'].includes(item.status)
        && item.bindingPending !== true && item.reviewedSourceCommit !== task.sourceCommit);
      const stalePasses = activeReviews.filter((item) =>
        item.status === 'completed' && item.verdict === 'pass'
        && item.reviewedSourceCommit !== task.sourceCommit);
      if (staleActive.length > 0 || stalePasses.length > 0) {
        const staleReviewIds = [...new Set([...staleActive, ...stalePasses].map((item) => item.id))];
        return { action: 'supersede_legacy_reviews', reason: 'legacy-review-source-changed',
          expectedSourceCommit: task.sourceCommit, staleReviewIds, existingTaskId: existing.id };
      }
      if (existing.status === 'completed') {
        return { action: 'none', needsCaptain: true, reason: 'legacy-review-source-changed',
          existingTaskId: existing.id };
      }
    }
    return { action: 'none', reason: 'review-exists', existingTaskId: existing.id };
  }
  const unitReviews = bound ? tasks.filter((item) => item?.kind === 'review'
    && item.binding?.deliveryUnitId === task.deliveryUnitId) : [];
  const ownReviews = tasks.filter((item) => item?.kind === 'review' && item.reviewedTaskId === task.id);
  const reviewEpoch = bound ? Math.max(0, ...ownReviews.map((item) => Number.isInteger(item.reviewEpoch) ? item.reviewEpoch : 0)) + 1 : undefined;
  const legacyEpoch = !bound && ownReviews.length > 0
    ? Math.max(0, ...[task.legacyReviewEpoch, ...ownReviews.flatMap((item) => [item.legacyReviewEpoch, item.reviewEpoch])]
      .filter((value) => Number.isSafeInteger(value) && value >= 0)) + 1 : undefined;
  const unitReviewSeq = bound ? Math.max(0, ...unitReviews.map((item) => Number.isInteger(item.unitReviewSeq) ? item.unitReviewSeq : 0)) + 1 : undefined;
  const round = task.kind === 'repair' ? closedLoopRound(task) + 1 : 1;
  const maxRounds = Number.isInteger(policy.codeMaxRounds) && policy.codeMaxRounds > 0
    ? policy.codeMaxRounds
    : CLOSED_LOOP_DEFAULT_MAX_ROUNDS;
  if (round > maxRounds) {
    return {
      action: 'escalate',
      round,
      reason: `${task.id} would need review round ${round}, above the ceiling (${maxRounds})`,
    };
  }
  const assignee = pickReviewAssignee(members, task, policy.requiredReviewers ?? [], tasks);
  const acceptance = Array.isArray(task.acceptance) && task.acceptance.length > 0
    ? task.acceptance
    : ['the review verdict is evidence-backed'];
  return {
    action: 'create',
    round,
    task: {
      id: bound ? closedLoopTaskId('review-', `${task.id}-b${reviewEpoch}`)
        : legacyEpoch ? closedLoopTaskId('review-', `${task.id}-e${legacyEpoch}`) : closedLoopReviewTaskId(task.id),
      teamId: task.teamId,
      subject: `Review ${task.subject ?? task.id}`,
      kind: 'review',
      status: 'pending',
      dependencies: [task.id],
      round,
      reviewedTaskId: task.id,
      ...(bound ? {
        reviewMode: 'bound', reviewEpoch, unitReviewSeq,
        deliveryGeneration: task.deliveryGeneration ?? task.taskEpoch ?? 0,
        binding: { deliveryUnitId: task.deliveryUnitId, deliverySeq: task.deliverySeq,
          sourceTaskId: task.id, sourceAttemptId: task.lastAttemptId,
          sourceBase: task.sourceBase, sourceCommit: task.sourceCommit, diffHash: task.diffHash },
      } : { reviewMode: 'legacy', ...(legacyEpoch ? { legacyReviewEpoch: legacyEpoch } : {}),
        deliveryGeneration: reviewDeliveryGeneration(task, tasks),
        ...(task.sourceCommit ? { reviewedSourceCommit: task.sourceCommit } : {}) }),
      objective: `Independently review ${task.id} (${task.kind ?? 'work'}) against its acceptance, evidence, and changed paths. The implementer must not review its own work. When scores are reported they must reach overall >= ${REVIEW_SCORE_MIN_OVERALL} and code >= ${REVIEW_SCORE_MIN_CODE} to pass.`,
      acceptance,
      assigneeRole: 'reviewer',
      ...assignee,
      closedLoop: { origin: 'closed-loop', anchorTaskId: task.id, round },
    },
  };
}
