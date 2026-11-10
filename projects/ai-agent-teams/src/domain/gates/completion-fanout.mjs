/** Ordered completion fan-out: review first, then verification and known-finding repair. Pure logic; no I/O. */
import { normalizeWorkspacePath, isDefaultExcludedPath, classifyChangedPath } from '../changes.mjs';
import { looksLikeFilePath, deriveRepairScope } from '../repair-scope.mjs';
import { closedLoopVerificationTaskId, closedLoopKnownRepairTaskId, findingsFingerprint } from './identity.mjs';
import { pickVerifierAssignee, pickRepairAssignee } from './members.mjs';
import { unresolvedFindings } from './findings.mjs';
import { isInactiveHistory } from '../delivery-review.mjs';
import { CLOSED_LOOP_REVIEW_KINDS } from './policy.mjs';
import { planCompletionReview } from './completion-review.mjs';

/** Workspace-relative file paths only: no globs, no default-excluded paths. */
function fileLikeScope(paths = []) {
  return [...new Set((Array.isArray(paths) ? paths : [])
    .map(normalizeWorkspacePath)
    .filter((path) => Boolean(path) && !path.includes('*') && !isDefaultExcludedPath(path) && looksLikeFilePath(path)))];
}

/**
 * Append the non-review follow-ups of one completed delivery task. Bound and
 * legacy share this entry so a legacy completion cannot silently lose its
 * verification or known repair. The caller decides whether the review is a
 * draft in `created`, an already persisted passing review, or absent.
 */
function appendCompletionFollowUps({ task, tasks, members, policy, created, review, sourceHeads = {} }) {
  const has = (predicate) => tasks.some(predicate) || created.some(predicate);
  const anchor = { origin: 'closed-loop', anchorTaskId: task.id, round: 1 };
  const bound = task.mode === 'bound';

  const wantsVerification = task.requiresVerification === true
    || task.verification === true
    || policy.fanOutVerification === true;
  const verifyCommands = Array.isArray(task.verify) ? task.verify : [];
  if (wantsVerification && verifyCommands.length > 0
    && !has((item) => item?.kind === 'verification'
    && item?.reviewedTaskId === task.id
    && item?.closedLoop?.origin === 'closed-loop')) {
    const claimed = created.map((planned) => planned.assignee).filter(Boolean);
    created.push({
      id: closedLoopVerificationTaskId(task.id),
      teamId: task.teamId,
      subject: `Verify ${task.subject ?? task.id}`,
      kind: 'verification',
      status: 'pending',
      dependencies: [task.id],
      round: 1,
      reviewedTaskId: task.id,
      objective: `Independently verify ${task.id}: run its verify commands and check the changed paths against the scope.`,
      acceptance: ['every verify command passes in the task worktree'],
      verify: [...verifyCommands],
      assigneeRole: 'analyst',
      ...pickVerifierAssignee(members, task, tasks, claimed),
      closedLoop: { ...anchor, role: 'verify' },
      ...(bound ? {} : { mode: 'legacy', legacyUnbound: false, bindingUnavailable: true }),
    });
  }

  const knownFindings = unresolvedFindings(task.findings)
    .filter((finding) => finding.requiredFix && (finding.file || finding.path));
  if (knownFindings.length > 0 && policy.fanOutKnownRepair !== false
    && !has((item) => item?.kind === 'repair'
      && item?.sourceTaskId === task.id
      && item?.closedLoop?.role === 'known-repair')) {
    const derived = deriveRepairScope(knownFindings, []);
    const inScope = derived.length > 0 ? derived : fileLikeScope(task.inScope ?? []);
    if (inScope.some((path) => classifyChangedPath(
      path.endsWith('/') ? `${path}__scope_probe__` : path,
      task.inScope ?? [], task.outOfScope ?? [],
    ) !== 'in_scope')) {
      return { needsCaptain: true, reason: `${task.id} findings exceed the source task's authorized scope` };
    }
    if (inScope.length === 0) {
      return { needsCaptain: true, reason: `${task.id} findings name no writable workspace path` };
    }
    const requiredFixes = knownFindings.map((finding) => String(finding.requiredFix).trim()).filter(Boolean);
    const acceptance = [...new Set([...(task.acceptance ?? []), ...requiredFixes])];
    if (acceptance.length === 0) {
      return { needsCaptain: true, reason: `${task.id} known repair has no acceptance` };
    }
    const parentReview = review ?? created.find((item) => item?.kind === 'review' && item.reviewedTaskId === task.id);
    if (bound && !parentReview) {
      // A bound repair without a parent review/unit would be a half-bound row.
      // Wait for the review to land instead of inventing a legacy owner.
      return { needsCaptain: true, reason: `${task.id} known repair has no persisted review` };
    }
    if (bound && (!task.deliveryUnitId || !Number.isInteger(task.deliverySeq) || task.deliverySeq < 0)) {
      return { needsCaptain: true, reason: `${task.id} known repair has an incomplete delivery unit` };
    }
    const sourceBase = task.sourceCommit ?? sourceHeads[task.id];
    if (bound && !sourceBase) return { needsCaptain: true, reason: `${task.id} known repair has no source commit` };
    const seq = bound ? Math.max(0,
      ...tasks.flatMap((item) => [
        item?.deliveryUnitId === task.deliveryUnitId && Number.isInteger(item.deliverySeq) ? item.deliverySeq : -1,
        item?.binding?.deliveryUnitId === task.deliveryUnitId && Number.isInteger(item.binding.deliverySeq)
          ? item.binding.deliverySeq : -1,
      ]),
      ...created.flatMap((item) => [
        item?.deliveryUnitId === task.deliveryUnitId && Number.isInteger(item.deliverySeq) ? item.deliverySeq : -1,
        item?.binding?.deliveryUnitId === task.deliveryUnitId && Number.isInteger(item.binding.deliverySeq)
          ? item.binding.deliverySeq : -1,
      ]),
    ) + 1 : undefined;
    const repairVerify = Array.isArray(task.verify) ? [...task.verify] : [];
    created.push({
      id: closedLoopKnownRepairTaskId(task.id),
      teamId: task.teamId,
      subject: `Repair reported findings on ${task.subject ?? task.id}`,
      kind: 'repair',
      status: 'pending',
      dependencies: bound && task.deliveryUnitId && task.deliveryUnitId !== task.id
        ? [...new Set([task.id, task.deliveryUnitId])] : [task.id],
      round: 1,
      // Bound deliveries key repairs by unit root. Using the reviewed repair as
      // sourceTaskId made the known-repair undispatable and defeated fingerprint
      // deduplication against planFailedReviewFollowUp (which also keys the root).
      sourceTaskId: bound ? task.deliveryUnitId : task.id,
      sourceFindingIds: knownFindings.map((finding) => finding.id).filter(Boolean),
      objective: [
        `Repair ${task.id} for the findings its completion already reports.`,
        'Fix only these findings, keep the existing contract, and leave evidence for the review.',
        ...knownFindings.map((finding) => `- [${finding.severity}] ${finding.problem} (fix: ${finding.requiredFix})`),
      ].join('\n'),
      acceptance,
      inScope,
      outOfScope: [...(task.outOfScope ?? [])],
      // Findings-only repair is a review-only evidence contract. The daemon
      // still requires acceptanceResults; it does not invent a weak command.
      verify: repairVerify,
      ...(repairVerify.length === 0 ? { contractSource: 'findings' } : {}),
      findingsFingerprint: findingsFingerprint(knownFindings),
      repairOrigin: 'planner',
      assigneeRole: 'engineer',
      ...pickRepairAssignee(members, task, {
        tasks, round: 1, findings: knownFindings, continuity: policy.repairContinuity !== false,
      }),
      closedLoop: { ...anchor, role: 'known-repair' },
      ...(bound ? {
        mode: 'bound',
        parentReviewTaskId: parentReview.id,
        deliveryUnitId: task.deliveryUnitId,
        deliveryGeneration: task.deliveryGeneration ?? task.taskEpoch ?? 0,
        deliverySeq: seq,
        sourceBase,
      } : {
        mode: 'legacy',
        legacyUnbound: false,
        bindingUnavailable: true,
        sourceBase,
      }),
    });
  }
  return { created };
}

function createdReviewFor(tasks, task) {
  return tasks.find((item) => item?.kind === 'review' && item.reviewedTaskId === task.id
    && !isInactiveHistory(item) && item.status !== 'cancelled');
}

/**
 * Fan out every independent follow-up of a completed implementation/repair in
 * one step: the mandatory review, the independent verification when the task
 * asks for one, and the repair of findings the task already reports. The three
 * rows depend only on the completed task, so they dispatch in parallel. Ids are
 * deterministic (`review-<id>`, `verify-<id>`, `repair-known-<id>`) and an
 * existing row always wins, so a repeated tick or a restart creates nothing new.
 * @param {{ task: any, tasks?: Array<any>, members?: Array<any>, policy?: any }} input
 * @returns {{ action: 'create'|'none'|'escalate', created: Array<any>, round?: number, reason?: string }}
 */
export function planCompletionFanOut({ task, tasks = [], members = [], policy = {} } = {}) {
  if (!task || isInactiveHistory(task) || task.legacyUnbound === true || task.legacyRepair === true) {
    return { action: 'none', created: [], reason: 'task-is-historical-or-unbound' };
  }
  if (task.status !== 'completed' || !CLOSED_LOOP_REVIEW_KINDS.includes(task.kind ?? 'work')) {
    return { action: 'none', created: [], reason: 'not-reviewable-completion' };
  }
  if (task.hidden === true) return { action: 'none', created: [], reason: 'task-is-hidden' };
  if (task.mergeState === 'merged' && task.mergeReverted !== true) {
    return { action: 'none', created: [], reason: 'unit-already-merged' };
  }

  const review = planCompletionReview({ task, tasks, members, policy });
  const existing = review.existingTaskId
    ? tasks.find((item) => item?.id === review.existingTaskId)
    : createdReviewFor(tasks, task);
  if (review.action === 'escalate') {
    return { action: 'escalate', created: [], round: review.round, reason: review.reason };
  }
  if (review.needsCaptain === true) {
    return { action: 'none', created: [], round: review.round, reason: review.reason, needsCaptain: true };
  }
  if (review.action === 'none' && review.reason === 'review-exists') {
    const status = existing?.status;
    const verdict = existing?.verdict;
    if (!existing || ['pending', 'claimed', 'in_progress'].includes(status)) {
      // A legacy/manual review may already be persisted before its verification
      // and known repair are appended. A bound chain waits for the review result
      // so it cannot create a half-bound repair from a pending review.
      if (!existing || task.mode === 'bound') return { action: 'none', created: [], reason: 'review-pending' };
    } else {
      if (status === 'failed' || (status === 'completed' && verdict !== 'pass')) {
        return { action: 'none', created: [], reason: 'review-needs-repair' };
      }
      if (status !== 'completed' || verdict !== 'pass') {
        return { action: 'none', created: [], reason: `review-${status ?? 'unknown'}` };
      }
    }
  }

  const created = review.action === 'create' ? [review.task] : [];
  const appended = appendCompletionFollowUps({
    task, tasks, members, policy, created,
    review: review.action === 'create' ? review.task : existing,
  });
  if (appended.needsCaptain === true) {
    return {
      action: 'escalate',
      created: [],
      round: review.round,
      reason: appended.reason,
      needsCaptain: true,
    };
  }
  return {
    action: created.length > 0 ? 'create' : review.action,
    created,
    round: review.round,
    reason: review.reason,
    needsCaptain: review.needsCaptain,
    ...(review.action === 'supersede_legacy_reviews' ? {
      staleReviewIds: review.staleReviewIds ?? [],
      expectedSourceCommit: review.expectedSourceCommit,
    } : {}),
  };
}
