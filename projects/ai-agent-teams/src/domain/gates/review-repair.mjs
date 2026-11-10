/** Failed-review repair planning: source binding, repair history and authorized repair contract. Pure logic; no I/O. */
import { isInactiveHistory, isCurrentReview } from '../delivery-review.mjs';
import { closedLoopRound, closedLoopRepairTaskId, deriveRepairObjective, findingsFingerprint } from './identity.mjs';
import { CLOSED_LOOP_REVIEW_KINDS, CLOSED_LOOP_DEFAULT_MAX_ROUNDS, repairAttemptLimit, TERMINAL } from './policy.mjs';
import { unresolvedFindings } from './findings.mjs';
import { allFindingsExcluded, repairScopeReport } from '../repair-scope.mjs';
import { classifyChangedPath } from '../changes.mjs';
import { pickRepairAssignee } from './members.mjs';

/**
 * Plan the repair task for a failed review, or report why the loop must stop
 * and hand the chain to the captain.
 * The id is deterministic (`repair-<reviewTaskId>`) and an existing repair for
 * that review (any status) always wins.
 * @param {{ task: any, tasks?: Array<any>, members?: Array<any>, policy?: any }} input
 * @returns {{ action: 'repair'|'none'|'escalate'|'link', task?: any, round?: number, reason?: string, existingTaskId?: string }}
 */
export function planFailedReviewFollowUp({ task, tasks = [], members = [], policy = {} } = {}) {
  if (!task || !['failed', 'completed'].includes(task.status) || (task.kind ?? 'work') !== 'review'
    || (task.status === 'completed' && task.verdict === 'pass')) {
    return { action: 'none', reason: 'not-a-terminal-negative-review' };
  }
  if (isInactiveHistory(task) || task.legacyUnbound === true) {
    return { action: 'none', reason: 'review-is-historical-or-unbound' };
  }
  if (task.hidden === true) return { action: 'none', reason: 'task-is-hidden' };
  if (task.closedLoop?.state === 'escalated') return { action: 'none', reason: 'already-escalated' };
  const round = closedLoopRound(task);
  if (task.verdict === 'reject') {
    return { action: 'escalate', round, reason: `${task.id} returned verdict=reject; a human must decide` };
  }
  if (task.verdict !== 'needs_revision') {
    return { action: 'escalate', round, reason: `${task.id} has no actionable needs_revision verdict` };
  }
  if (task.closedLoop?.state === 'manual-repair') return { action: 'none', reason: 'manual-repair-linked' };
  // Reviews from older planners may carry the source in their dependencies.
  // Validate it even when an existing repair would otherwise short-circuit.
  const reviewedId = task.reviewedTaskId ?? task.sourceTaskId ?? task.dependencies?.[0];
  if (!reviewedId) return { action: 'escalate', round, reason: `${task.id} has no reviewedTaskId` };
  const reviewed = tasks.find((item) => item?.id === reviewedId);
  if (!reviewed) return { action: 'escalate', round, reason: `${task.id} references missing source ${reviewedId}` };
  if (task.teamId && reviewed.teamId && task.teamId !== reviewed.teamId) {
    return { action: 'escalate', round, reason: `${task.id} reviews source ${reviewedId} in another team` };
  }
  if (reviewed.status !== 'completed' || isInactiveHistory(reviewed)) {
    return { action: 'escalate', round, reason: `${task.id} reviews source ${reviewedId} that is not completed or active` };
  }
  if (!CLOSED_LOOP_REVIEW_KINDS.includes(reviewed.kind ?? 'work')) {
    return { action: 'escalate', round, reason: `${task.id} reviews a non-implementation task (${reviewed.id})` };
  }
  const bound = task.reviewMode === 'bound'
    || (task.reviewMode !== 'legacy' && Boolean(task.binding?.sourceCommit));
  const unitId = bound ? task.binding?.deliveryUnitId : undefined;
  const source = bound ? tasks.find((item) => item?.id === unitId) : reviewed;
  if (bound && (!unitId || !task.binding?.sourceCommit || !source || source.kind !== 'implementation'
    || source.teamId !== task.teamId || source.status !== 'completed' || isInactiveHistory(source)
    || source.deliveryUnitId !== unitId || (source.deliverySeq ?? 0) !== 0
    || (reviewed.id !== unitId && reviewed.deliveryUnitId !== unitId)
    || reviewed.sourceCommit !== task.binding.sourceCommit
    || !Number.isInteger(task.binding.deliverySeq) || task.binding.deliverySeq !== (reviewed.deliverySeq ?? 0)
    || (task.deliveryGeneration ?? 0) !== (source.taskEpoch ?? 0)
    || !isCurrentReview(task, tasks))) {
    return { action: 'escalate', round, reason: `${task.id} has an invalid or incomplete delivery binding` };
  }
  const sourceId = source.id;
  const existing = tasks.find((item) => item?.kind === 'repair' && (
    item.id === closedLoopRepairTaskId(task.id)
    || (Array.isArray(item.findingSourceTaskIds) && item.findingSourceTaskIds.includes(task.id))
  ));
  if (existing && (['failed', 'cancelled'].includes(existing.status) || isInactiveHistory(existing))) {
    return { action: 'escalate', round, reason: `${existing.id} is failed, cancelled or historical; a human must decide before retrying` };
  }
  if (existing) return { action: 'none', reason: 'repair-exists', existingTaskId: existing.id };
  const findings = unresolvedFindings(task.findings);
  if (findings.length === 0) {
    return { action: 'escalate', round, reason: `${task.id} failed without an actionable finding list` };
  }
  const history = reviewRepairHistory(task, tasks, policy, round, sourceId, findings);
  if (history.decision) return history.decision;
  const { fingerprint } = history;
  if (allFindingsExcluded(findings)) {
    return { action: 'escalate', round, reason: `${task.id} findings cite only default-excluded file paths` };
  }
  const scopeReport = repairScopeReport(findings, source.inScope ?? []);
  const inScope = scopeReport.scope;
  if (scopeReport.source === 'findings' && inScope.some((path) => classifyChangedPath(
    path.endsWith('/') ? `${path}__scope_probe__` : path,
    source.inScope ?? [], source.outOfScope ?? [],
  ) !== 'in_scope')) {
    return { action: 'escalate', round, reason: `${task.id} findings exceed the source task's authorized scope` };
  }
  if (inScope.length === 0) {
    return {
      action: 'escalate',
      round,
      warnings: scopeReport.warnings,
      reason: `${task.id} findings cite no writable workspace file path`,
    };
  }
  const verify = Array.isArray(source.verify) ? source.verify : [];
  const findingsOnlyRepair = source.kind === 'repair' && source.contractSource === 'findings'
    && Array.isArray(source.acceptance) && source.acceptance.length > 0;
  if (verify.length === 0 && !findingsOnlyRepair) {
    return { action: 'escalate', round, reason: `${sourceId} has no verify contract, so a repair cannot prove itself` };
  }
  const acceptance = findings.map((finding) => finding.requiredFix).filter(Boolean);
  const assignee = pickRepairAssignee(members, source, {
    tasks,
    round,
    findings,
    continuity: policy.repairContinuity !== false,
  });
  return {
    action: 'repair',
    round,
    ...(scopeReport.warnings.length > 0 ? { warnings: scopeReport.warnings } : {}),
    task: {
      id: closedLoopRepairTaskId(task.id),
      teamId: task.teamId,
      subject: `Repair ${sourceId} after ${task.id}`,
      kind: 'repair',
      status: 'pending',
      dependencies: [sourceId],
      round,
      sourceTaskId: sourceId,
      parentReviewTaskId: task.id,
      ...(bound ? {
        mode: 'bound',
        repairOrigin: 'planner',
        sourceBase: task.binding.sourceCommit,
        sourceReviewId: task.id,
        deliveryUnitId: unitId,
        deliveryGeneration: source.taskEpoch ?? 0,
        deliverySeq: tasks.reduce((maximum, item) => {
          const own = item?.id === unitId || item?.deliveryUnitId === unitId ? item.deliverySeq : undefined;
          const binding = item?.binding?.deliveryUnitId === unitId ? item.binding.deliverySeq : undefined;
          return Math.max(maximum, Number.isInteger(own) && own >= 0 ? own : 0,
            Number.isInteger(binding) && binding >= 0 ? binding : 0);
        }, 0) + 1,
      } : {
        mode: 'legacy',
        repairOrigin: 'planner',
        legacyUnbound: false,
        bindingUnavailable: true,
        ...(reviewed.sourceCommit ? { sourceBase: reviewed.sourceCommit } : {}),
      }),
      findingSourceTaskIds: [task.id],
      sourceFindingIds: findings.map((finding) => finding.id).filter(Boolean),
      findingsFingerprint: fingerprint,
      objective: deriveRepairObjective(findings, {
        sourceTaskId: sourceId,
        findingSourceTaskId: task.id,
        round,
        verdict: task.verdict,
      }),
      acceptance: bound ? [...new Set([...(source.acceptance ?? []), ...acceptance])]
        : (acceptance.length > 0 ? acceptance : [`Fix ${sourceId} so review ${task.id} can pass`]),
      inScope,
      outOfScope: [...(source.outOfScope ?? [])],
      scopeSource: scopeReport.source,
      verify: [...verify],
      ...(verify.length === 0 ? { contractSource: 'findings' } : {}),
      assigneeRole: 'engineer',
      ...assignee,
      closedLoop: { origin: 'closed-loop', anchorTaskId: task.id, round },
    },
  };
}

function reviewRepairHistory(task, tasks, policy, round, sourceId, findings) {
  const maxRounds = Number.isInteger(policy.codeMaxRounds) && policy.codeMaxRounds > 0
    ? policy.codeMaxRounds
    : CLOSED_LOOP_DEFAULT_MAX_ROUNDS;
  if (round >= maxRounds) {
    return { decision: {
      action: 'escalate',
      round,
      reason: `${task.id} reached the review round ceiling (${maxRounds}); automatic repair stops`,
    } };
  }
  const manualRepair = tasks.find((item) => (
    item?.kind === 'repair'
    && item.sourceTaskId === sourceId
    && item.closedLoop?.origin !== 'closed-loop'
    && (item.findingSourceTaskIds ?? []).length === 0
    && !TERMINAL.includes(item.status)
  ));
  if (manualRepair) {
    return { decision: { action: 'link', reason: 'manual-repair-open', existingTaskId: manualRepair.id, round } };
  }
  const fingerprint = findingsFingerprint(findings);
  const sameFindings = tasks.filter((item) => item?.kind === 'repair'
    && item.sourceTaskId === sourceId
    && item.findingsFingerprint === fingerprint);
  const openSame = sameFindings.find((item) => !TERMINAL.includes(item.status));
  if (openSame) {
    return { decision: { action: 'none', deduplicated: true, reason: `${openSame.id} already covers the same findings`, existingTaskId: openSame.id } };
  }
  const finishedSame = sameFindings.find((item) => item.status === 'completed');
  if (finishedSame) {
    return { decision: {
      action: 'escalate',
      deduplicated: true,
      reason: `${finishedSame.id} completed but the same findings are still open; a human must decide`,
    } };
  }
  const repairAttempts = tasks.filter((item) => item?.kind === 'repair' && item.sourceTaskId === sourceId).length;
  const maxRepairs = repairAttemptLimit(policy);
  if (repairAttempts >= maxRepairs) {
    return { decision: {
      action: 'escalate',
      round,
      reason: `${sourceId} already used ${maxRepairs} automatic repair attempts; a human must decide`,
    } };
  }
  return { decision: undefined, fingerprint };
}
