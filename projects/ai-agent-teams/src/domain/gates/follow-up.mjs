/** Failed-gate routing: requirements retry, verification repair/recheck and legacy review adaptation. Pure logic; no I/O. */
import { allFindingsExcluded, repairScopeReport } from '../repair-scope.mjs';
import { findingsFingerprint, closedLoopRound, closedLoopReviewTaskId, reviewDeliveryGeneration, deriveRepairObjective } from './identity.mjs';
import { planFailedReviewFollowUp } from './review-repair.mjs';
import { repairAttemptLimit, TERMINAL } from './policy.mjs';
import { classifyChangedPath } from '../changes.mjs';
import { isCurrentReview } from '../delivery-review.mjs';

/**
 * Plan the automatic follow-up for a failed gate. Reviews delegate to the
 * closed-loop planner (one repair, then the repair's completion creates the
 * re-review), requirements and verification self-heal, and implementation or
 * repair failures are left to the captain.
 * @param {any} task
 * @param {Array<any>} tasks
 * @param {any} [policy]
 * @returns {{ created: Array<any>, escalated?: boolean, reason?: string }}
 */
export function planFollowUp(task, tasks = [], policy = {}) {
  if (!task || (task.status !== 'failed' && !(task.status === 'completed'
    && task.kind === 'review' && task.verdict !== 'pass'))) return { created: [] };
  const kind = task.kind ?? 'work';
  if (kind === 'review') return planLegacyReviewFollowUp(task, tasks, policy);
  if (kind !== 'requirements' && kind !== 'verification') return { created: [] };

  const nextRound = (task.round ?? 1) + 1;
  const maxRounds = kind === 'requirements'
    ? (policy.requirementsMaxRounds ?? 2)
    : (policy.maxReviewRounds ?? policy.codeMaxRounds ?? 3);
  if (nextRound > maxRounds) {
    return { created: [], escalated: true, reason: `${task.id} reached the ${kind} round ceiling (${maxRounds})` };
  }

  const findings = (task.findings ?? []).filter((finding) => !finding?.resolved);
  if (allFindingsExcluded(findings)) {
    return { created: [], escalated: true, reason: `${task.id} findings cite only default-excluded paths` };
  }
  const findingAcceptance = findings.map((finding) => finding.requiredFix).filter(Boolean);
  const findingIds = findings.map((finding) => finding.id).filter(Boolean);
  const fingerprint = findingsFingerprint(findings);

  if (kind === 'requirements') {
    return {
      created: [{
        id: `requirements-${task.id}-r${nextRound}`,
        teamId: task.teamId,
        kind: 'requirements',
        subject: `requirements-round-${nextRound}`,
        status: 'pending',
        assignee: task.assignee,
        dependencies: [],
        round: nextRound,
        objective: task.objective,
        acceptance: findingAcceptance.length > 0 ? findingAcceptance : task.acceptance,
        sourceFindingIds: findingIds,
      }],
    };
  }

  return planVerificationFollowUp(task, tasks, policy, nextRound, {
    findings, findingAcceptance, findingIds, fingerprint,
  });
}

/**
 * The review state of the legacy planner: one repair plus the follow-up review
 * whose id is the closed-loop id for that repair. The service itself creates
 * only the repair and lets repair completion create the review, so both paths
 * agree on ids and cannot double-create.
 * @param {any} task
 * @param {Array<any>} tasks
 * @param {any} policy
 */
function planLegacyReviewFollowUp(task, tasks, policy) {
  const follow = planFailedReviewFollowUp({ task, tasks, policy });
  if (follow.action === 'escalate' || follow.escalated || follow.needsCaptain === true) {
    return {
      created: [],
      escalated: true,
      ...(follow.deduplicated ? { deduplicated: true } : {}),
      ...(Array.isArray(follow.warnings) && follow.warnings.length > 0 ? { warnings: follow.warnings } : {}),
      reason: follow.reason,
    };
  }
  if (follow.deduplicated
    || (follow.action === 'none' && /repair-exists|already-planned|duplicate/i.test(String(follow.reason ?? '')))) {
    return { created: [], deduplicated: true, reason: follow.reason };
  }
  if (follow.action !== 'repair') return { created: [], ...(follow.reason ? { reason: follow.reason } : {}) };
  const repair = follow.task ?? (follow.created ?? []).find((item) => item.kind === 'repair');
  if (!repair) return { created: [] };
  const nextRound = closedLoopRound(repair) + 1;
  const recheck = {
    id: closedLoopReviewTaskId(repair.id),
    teamId: repair.teamId,
    kind: 'review',
    subject: `review-round-${nextRound}`,
    status: 'pending',
    assignee: task.assignee,
    assigneeRole: task.assigneeRole,
    dependencies: [repair.id],
    round: nextRound,
    deliveryGeneration: reviewDeliveryGeneration(repair, tasks),
    objective: task.objective,
    acceptance: task.acceptance,
    reviewedTaskId: repair.id,
  };
  return {
    created: [repair, recheck],
    ...(Array.isArray(follow.warnings) && follow.warnings.length > 0 ? { warnings: follow.warnings } : {}),
  };
}

function planVerificationFollowUp(task, tasks, policy, nextRound, { findings, findingAcceptance, findingIds, fingerprint }) {
  const sourceId = task.sourceTaskId ?? task.dependencies?.[0];
  const source = tasks.find((item) => item.id === sourceId);
  if (!sourceId) {
    return { created: [], escalated: true, reason: `${task.id} has no source task for repair` };
  }
  if (!source) {
    return { created: [], escalated: true, reason: `${task.id} references missing source ${sourceId}` };
  }

  // Idempotency: the same trigger or the same finding set never plans twice.
  const repairId = `repair-${task.id}-r${nextRound}`;
  const sameTrigger = tasks.find((item) => item.id === repairId);
  if (sameTrigger) {
    return { created: [], deduplicated: true, reason: `${repairId} is already planned` };
  }
  const sameFindings = tasks.filter((item) => item.kind === 'repair'
    && item.sourceTaskId === sourceId
    && typeof item.findingsFingerprint === 'string'
    && item.findingsFingerprint === fingerprint);
  const openMatch = sameFindings.find((item) => !TERMINAL.includes(item.status));
  if (openMatch) {
    return { created: [], deduplicated: true, reason: `${openMatch.id} already covers the same findings as ${task.id}` };
  }
  const finishedMatch = sameFindings.find((item) => item.status === 'completed');
  if (finishedMatch) {
    return {
      created: [],
      escalated: true,
      deduplicated: true,
      reason: `${finishedMatch.id} completed but the same findings from ${task.id} are still open; a human must decide`,
    };
  }

  const hasOpenFollowUp = tasks.some((item) => item.kind === 'repair'
    && item.sourceTaskId === sourceId
    && (item.findingSourceTaskIds ?? []).includes(task.id)
    && !TERMINAL.includes(item.status));
  if (hasOpenFollowUp) return { created: [], deduplicated: true };

  const repairAttempts = tasks.filter((item) => item.kind === 'repair' && item.sourceTaskId === sourceId).length;
  const maxRepairs = repairAttemptLimit(policy);
  if (repairAttempts >= maxRepairs) {
    return { created: [], escalated: true, reason: `${sourceId} already used ${maxRepairs} repair attempts` };
  }

  const scopeReport = repairScopeReport(findings, source?.inScope ?? []);
  if (scopeReport.source === 'findings' && scopeReport.scope.some((path) => classifyChangedPath(
    path.endsWith('/') ? `${path}__scope_probe__` : path,
    source?.inScope ?? [], source?.outOfScope ?? [],
  ) !== 'in_scope')) {
    return { created: [], escalated: true, reason: `${task.id} findings exceed the source task's authorized scope` };
  }
  if (scopeReport.scope.length === 0) {
    return {
      created: [],
      escalated: true,
      warnings: scopeReport.warnings,
      reason: `${task.id} findings name no workspace path and ${sourceId} declares no inScope`,
    };
  }

  const parentReview = tasks.find((item) => item?.kind === 'review'
    && item.reviewedTaskId === source.id && item.status === 'completed' && item.verdict === 'pass'
    && isCurrentReview(item, tasks)
    && item.binding?.deliveryUnitId === (source.deliveryUnitId ?? source.id)
    && item.binding?.sourceCommit === source.sourceCommit);
  const boundSource = source.mode === 'bound' && Boolean(source.deliveryUnitId)
    && Number.isInteger(source.deliverySeq) && Boolean(source.sourceCommit) && Boolean(parentReview);
  const repairSeq = boundSource
    ? Math.max(0, ...tasks.flatMap((item) => [
      item?.deliveryUnitId === source.deliveryUnitId && Number.isInteger(item.deliverySeq) ? item.deliverySeq : -1,
      item?.binding?.deliveryUnitId === source.deliveryUnitId && Number.isInteger(item.binding.deliverySeq)
        ? item.binding.deliverySeq : -1,
    ])) + 1
    : undefined;
  const repair = {
    id: repairId,
    teamId: task.teamId,
    kind: 'repair',
    subject: `repair-round-${nextRound}`,
    status: 'pending',
    assignee: source?.assignee ?? task.assignee,
    dependencies: sourceId ? [sourceId] : [],
    round: nextRound,
    objective: deriveRepairObjective(findings, {
      sourceTaskId: sourceId,
      findingSourceTaskId: task.id,
      round: nextRound,
      verdict: task.verdict,
    }),
    acceptance: findingAcceptance.length > 0 ? findingAcceptance : ['Fix the failed verification'],
    inScope: scopeReport.scope,
    outOfScope: [...(source?.outOfScope ?? [])],
    verify: source?.verify ?? task.verify ?? [],
    sourceTaskId: sourceId,
    // A verification/requirements failure may inherit the unit only when the
    // source has a current pass review whose binding is the same artifact.
    // Otherwise it is a legacy repair from the source commit.
    ...(boundSource ? {
      mode: 'bound',
      repairOrigin: 'planner',
      parentReviewTaskId: parentReview.id,
      deliveryUnitId: source.deliveryUnitId,
      deliveryGeneration: source.taskEpoch ?? 0,
      deliverySeq: repairSeq,
      sourceBase: source.sourceCommit,
    } : {
      mode: 'legacy',
      repairOrigin: 'planner',
      legacyUnbound: false,
      bindingUnavailable: true,
      ...(source?.sourceCommit ? { sourceBase: source.sourceCommit } : {}),
    }),
    sourceFindingIds: findingIds,
    findingsFingerprint: fingerprint,
    scopeSource: scopeReport.source,
    findingSourceTaskIds: [task.id],
  };
  const recheck = {
    id: `verification-${task.id}-r${nextRound}`,
    teamId: task.teamId,
    kind: 'verification',
    subject: `verification-round-${nextRound}`,
    status: 'pending',
    assignee: task.assignee,
    dependencies: [repair.id],
    round: nextRound,
    objective: task.objective,
    acceptance: task.acceptance,
    verify: source?.verify ?? task.verify ?? [],
  };
  return { created: [repair, recheck] };
}
