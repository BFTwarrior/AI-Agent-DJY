import { createHash } from 'node:crypto';
import {
  classifyChangedPath,
  deriveRepairScope,
  findingsFingerprint,
} from '../domain/gates.mjs';
import { isCurrentReview, isInactiveHistory } from '../domain/delivery-review.mjs';

export function reconcilePostMergeRepairs(service, teamId) {
  for (const initial of service.store.listTasks(teamId)) {
    let task = initial;
    let intent = task.negativeMergeIntent;
    if (task.repairPlanPending !== true) {
      // A cancelled/failed post-merge repair must be re-planned with a new
      // generation instead of leaving the rejection permanently stuck.
      if (task.mergeState === 'rejected' && task.postMergeReview === 'needs_revision'
        && intent?.phase === 'settled' && task.repairTaskId) {
        const previous = service.store.getTask(task.repairTaskId);
        if (previous && ['cancelled', 'failed'].includes(previous.status)) {
          task = service.store.updateTask(task.id, {
            repairPlanPending: true,
            repairTaskId: undefined,
            repairPlanRetryAt: undefined,
            repairPlanAttempts: 0,
          });
          intent = task.negativeMergeIntent;
          service.store.addEvent(teamId, 'merge.repair_replanned', {
            taskId: task.id, previousRepairId: previous.id,
          });
        }
      }
    }
    if (task.repairPlanPending !== true || task.mergeState !== 'rejected'
      || task.postMergeReview !== 'needs_revision' || intent?.phase !== 'settled'
      || (task.repairPlanAttempts ?? 0) >= 3 || (task.repairPlanRetryAt ?? 0) > service.now()) continue;
    service.store.transaction(() => {
      const current = service.store.getTask(task.id);
      if (!current || current.repairPlanPending !== true || current.negativeMergeIntent?.operationId !== intent.operationId) return;
      const repair = service.createRepairForRejectedMerge(teamId, current,
        { verdict: 'needs_revision', evidence: intent.evidence, findings: intent.findings }, intent.mergeReviewId);
      service.store.updateTask(task.id, repair
        ? { repairPlanPending: false, repairTaskId: repair.id, repairPlanRetryAt: undefined }
        : { repairPlanAttempts: (current.repairPlanAttempts ?? 0) + 1,
          repairPlanRetryAt: service.now() + 60000, needsCaptain: true });
      if (!repair) service.store.updateTeam(teamId, { needsCaptain: true });
    });
  }
}

export function createRepairForRejectedMerge(service, teamId, task, verdict, reviewId) {
  const integration = Boolean(task.parentIntegrationId || task.kind === 'integration');
  if (!integration && (task.mode === 'bound' || (task.mode !== 'legacy' && task.sourceCommit))) {
    return service.createBoundPostMergeRepair(teamId, task, verdict, reviewId);
  }
  const advisory = task.kind === 'work';
  const findings = (Array.isArray(verdict?.findings) ? verdict.findings : [])
    .filter((finding) => finding && finding.requiredFix);
  if (findings.length === 0 && !advisory) {
    service.store.addEvent(teamId, 'merge.repair_failed', { taskId: task.id, error: 'post-merge repair has no actionable finding' });
    return undefined;
  }
  const fallbackScope = Array.isArray(task.inScope) ? task.inScope : [];
  const inScope = findings.length > 0 ? deriveRepairScope(findings, fallbackScope) : [...fallbackScope];
  const acceptance = findings.length > 0
    ? [...new Set([
      ...(Array.isArray(task.acceptance) ? task.acceptance : []),
      ...findings.map((finding) => String(finding.requiredFix).trim()).filter(Boolean),
    ])]
    : [...(Array.isArray(task.acceptance) ? task.acceptance : [])];
  if (acceptance.length === 0 || inScope.length === 0
    || inScope.some((path) => classifyChangedPath(
      path.endsWith('/') ? `${path}__scope_probe__` : path,
      task.inScope ?? [], task.outOfScope ?? [],
    ) !== 'in_scope')) {
    service.store.addEvent(teamId, 'merge.repair_failed', { taskId: task.id, error: 'source repair contract is incomplete' });
    return undefined;
  }
  const sourceBase = task.mergeCommit ?? task.sourceCommit;
  if (!sourceBase) {
    service.store.addEvent(teamId, 'merge.repair_failed', { taskId: task.id, error: 'post-merge repair has no reviewed source commit' });
    return undefined;
  }
  const key = createHash('sha1').update(JSON.stringify([task.id, task.mergeCommit, verdict.evidence])).digest('hex');
  const existingRows = service.store.listTasks(teamId).filter((item) => item.kind === 'repair' && item.repairKey === key);
  const existing = existingRows.find((item) => !['cancelled', 'failed'].includes(item.status)
    && !isInactiveHistory(item));
  if (existing) {
    const expectedParent = integration ? (task.parentIntegrationId ?? task.id) : task.id;
    const lineage = integration
      ? existing.parentIntegrationId === expectedParent
      : existing.sourceTaskId === task.id;
    if (existing.teamId === teamId && lineage) return existing;
    service.store.addEvent(teamId, 'merge.repair_failed', { taskId: task.id, error: 'repair identity collision or terminal repair' });
    return undefined;
  }
  const generation = existingRows.reduce((max, item) => Math.max(max, Number.isSafeInteger(item.repairGeneration) ? item.repairGeneration : 0), -1) + 1;
  const parentReview = service.store.listTasks(teamId).find((item) => item.kind === 'review'
    && item.status === 'completed' && item.verdict === 'pass' && item.reviewedTaskId === task.id
    && isCurrentReview(item, service.store.listTasks(teamId)));
  const repair = {
    teamId,
    id: `postmerge_${key.slice(0, 40)}_g${generation}`,
    subject: `Repair rejected merge: ${task.id}`,
    kind: 'repair',
    status: 'pending',
    round: (Number.isInteger(task.round) && task.round > 0 ? task.round : 0) + 1,
    dependencies: integration
      ? [...new Set([task.id, task.parentIntegrationId ?? task.id])]
      : [task.id],
    sourceTaskId: integration ? (task.parentIntegrationId ?? task.id) : task.id,
    ...(integration ? {
      parentIntegrationId: task.parentIntegrationId ?? task.id,
      mode: 'legacy',
      repairOrigin: 'postmerge',
      bindingUnavailable: true,
      legacyUnbound: false,
      legacyRepair: false,
    } : {
      mode: 'legacy',
      repairOrigin: 'postmerge',
      bindingUnavailable: true,
      legacyUnbound: false,
      legacyRepair: false,
      ...(parentReview ? { parentReviewTaskId: parentReview.id, sourceReviewId: parentReview.id } : {}),
    }),
    sourceBase,
    repairKey: key,
    repairGeneration: generation,
    objective: `Fix the post-merge review findings for ${task.id}: ${verdict?.evidence ?? 'see merge review'}`,
    acceptance,
    inScope,
    outOfScope: [...(task.outOfScope ?? [])],
    verify: [...(Array.isArray(task.verify) ? task.verify : [])],
    contractSource: 'findings',
    assignee: task.assignee,
    assigneeId: task.assigneeId,
    createdAt: service.now(),
  };
  try {
    const created = service.addTask(teamId, repair, { internal: true });
    service.store.addEvent(teamId, 'merge.repair_created', { taskId: task.id, repairTaskId: created.id });
    return created;
  } catch (error) {
    service.store.addEvent(teamId, 'merge.repair_failed', { taskId: task.id, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

export function createBoundPostMergeRepair(service, teamId, task, verdict, reviewId) {
  const rows = service.store.listTasks(teamId);
  const current = service.store.getTask(task.id);
  const root = rows.find((item) => item.id === task.deliveryUnitId && item.kind === 'implementation');
  const review = current && service.currentMergeReview(teamId, current).review;
  const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];
  if (!root || root.status !== 'completed' || root.deliveryUnitId !== root.id || !task.sourceCommit
    || !review || review.reviewedTaskId !== task.id || !findings.length
    || current?.postMergeReview !== 'needs_revision' || current.negativeMergeIntent?.phase !== 'settled'
    || current.negativeMergeIntent.verdict !== 'needs_revision'
    || current.negativeMergeIntent.mergeCommit !== current.mergeCommit
    || !Array.isArray(root.acceptance) || root.acceptance.length === 0
    || !Array.isArray(root.verify) || root.verify.length === 0) {
    service.store.addEvent(teamId, 'merge.repair_failed', { taskId: task.id, error: 'bound post-merge repair evidence or unit is incomplete' });
    return undefined;
  }
  const inScope = deriveRepairScope(findings, root.inScope ?? []);
  if (!inScope.length || inScope.some((path) => classifyChangedPath(path, root.inScope ?? [], root.outOfScope ?? []) !== 'in_scope')) {
    service.store.addEvent(teamId, 'merge.repair_failed', { taskId: task.id, error: 'post-merge findings exceed authorized scope' });
    return undefined;
  }
  const key = createHash('sha256').update(JSON.stringify([task.id, task.sourceCommit, findingsFingerprint(findings)])).digest('hex');
  const existing = rows.filter((item) => item.kind === 'repair' && item.repairKey === key);
  if (existing.some((item) => item.status === 'failed' && !item.archived && !item.historical && !item.superseded)) {
    service.store.addEvent(teamId, 'merge.repair_failed', { taskId: task.id, error: 'previous post-merge repair failed; captain decision required' });
    return undefined;
  }
  const live = existing.find((item) => !['cancelled', 'failed'].includes(item.status)
    && !item.archived && !item.historical && !item.superseded);
  if (live) {
    if (live.teamId !== teamId || live.deliveryUnitId !== root.id || live.sourceTaskId !== root.id
      || live.deliveryGeneration !== (root.taskEpoch ?? 0) || live.parentReviewTaskId !== review.id
      || live.sourceBase !== task.sourceCommit || !Number.isInteger(live.deliverySeq) || live.deliverySeq <= 0) {
      service.store.addEvent(teamId, 'merge.repair_failed', { taskId: task.id, error: 'existing repair has stale unit lineage' });
      return undefined;
    }
    return live;
  }
  const generation = Math.max(-1, ...existing.map((item) => Number.isSafeInteger(item.repairGeneration) ? item.repairGeneration : 0)) + 1;
  const deliverySeq = rows.reduce((max, item) => Math.max(max,
    item.deliveryUnitId === root.id && Number.isInteger(item.deliverySeq) ? item.deliverySeq : 0,
    item.binding?.deliveryUnitId === root.id && Number.isInteger(item.binding.deliverySeq) ? item.binding.deliverySeq : 0), 0) + 1;
  const repair = { id: `postmerge_${key.slice(0, 40)}_g${generation}`, teamId,
    subject: `Repair rejected merge: ${task.id}`, kind: 'repair', status: 'pending',
    dependencies: [root.id], sourceTaskId: root.id, parentReviewTaskId: review.id,
    sourceReviewId: review.id, sourceBase: task.sourceCommit, mode: 'bound', repairOrigin: 'postmerge',
    deliveryUnitId: root.id, deliveryGeneration: root.taskEpoch ?? 0, deliverySeq,
    repairKey: key, repairGeneration: generation,
    round: (Number.isInteger(task.round) && task.round > 0 ? task.round : 0) + 1,
    objective: `Fix post-merge findings for ${task.id}: ${verdict.evidence}`,
    acceptance: [...new Set([...root.acceptance, ...findings.map((item) => item.requiredFix).filter(Boolean)])],
    inScope, outOfScope: [...(root.outOfScope ?? [])], verify: [...root.verify],
    assignee: task.assignee ?? root.assignee, assigneeId: task.assigneeId ?? root.assigneeId };
  try {
    const created = service.addTask(teamId, repair, { internal: true });
    service.store.addEvent(teamId, 'merge.repair_created', { taskId: task.id, repairTaskId: created.id, reviewId });
    return created;
  } catch (error) {
    service.store.addEvent(teamId, 'merge.repair_failed', { taskId: task.id, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}
