/** Independent final audit: team state, row evidence and latest-delivery review independence. Pure logic; no I/O. */
import { isInactiveHistory, isCurrentReview } from '../delivery-review.mjs';
import { acceptanceCovered, commandsCovered } from './completion.mjs';
import { classifyChangedPath } from '../changes.mjs';
import { QUALITY_KINDS } from './policy.mjs';
import { validateFindings, boundOverallScoreSatisfied, boundReviewScoresSatisfied, openHighFindings } from './findings.mjs';
import { sameActor } from './members.mjs';

/**
 * Independent delivery audit. This is separate from task completion.
 * @param {{ phase?: string, control?: string, tasks?: Array<any>, requiredReviewers?: string[] }} team
 * @param {{ allowSelfReview?: boolean }} [options]
 * @returns {{ ok: boolean, blockers: string[], warnings: string[] }}
 */
export function deliveryAudit(team = {}, options = {}) {
  const tasks = Array.isArray(team.tasks) ? team.tasks : [];
  const isHistoricalRow = (task) => task && (isInactiveHistory(task)
    || (!task.repairOrigin && Number.isFinite(task.quarantinedAt) && task.quarantinedAt > 0
      && (task.legacyRepair === true || task.legacyUnbound === true)));
  const auditTasks = tasks.filter((task) => !isHistoricalRow(task));
  const allowSelfReview = options.allowSelfReview === true;
  const byId = new Map(auditTasks.map((task) => [task.id, task]));
  const blockers = [];
  const warnings = tasks.filter(isHistoricalRow).map((task) => `${task.id ?? 'unknown'} is historical and was excluded from delivery audit`);

  if (team.phase === 'staged') blockers.push('team plan is awaiting approval');
  // Any non-active control blocks delivery; this also covers legacy persisted
  // values such as the removed budget_paused state.
  if (team.control && team.control !== 'active') {
    blockers.push(`team control is ${team.control}`);
  }
  if (auditTasks.length === 0) blockers.push('team has no tasks');
  if (auditTasks.length > 0 && auditTasks.every((task) => task.status === 'cancelled')) blockers.push('all work was cancelled');

  auditTaskRows(tasks, auditTasks, byId, blockers, warnings);
  auditLatestDeliveryReviews(team, auditTasks, byId, allowSelfReview, blockers);

  return { ok: blockers.length === 0, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)] };
}

function checkArtifactBinding(task, blockers) {
  if ((task.reviewedDuringDrift ?? []).length > 0) blockers.push(`${task.id} was reviewed during drift`);
  if ((task.reviewedGaps ?? []).length > 0) blockers.push(`${task.id} has an incomplete artifact audit`);
  if ((task.reviewedArtifacts ?? []).some((artifact) => artifact?.unreadable === true)) {
    blockers.push(`${task.id} has an unreadable reviewed artifact`);
  }
}

function checkEvidence(task, requireChangedPaths, blockers) {
  const findingsOnly = task.kind === 'repair' && task.contractSource === 'findings';
  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0
    || (!findingsOnly && (!Array.isArray(task.verify) || task.verify.length === 0))) {
    blockers.push(`${task.id} has an empty acceptance/verify contract`);
    return;
  }
  if (!acceptanceCovered(task.acceptance, task.acceptanceResults ?? [])) {
    blockers.push(`${task.id} has incomplete acceptanceResults`);
  }
  if (!findingsOnly && !commandsCovered(task.verify, task.commandsRun ?? [])) {
    blockers.push(`${task.id} has incomplete commandsRun`);
  }
  if (!requireChangedPaths) return;
  if (!Array.isArray(task.changedPaths) || task.changedPaths.length === 0) {
    blockers.push(`${task.id} has no changedPaths`);
    return;
  }
  for (const path of task.changedPaths) {
    const classification = classifyChangedPath(path, task.inScope ?? [], task.outOfScope ?? []);
    if (classification !== 'in_scope') blockers.push(`${task.id} has unaudited path ${path}`);
  }
}

function auditTaskRows(tasks, auditTasks, byId, blockers, warnings) {
  for (const task of auditTasks) {
    const kind = task.kind ?? 'work';
    const isQuality = QUALITY_KINDS.includes(kind);
    if (!isQuality) {
      if (!['completed', 'cancelled'].includes(task.status)) blockers.push(`${task.id} (${kind}) is not completed`);
      continue;
    }
    if (task.status === 'completed') {
      if (kind === 'review' || kind === 'requirements') {
        const findingErrors = validateFindings(task.findings ?? []);
        if (findingErrors.length > 0) blockers.push(`${task.id}: ${findingErrors.join('; ')}`);
        if (task.verdict !== 'pass') blockers.push(`${task.id} completed without verdict=pass`);
        if (kind === 'review' && (task.reviewMode === 'bound' || (!task.reviewMode && task.binding?.sourceCommit))
          && !(byId.get(task.reviewedTaskId)?.kind === 'work'
            ? boundOverallScoreSatisfied(task.scores) : boundReviewScoresSatisfied(task.scores))) {
          blockers.push(`${task.id} bound review lacks required scores`);
        }
        if (openHighFindings(task.findings ?? []).length > 0) blockers.push(`${task.id} pass leaves an open high/blocker finding`);
        checkArtifactBinding(task, blockers);
        if (kind === 'review') {
          if (typeof task.reviewedTaskId !== 'string' || !task.reviewedTaskId) {
            blockers.push(`${task.id} has no reviewedTaskId`);
          } else {
            const reviewed = byId.get(task.reviewedTaskId);
            if (!reviewed) blockers.push(`${task.id} references missing task ${task.reviewedTaskId}`);
            else {
              if (!['implementation', 'repair'].includes(reviewed.kind)) blockers.push(`${task.id} reviews a non-implementation task`);
              if (reviewed.status !== 'completed') blockers.push(`${task.id} reviews an unfinished task ${reviewed.id}`);
              if (Number.isInteger(task.reviewedAttempt)
                && Number.isInteger(reviewed.attempt)
                && task.reviewedAttempt !== reviewed.attempt) {
                blockers.push(`${task.id} reviewed ${reviewed.id} attempt ${task.reviewedAttempt}, but it is now attempt ${reviewed.attempt}`);
              }
            }
          }
        }
      }
      if (kind === 'implementation' || kind === 'repair') {
        checkEvidence(task, true, blockers);
        if (task.worktree && task.mergeState !== 'merged') {
          blockers.push(`${task.id} is not cleanly merged (${task.mergeState ?? 'none'})`);
        } else if (['pending', 'conflict', 'rejected', 'ff_failed', 'review_pending', 'review_pending_internal', 'revert_failed'].includes(task.mergeState)) {
          blockers.push(`${task.id} is not cleanly merged (${task.mergeState})`);
        }
        checkArtifactBinding(task, blockers);
      }
      if (kind === 'verification' || kind === 'integration') {
        checkEvidence(task, false, blockers);
      }
      continue;
    }
    if (task.status === 'failed') {
      if (kind === 'implementation' && (task.deliveryUnitId === task.id || task.deliverySeq === 0)) {
        const reviews = auditTasks.filter((item) => item.kind === 'review'
          && item.status === 'completed' && item.verdict === 'pass'
          && isCurrentReview(item, tasks)
          && (item.binding?.deliveryUnitId === task.id
            || ((item.reviewMode === 'legacy' || (!item.reviewMode && !item.binding?.sourceCommit))
              && auditTasks.some((candidate) => candidate.id === item.reviewedTaskId
              && candidate.kind === 'repair' && candidate.sourceTaskId === task.id))));
        if (reviews.length !== 1) {
          blockers.push(`${task.id}: review_required`);
          continue;
        }
        const review = reviews[0];
        const repair = byId.get(review.reviewedTaskId);
        const commit = review.reviewMode === 'legacy' || !review.binding?.sourceCommit
          ? review.reviewedSourceCommit : review.binding.sourceCommit;
        const bound = review.reviewMode === 'bound' || (review.reviewMode !== 'legacy' && Boolean(review.binding?.sourceCommit));
        if (!repair || repair.kind !== 'repair' || repair.status !== 'completed'
          || !commit || commit !== repair.sourceCommit
          || (bound && (review.binding?.deliveryUnitId !== task.id || repair.deliveryUnitId !== task.id
            || repair.sourceTaskId !== task.id
            || repair.deliveryGeneration !== (task.taskEpoch ?? 0)
            || review.deliveryGeneration !== (task.taskEpoch ?? 0)
            || !Number.isInteger(repair.deliverySeq) || repair.deliverySeq <= 0
            || review.binding?.deliverySeq !== repair.deliverySeq))
          || (!bound && repair.deliveryUnitId && repair.deliveryUnitId !== task.id)) {
          blockers.push(`${task.id}: review_delivery_mismatch`);
          continue;
        }
        const receipt = Boolean(repair.mergedCommit) && repair.mergeCommit === commit;
        if (task.mergeReverted === true || repair.mergeReverted === true || !receipt
          || (repair.mergeState !== 'merged' && task.closedLoop?.deliveredBy !== repair.id)) {
          blockers.push(`${task.id}: unit_not_merged`);
        }
        if (!Array.isArray(task.acceptance) || task.acceptance.length === 0
          || !acceptanceCovered(task.acceptance, review.acceptanceResults ?? [])) {
          blockers.push(`${task.id}: root acceptance not covered`);
        }
        continue;
      }
      const hasFollowUp = auditTasks.some((item) => item.kind === 'repair' && item.status !== 'cancelled'
        && ((item.findingSourceTaskIds ?? []).includes(task.id)
          || (item.sourceTaskId !== undefined && item.sourceTaskId === task.reviewedTaskId)
          || (item.sourceTaskId !== undefined && item.sourceTaskId === task.sourceTaskId)));
      if (!hasFollowUp) blockers.push(`${task.id} failed without a follow-up repair`);
      continue;
    }
    if (task.status === 'cancelled') {
      warnings.push(`${task.id} was cancelled`);
      continue;
    }
    blockers.push(`${task.id} (${kind}) is not completed`);
  }
}

function auditLatestDeliveryReviews(team, auditTasks, byId, allowSelfReview, blockers) {
  const implementations = auditTasks.filter((task) => ['implementation', 'repair'].includes(task.kind) && task.status === 'completed');
  const deliveryRoot = (task) => {
    let cursor = task;
    const seen = new Set();
    while (cursor?.kind === 'repair' && cursor.sourceTaskId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parent = byId.get(cursor.sourceTaskId);
      if (!parent) break;
      cursor = parent;
    }
    return cursor?.deliveryUnitId ?? cursor?.id ?? task.id;
  };
  const deliveryOrder = (task) => [
    Number.isInteger(task.deliverySeq) ? task.deliverySeq : 0,
    task.round ?? 0,
    task.updatedAt ?? 0,
    task.createdAt ?? 0,
  ];
  const supersedes = (later, earlier) => {
    if (later.kind === 'repair' && earlier.kind !== 'repair') return true;
    const left = deliveryOrder(later);
    const right = deliveryOrder(earlier);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] > right[index];
    }
    return false;
  };
  for (const implementation of implementations) {
    const newerDelivery = implementations.some((other) => other.id !== implementation.id
      && deliveryRoot(other) === deliveryRoot(implementation) && supersedes(other, implementation));
    if (newerDelivery) continue;
    const reviews = auditTasks.filter((task) => task.kind === 'review'
      && task.status === 'completed'
      && task.verdict === 'pass'
      && task.reviewedTaskId === implementation.id);
    if (reviews.length === 0) blockers.push(`${implementation.id} has no passing review`);
    for (const review of reviews) {
      if (!allowSelfReview && (!review.assignee || !implementation.assignee || sameActor(review, implementation))) {
        blockers.push(`${implementation.id} review is not independent`);
      }
    }
    for (const reviewer of team.requiredReviewers ?? []) {
      if (reviewer === implementation.assignee) {
        blockers.push(`required reviewer ${reviewer} is also the implementer of ${implementation.id}`);
        continue;
      }
      const reviewed = reviews.some((review) => review.assignee === reviewer);
      if (!reviewed) blockers.push(`required reviewer ${reviewer} has no passing review for ${implementation.id}`);
    }
  }
}
