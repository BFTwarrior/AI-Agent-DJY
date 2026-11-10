import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { parseMergeReviewResult, isBoundMergeReview } from './merge-review-result.mjs';
import { publicationWorktreeWarning } from './publication-recovery.mjs';
import { cleanupIntegration, fastForwardBranch, headCommit, integrationWorktreePath, mergeCommit, mergeCommitToBranch, revertCommitOnce } from '../git/merge-queue.mjs';

export async function reviewMerge(service, teamId, taskId) {
  const key = JSON.stringify([teamId, taskId]);
  const previous = service.mergeReviewLocks.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  service.mergeReviewLocks.set(key, tail);
  await previous;
  try {
  return await service.reviewMergeUnlocked(teamId, taskId);
  } finally {
  release();
  if (service.mergeReviewLocks.get(key) === tail) service.mergeReviewLocks.delete(key);
  }
}

export async function reviewMergeUnlocked(service, teamId, taskId) {
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  if (!task.mergeCommit) throw new Error('task has no merge commit to review');
  const baseBranch = service.config.teams.find((team) => team.id === teamId)?.baseBranch ?? 'main';
  // A failed fast-forward is a publication retry, not a new post-merge
  // review. Keep the review verdict and retry the same integration commit.
  if (task.mergeState === 'ff_failed' && task.postMergeReview === 'pass'
  && task.integrationBranch && task.integrationCommit
  && (task.ffAttempt ?? 0) < 3 && !task.cleanupPending) {
  return service.retryPublication(teamId, taskId);
  }
  const boundDelivery = isBoundMergeReview(task);
  if (task.postMergeReview || task.cleanupPending || ['merged', 'rejected', 'revert_failed', 'ff_failed'].includes(task.mergeState)) {
  return { ok: task.mergeState === 'merged' && !task.cleanupPending, verdict: task.postMergeReview,
  alreadyReviewed: true, needsCaptain: task.needsCaptain, cleanupPending: task.cleanupPending };
  }
  if (service.config.quality.postMergeReview === 'off') {
  return { ok: true, verdict: 'pass', skipped: true };
  }
  if (service.config.quality.postMergeReview === 'internal') {
  service.store.updateTask(taskId, { mergeState: 'review_pending_internal' });
  service.store.addEvent(teamId, 'merge.review_internal', { taskId, reason: 'internal review configured' });
  return { ok: false, verdict: 'internal' };
  }
  if (service.config.quality.postMergeReview === 'contractor' && (!service.features.contractors || !service.config.contractors.enabled)) {
  service.store.updateTask(taskId, { mergeState: 'review_pending_internal' });
  service.store.addEvent(teamId, 'merge.review_internal', { taskId, reason: 'contractors disabled' });
  return { ok: false, verdict: 'internal', reason: 'contractors disabled' };
  }
  if (service.config.quality.postMergeReview === 'contractor'
  && (service.contractorSlotCap('merge') === 0 || !service.contractorSlotAllows('merge', 'post_merge_review'))) {
  const reason = service.contractorSlotCap('merge') === 0 ? 'merge contractor slot disabled' : 'merge slot purpose not allowed';
  service.store.updateTask(taskId, { mergeState: 'review_pending_internal' });
  service.store.addEvent(teamId, 'merge.review_internal', { taskId, reason });
  return { ok: false, verdict: 'internal', reason };
  }
  const operationId = randomUUID();
  let claimed = false;
  service.store.transaction(() => {
  const current = service.store.getTask(taskId);
  if (!current || current.teamId !== teamId || current.mergeCommit !== task.mergeCommit
  || current.integrationCommit !== task.integrationCommit || current.postMergeReview
  || current.postMergeClaim) return;
  service.store.updateTask(taskId, { postMergeClaim: {
  operationId, state: 'claimed', mergeCommit: task.mergeCommit,
  integrationCommit: task.integrationCommit, createdAt: service.now(),
  } });
  service.store.addEvent(teamId, 'merge.review_claimed', { taskId, operationId });
  claimed = true;
  });
  if (!claimed) return { ok: false, needsCaptain: true, error: 'post-merge review is already claimed or changed; reconciliation required' };
  let contractor;
  try {
  contractor = await service.spawnContractor({
  teamId,
  slot: 'merge',
  purpose: `post_merge_review:${taskId}`,
  prompt: service.postMergePrompt(boundDelivery ? { ...task, mode: 'bound' } : task, task.integrationCommit ?? task.mergeCommit),
  cwd: task.integrationWorktree ?? service.cwd,
  });
  } catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  service.store.transaction(() => {
  const current = service.store.getTask(taskId);
  if (current?.postMergeClaim?.operationId !== operationId) return;
  service.store.updateTask(taskId, { postMergeClaim: { ...current.postMergeClaim, state: 'unknown', error: message }, needsCaptain: true });
  service.store.addEvent(teamId, 'merge.review_claim_unknown', { taskId, operationId, error: message });
  });
  return { ok: false, needsCaptain: true, error: message };
  }
  const current = service.store.getTask(taskId);
  if (current?.postMergeClaim?.operationId !== operationId || current.postMergeClaim.state !== 'claimed'
  || current.mergeCommit !== task.mergeCommit || current.integrationCommit !== task.integrationCommit) {
  return { ok: false, needsCaptain: true, error: 'post-merge review claim or artifact changed; result held' };
  }
  if (contractor.status !== 'completed') {
  // A killed/timed-out reviewer often has no `error` string. Do not persist
  // an undefined reason: the merge audit must say why the review stopped.
  const reason = contractor.error
  ?? `post-merge review contractor ended as ${contractor.status}`;
  service.store.updateTask(taskId, { mergeState: 'review_pending_internal', mergeReviewError: reason,
  postMergeClaim: { ...current.postMergeClaim, state: 'unknown', contractorId: contractor.id }, needsCaptain: true });
  return { ok: false, verdict: 'error', error: reason, needsCaptain: true };
  }
  const parsed = parseMergeReviewResult(task, contractor.result, boundDelivery);
  const mergeReviewId = `mrv_${randomUUID()}`;
  service.store.addMergeReview({
  id: mergeReviewId, teamId, taskId, status: parsed?.verdict ?? 'pending',
  contractorId: contractor.id, result: contractor.result, verdict: parsed?.verdict,
  evidence: parsed?.evidence, createdAt: service.now(),
  });
  if (parsed?.verdict === 'pass') {
  const fresh = service.store.getTask(taskId);
  const deliveryReview = fresh && service.currentMergeReview(teamId, fresh);
  const requiresMemberReview = !(fresh?.kind === 'repair' && fresh.parentIntegrationId);
  if (!fresh || (requiresMemberReview && deliveryReview.required
  && (!deliveryReview.review || fresh.sourceCommit !== task.sourceCommit))) {
  service.store.updateTask(taskId, { mergeState: 'review_stale', needsCaptain: true });
  service.store.addEvent(teamId, 'merge.review_stale', { taskId, operationId });
  return { ok: false, verdict: 'pass', needsCaptain: true, error: 'delivery review changed before publication' };
  }
  let integration;
  let publicationOwner;
  let syncWarning;
  if (task.integrationBranch) {
  publicationOwner = randomUUID();
  let acquired = false;
  service.store.transaction(() => {
  const latestTeam = service.store.getTeam(teamId);
  const latestTask = service.store.getTask(taskId);
  if (!latestTeam || service.store.getPublicationGuard(teamId) || !latestTask
    || latestTask.postMergeClaim?.operationId !== operationId
    || latestTask.integrationCommit !== task.integrationCommit || latestTask.mergeCommit !== task.mergeCommit) return;
  const latestReview = service.currentMergeReview(teamId, latestTask);
  const latestRequiresReview = !(latestTask.kind === 'repair' && latestTask.parentIntegrationId)
    && latestReview.required;
  if (latestRequiresReview && !latestReview.review) return;
  service.store.updateTeam(teamId, { publicationGuard: { operationId: publicationOwner, taskId,
    reviewId: latestReview.review?.id, expectedCommit: task.integrationCommit, state: 'publishing' } });
  service.store.addEvent(teamId, 'merge.publication_guarded', { taskId, operationId: publicationOwner });
  acquired = true;
  });
  if (!acquired) return { ok: false, needsCaptain: true, error: 'publication state changed or is already held' };
  const baseBranch = service.config.teams.find((team) => team.id === teamId)?.baseBranch ?? 'main';
  integration = await fastForwardBranch({
  repo: service.repo, branch: task.integrationBranch, target: baseBranch,
  expectedCommit: task.integrationCommit,
  });
  if (!integration.ok) {
  service.store.transaction(() => {
    const latest = service.store.getTask(taskId);
    const attempts = (latest?.ffAttempt ?? 0) + 1;
    const exhausted = attempts >= 3;
    service.store.updateTask(taskId, {
      mergeState: exhausted ? 'ff_exhausted' : 'ff_failed',
      postMergeReview: 'pass',
      mergeReviewError: integration.error,
      ffAttempt: attempts,
      needsCaptain: true,
    }, { publicationOwner });
    const guardedTeam = service.store.getTeam(teamId);
    // A normal ff rejection leaves the target untouched. Keep the
    // guard only when publication may have happened but the post-check
    // could not prove it.
    const uncertain = /after fast-forward/.test(integration.error ?? '');
    service.store.updateTeam(teamId, {
      needsCaptain: true,
      publicationGuard: uncertain
        ? { ...guardedTeam.publicationGuard, state: 'unknown' }
        : undefined,
    }, { publicationOwner });
  });
  service.store.addEvent(teamId, 'merge.ff_failed', { taskId, branch: task.integrationBranch, error: integration.error });
  return { ok: false, verdict: 'pass', contractor, integration };
  }
  syncWarning = publicationWorktreeWarning(integration);
  let cleanup;
  try {
  cleanup = await cleanupIntegration({ repo: service.repo, worktree: task.integrationWorktree, branch: task.integrationBranch,
    ownershipEvidence: task.integrationOwnership });
  } catch (error) {
  cleanup = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (cleanup?.ok !== true) {
  const error = cleanup?.error ?? 'integration cleanup failed';
  let excluded = [];
  service.store.transaction(() => {
    service.store.updateTask(taskId, { mergeState: 'merged', postMergeReview: 'pass', reviewedAt: service.now(), cleanupPending: true, needsCaptain: true,
      mergeReviewError: syncWarning ? `${error}; ${syncWarning}` : error,
      ...(syncWarning ? { publicationWorktreeSync: { target: integration.target, commit: integration.commit, state: 'not_synced' } } : {}) }, { publicationOwner });
    // Publication already happened; the cleanup failure must not hide
    // the actual applied commit from the delivery audit.
    const delivery = service.resolveDeliveryMergeTarget(teamId, service.store.getTask(taskId));
    if (delivery.ok && !delivery.integration) {
      const marked = service.markDeliveryMerged(teamId, delivery, task.integrationCommit ?? task.mergeCommit, publicationOwner);
      excluded = marked.excluded ?? [];
    }
    service.store.updateTeam(teamId, { publicationGuard: undefined }, { publicationOwner });
  });
  service.store.addEvent(teamId, 'merge.cleanup_failed', { taskId, error, excluded });
  if (syncWarning) service.store.addEvent(teamId, 'merge.publication_worktree_not_synced', { taskId, ...integration });
  return { ok: false, verdict: 'pass', contractor, integration, cleanupPending: true, needsCaptain: true,
    error, ...(excluded.length ? { blocked: 'sibling_not_in_delivery', excluded } : {}) };
  }
  }
  const publishedCommit = task.integrationCommit ?? task.mergeCommit;
  let excluded = [];
  service.store.transaction(() => {
  service.store.updateTask(taskId, {
  mergeState: 'merged', postMergeReview: 'pass', reviewedAt: service.now(),
  integrationWorktree: undefined,
  ...(syncWarning ? { needsCaptain: true, mergeReviewError: syncWarning,
    publicationWorktreeSync: { target: integration.target, commit: integration.commit, state: 'not_synced' } } : {}),
  }, { publicationOwner });
  const delivery = service.resolveDeliveryMergeTarget(teamId, service.store.getTask(taskId));
  if (delivery.ok && !delivery.integration) {
  const marked = service.markDeliveryMerged(teamId, delivery, publishedCommit, publicationOwner);
  excluded = marked.excluded ?? [];
  }
  if (task.parentIntegrationId) {
  const parent = service.store.getTask(task.parentIntegrationId);
  if (parent?.kind === 'integration') {
    service.store.updateTask(parent.id, {
      mergeState: 'merged',
      mergedCommit: publishedCommit,
      mergeCommit: parent.mergeCommit ?? task.mergeCommit ?? publishedCommit,
      mergeReverted: false,
      mergeRevertedAt: undefined,
      closedLoop: { ...(parent.closedLoop ?? {}), deliveredBy: task.id, deliveredAt: service.now() },
    }, { publicationOwner });
  }
  }
  if (publicationOwner) service.store.updateTeam(teamId, { publicationGuard: undefined }, { publicationOwner });
  });
  service.store.addEvent(teamId, 'merge.review_passed', { taskId, contractorId: contractor.id, excluded });
  // The task checkout is no longer needed once its commit is published.
  // A dirty tree is skipped by the reclaimer, so nothing uncommitted is lost.
  if (excluded.length === 0) service.reclaimWorktrees().catch(() => {});
  if (syncWarning) service.store.addEvent(teamId, 'merge.publication_worktree_not_synced', { taskId, ...integration });
  if (excluded.length > 0) {
  return { ok: false, verdict: 'pass', contractor, integration, needsCaptain: true,
  blocked: 'sibling_not_in_delivery', excluded,
  error: `delivery published but ${excluded.join(', ')} is not in the reviewed commit range` };
  }
  return syncWarning
  ? { ok: true, verdict: 'pass', contractor, integration, needsCaptain: true, warning: syncWarning }
  : { ok: true, verdict: 'pass', contractor, integration };
  }
  if (parsed?.verdict === 'reject' || parsed?.verdict === 'needs_revision') {
  let negativePrepared = false;
  service.store.transaction(() => {
  const latest = service.store.getTask(taskId);
  if (!latest || latest.postMergeClaim?.operationId !== operationId || latest.negativeMergeIntent
  || latest.mergeCommit !== task.mergeCommit || latest.integrationCommit !== task.integrationCommit) return;
  service.store.updateTask(taskId, { negativeMergeIntent: {
  operationId, phase: 'prepared', verdict: parsed.verdict, evidence: parsed.evidence,
  findings: parsed.findings,
  mergeCommit: task.mergeCommit, integrationCommit: task.integrationCommit,
  integrationBranch: task.integrationBranch, integrationWorktree: task.integrationWorktree,
  mergeReviewId, createdAt: service.now(),
  } });
  service.store.addEvent(teamId, 'merge.negative_prepared', { taskId, operationId, verdict: parsed.verdict });
  negativePrepared = true;
  });
  if (!negativePrepared) return { ok: false, needsCaptain: true, error: 'negative merge intent changed or is already held' };
  let rollback;
  try {
  rollback = task.integrationBranch
  ? await cleanupIntegration({ repo: service.repo, worktree: task.integrationWorktree, branch: task.integrationBranch,
    ownershipEvidence: task.integrationOwnership })
  : await revertCommitOnce({ repo: service.repo, commit: task.mergeCommit, key: operationId,
    target: baseBranch });
  } catch (error) {
  rollback = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const rolledBack = rollback?.ok === true;
  const hasEvidence = typeof parsed.evidence === 'string' && parsed.evidence.trim().length > 0;
  let needsCaptain = parsed.verdict === 'reject' || !rolledBack || !hasEvidence;
  let settled = false;
  service.store.transaction(() => {
  const latest = service.store.getTask(taskId);
  if (latest?.negativeMergeIntent?.operationId !== operationId
  || latest.negativeMergeIntent.phase !== 'prepared'
  || latest.mergeCommit !== task.mergeCommit || latest.integrationCommit !== task.integrationCommit) return;
  service.store.updateTask(taskId, {
  mergeState: rolledBack ? 'rejected' : 'revert_failed',
  postMergeReview: parsed.verdict, reviewEvidence: parsed.evidence,
  needsCaptain,
  negativeMergeIntent: { ...latest.negativeMergeIntent,
    phase: rolledBack ? 'settled' : 'blocked', error: rollback?.error, settledAt: service.now(),
    ...(rolledBack ? { revertCommit: rollback?.commit, revertAlreadyPresent: rollback?.alreadyReverted === true }
      : { code: rollback?.code, receiptStatus: rollback?.receiptStatus, retryable: rollback?.retryable,
        workingTreeClean: rollback?.workingTreeClean }) },
  repairPlanPending: parsed.verdict === 'needs_revision' && rolledBack && hasEvidence,
  ...(rolledBack ? { integrationWorktree: undefined, integrationBranch: undefined } : {}),
  ...(!rolledBack ? { mergeReviewError: rollback?.error ?? 'rollback failed' } : {}),
  });
  if (parsed.verdict === 'needs_revision' && rolledBack && hasEvidence) {
  const repair = service.createRepairForRejectedMerge(teamId, task, parsed, mergeReviewId);
  if (repair) service.store.updateTask(taskId, { repairPlanPending: false, repairTaskId: repair.id });
  else {
    needsCaptain = true;
    service.store.updateTask(taskId, { needsCaptain: true, repairPlanAttempts: 1, repairPlanRetryAt: service.now() + 60000 });
  }
  }
  if (needsCaptain) service.store.updateTeam(teamId, { needsCaptain: true });
  settled = true;
  });
  if (!settled) {
  service.store.updateTeam(teamId, { needsCaptain: true });
  return { ok: false, needsCaptain: true, error: 'negative merge state changed after external action' };
  }
  service.store.addEvent(teamId, 'merge.review_rejected', {
  taskId, contractorId: contractor.id, reverted: rolledBack, needsCaptain,
  error: rollback?.error, evidence: parsed.evidence,
  });
  return { ok: false, verdict: parsed.verdict, contractor, reverted: rolledBack, needsCaptain, rollbackError: rollback?.error };
  }
  service.store.updateTask(taskId, { mergeState: 'review_pending_internal', postMergeReview: 'unknown', needsCaptain: true,
  postMergeClaim: { ...service.store.getTask(taskId).postMergeClaim, state: 'unknown', contractorId: contractor.id } });
  service.store.updateTeam(teamId, { needsCaptain: true });
  service.store.addFinding({
  id: `finding_${randomUUID()}`, teamId, severity: 'high', code: 'merge_review_unknown',
  memberId: task.assigneeId, member: task.assignee, taskId, status: 'open',
  message: 'post-merge contractor returned no parseable verdict', createdAt: service.now(),
  });
  return { ok: false, verdict: 'unknown', contractor, needsCaptain: true };
}

export async function mergeTask(service, teamId, taskId, options = {}) {
  const previous = service.mergeLocks.get(teamId) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  service.mergeLocks.set(teamId, previous.then(() => current));
  await previous;
  try {
  return await service.mergeTaskUnlocked(teamId, taskId, options);
  } finally {
  release();
  }
}

export async function mergeTaskUnlocked(service, teamId, taskId, options = {}) {
  service.assertTeamWritable(teamId, options, 'mergeTask');
  let task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  if (task.mergeState === 'publication_unknown') {
  return { ok: false, blocked: 'publication_unknown', needsCaptain: true,
  error: 'the target branch may already contain this publication; reconcile it before retrying' };
  }
  if (task.mergeState === 'ff_exhausted') {
  return { ok: false, blocked: 'ff_exhausted', needsCaptain: true,
  error: 'publication retries are exhausted; a captain must reconcile the target branch' };
  }
  if (task.mergeState === 'ff_failed' && task.postMergeReview === 'pass'
  && task.integrationCommit && (task.ffAttempt ?? 0) < 3) {
  return service.retryPublication(teamId, taskId);
  }
  if (task.cleanupPending) return service.retryCleanup(teamId, taskId);
  if (task.integrationIntent && !['settled'].includes(task.integrationIntent.state)) {
  // An unknown intent without a branch/worktree failed before creating any
  // external artifact. It is safe to clear and retry; an intent with an
  // artifact still requires ownership reconciliation.
  if (task.integrationIntent.state === 'unknown'
  && !task.integrationBranch && !task.integrationWorktree) {
  service.store.updateTask(taskId, { integrationIntent: undefined, mergeState: undefined,
  mergeReviewError: undefined, needsCaptain: false });
  service.store.addEvent(teamId, 'merge.integration_intent_cleared', {
  taskId, operationId: task.integrationIntent.operationId,
  });
  task = service.store.getTask(taskId);
  } else {
  return { ok: false, needsCaptain: true, error: 'existing integration intent requires reconciliation' };
  }
  }
  if (task.mergeState === 'merged') return { ok: true, alreadyMerged: true, commit: task.mergeCommit };
  if (task.mergeState === 'review_pending' && task.integrationCommit
  && task.integrationIntent?.state === 'settled' && !task.postMergeReview) {
  // Recovery entry point after a crash between integration and review.
  if (task.postMergeClaim) return { ok: false, reviewPending: true, needsCaptain: false };
  return service.reviewMerge(teamId, taskId);
  }
  if (task.legacyRepair === true) {
  return { ok: false, blocked: 'legacy_repair_manual', needsCaptain: true,
  error: 'legacy repair has no trusted parent; manual handling is required' };
  }
  const enforced = task.mode === 'bound' || task.mode === 'legacy';
  const integrationRepair = task.kind === 'repair' && Boolean(task.parentIntegrationId);
  const deliveryKind = ['implementation', 'repair'].includes(task.kind ?? 'work');
  const delivery = enforced && deliveryKind && task.kind !== 'integration' && !integrationRepair
  ? service.resolveDeliveryMergeTarget(teamId, task) : undefined;
  if (delivery && !delivery.ok) {
  service.store.addEvent(teamId, 'merge.delivery_blocked', {
  taskId, blocked: delivery.blocked, newest: delivery.newest?.id, review: delivery.review?.id,
  });
  return { ok: false, blocked: delivery.blocked, needsCaptain: true, error: delivery.error };
  }
  const deliveryTask = delivery?.newest ?? task;
  if (delivery?.newest?.mergeState === 'merged' && delivery.newest.id !== task.id) {
  // Calling merge again on any member of an already delivered unit must not
  // replay the publication. A sibling that was excluded is reported as
  // blocked instead of silently succeeding.
  if (task.mergeState === 'blocked' && task.mergeBlockReason === 'sibling_not_in_delivery') {
  return { ok: false, blocked: 'sibling_not_in_delivery', needsCaptain: true,
  error: 'this sibling repair is not part of the delivered commit range' };
  }
  return { ok: true, alreadyMerged: true,
  commit: delivery.newest.mergedCommit ?? delivery.newest.mergeCommit };
  }
  if (delivery?.root?.status === 'failed' && delivery.root.closedLoop?.deliveredBy
  && delivery.newest?.id === delivery.root.closedLoop.deliveredBy
  && delivery.newest?.mergeState === 'merged') {
  return { ok: true, alreadyMerged: true, commit: delivery.newest.mergedCommit ?? delivery.newest.mergeCommit };
  }
  if (!deliveryTask.worktree && !deliveryTask.sourceCommit) throw new Error('task has no worktree to merge');
  if (deliveryTask.status !== 'completed' && !delivery?.newest) throw new Error('only a completed task can be merged');
  const initialReview = integrationRepair
  ? { required: false, review: undefined }
  : delivery
  ? { required: Boolean(delivery.review) || service.config.quality.requireIndependentReview, review: delivery.review }
  : service.currentMergeReview(teamId, task);

  if (initialReview.required && !initialReview.review) return { ok: false, needsCaptain: true,
  error: 'task needs a current passing independent review with verified member identities and source binding before merge' };
  const postMerge = service.config.quality.postMergeReview !== 'off';
  if (!postMerge) {
  let committed = delivery?.sourceCommit
  ? { ok: true, commit: delivery.sourceCommit, alreadyCommitted: true }
  : deliveryTask.sourceCommit
  ? { ok: true, commit: deliveryTask.sourceCommit, alreadyCommitted: true }
  : await service.commitNonDeliveryArtifact(teamId, deliveryTask);
  if (!committed.ok && committed.reason === 'no changes' && initialReview.required) committed = { ok: true, commit: await headCommit(deliveryTask.worktree) };
  if (!committed.ok) return committed;
  const publicationOwner = randomUUID();
  let acquired = false;
  service.store.transaction(() => {
  const team = service.store.getTeam(teamId);
  const fresh = service.store.getTask(taskId);
  if (!team || service.store.getPublicationGuard(teamId) || !fresh || fresh.status !== 'completed') return;
  if (delivery) {
  const currentDelivery = service.resolveDeliveryMergeTarget(teamId, fresh);
  if (!currentDelivery.ok || currentDelivery.review?.id !== initialReview.review?.id
    || currentDelivery.sourceCommit !== committed.commit) return;
  } else {
  const review = service.currentMergeReview(teamId, fresh);
  if (initialReview.required && (review.review?.id !== initialReview.review.id
    || (fresh.sourceCommit && committed.commit !== fresh.sourceCommit))) return;
  }
  const review = delivery ? { review: initialReview.review } : service.currentMergeReview(teamId, fresh);
  service.store.updateTeam(teamId, { publicationGuard: { operationId: publicationOwner, taskId,
  reviewId: review.review?.id, expectedCommit: committed.commit, state: 'publishing' } });
  service.store.addEvent(teamId, 'merge.publication_guarded', { taskId, operationId: publicationOwner });
  acquired = true;
  });
  if (!acquired) return { ok: false, needsCaptain: true, error: 'publication state changed or is already held' };
  const mergeBase = delivery?.sourceBase ?? deliveryTask.sourceBase ?? deliveryTask.worktreeBase;
  const baseBranch = service.config.teams.find((team) => team.id === teamId)?.baseBranch ?? 'main';
  const legacy = await mergeCommit({ repo: service.repo, commit: committed.commit, base: mergeBase, branch: baseBranch });
  if (!legacy.ok) {
  service.store.transaction(() => {
  service.store.updateTask(taskId, { mergeState: 'conflict', mergeError: legacy.error, needsCaptain: true }, { publicationOwner });
  service.store.updateTeam(teamId, { needsCaptain: true, publicationGuard: undefined }, { publicationOwner });
  });
  service.store.addEvent(teamId, 'task.merge_conflict', { taskId, error: legacy.error });
  return legacy;
  }
  let excluded = [];
  service.store.transaction(() => {
  if (delivery) {
  const marked = service.markDeliveryMerged(teamId, delivery, legacy.commit, publicationOwner);
  excluded = marked.excluded ?? [];
  } else service.store.updateTask(taskId, { mergeState: 'merged', mergeCommit: legacy.commit }, { publicationOwner });
  service.store.updateTeam(teamId, { publicationGuard: undefined }, { publicationOwner });
  });
  service.store.addEvent(teamId, 'task.merged', { taskId, commit: legacy.commit, excluded });
  if (excluded.length > 0) {
  return { ...legacy, ok: false, needsCaptain: true, blocked: 'sibling_not_in_delivery', excluded,
  error: `delivery published but ${excluded.join(', ')} is not in the reviewed commit range` };
  }
  return legacy;
  }

  let committed = delivery?.sourceCommit
  ? { ok: true, commit: delivery.sourceCommit, alreadyCommitted: true }
  : deliveryTask.sourceCommit
  ? { ok: true, commit: deliveryTask.sourceCommit, alreadyCommitted: true }
  : await service.commitNonDeliveryArtifact(teamId, deliveryTask);
  if (!committed.ok && committed.reason === 'no changes') {
  committed = { ok: true, commit: await headCommit(deliveryTask.worktree), alreadyCommitted: true };
  }
  if (!committed.ok) {
  service.store.updateTask(taskId, { mergeState: 'conflict', mergeError: committed.reason });
  service.store.addEvent(teamId, 'task.merge_conflict', { taskId, error: committed.reason });
  return committed;
  }
  if (initialReview.required) {
  const fresh = service.store.getTask(taskId);
  if (delivery) {
  const currentDelivery = service.resolveDeliveryMergeTarget(teamId, fresh);
  if (!fresh || !currentDelivery.ok || currentDelivery.review?.id !== initialReview.review?.id
  || currentDelivery.sourceCommit !== committed.commit) {
  service.store.updateTask(taskId, { needsCaptain: true, mergeState: 'review_stale' });
  service.store.addEvent(teamId, 'merge.review_stale', { taskId, reviewId: initialReview.review?.id });
  return { ok: false, needsCaptain: true, error: 'review or reviewed commit changed before integration' };
  }
  } else {
  const currentReview = fresh && service.currentMergeReview(teamId, fresh);
  if (!fresh || currentReview.review?.id !== initialReview.review.id
  || (fresh.sourceCommit && committed.commit !== fresh.sourceCommit)) {
  service.store.updateTask(taskId, { needsCaptain: true, mergeState: 'review_stale' });
  service.store.addEvent(teamId, 'merge.review_stale', { taskId, reviewId: initialReview.review.id });
  return { ok: false, needsCaptain: true, error: 'review or reviewed commit changed before integration' };
  }
  }
  }
  const baseBranch = service.config.teams.find((team) => team.id === teamId)?.baseBranch ?? 'main';
  const safeTaskId = String(task.id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const branch = `${service.config.quality.mergeBranch ?? 'integration'}/${teamId}/${safeTaskId}/${String(task.attemptId ?? '1').slice(0, 8)}`;
  const operationId = randomUUID();
  const mergeBase = delivery?.sourceBase ?? deliveryTask.sourceBase ?? deliveryTask.worktreeBase;
  const intent = { operationId, state: 'prepared', branch, worktree: integrationWorktreePath(branch, operationId),
  sourceCommit: committed.commit, artifactBase: mergeBase ?? `${committed.commit}^1`,
  baseBranch, createdAt: service.now() };
  let prepared = false;
  service.store.transaction(() => {
  const current = service.store.getTask(taskId);
  const team = service.store.getTeam(teamId);
  if (!current || !team || service.store.getPublicationGuard(teamId) || current.integrationIntent || current.status !== 'completed') return;
  if (delivery) {
  const currentDelivery = service.resolveDeliveryMergeTarget(teamId, current);
  if (!currentDelivery.ok || currentDelivery.review?.id !== initialReview.review?.id
  || currentDelivery.sourceCommit !== committed.commit) return;
  } else {
  const review = service.currentMergeReview(teamId, current);
  if (initialReview.required && (review.review?.id !== initialReview.review.id
  || (current.sourceCommit && committed.commit !== current.sourceCommit))) return;
  }
  const review = delivery ? { review: initialReview.review } : service.currentMergeReview(teamId, current);
  service.store.updateTask(taskId, { integrationIntent: intent });
  service.store.updateTeam(teamId, { publicationGuard: { operationId, taskId, reviewId: review.review?.id,
  expectedCommit: committed.commit, state: 'integrating' } });
  service.store.addEvent(teamId, 'merge.integration_prepared', { taskId, operationId, branch, worktree: intent.worktree });
  prepared = true;
  });
  if (!prepared) return { ok: false, needsCaptain: true, error: 'integration intent changed; reconciliation required' };
  const merged = await mergeCommitToBranch({ repo: service.repo, commit: committed.commit, branch, base: baseBranch,
  operationId, artifactBase: mergeBase });
  if (!merged.ok) {
  service.store.transaction(() => {
  const current = service.store.getTask(taskId);
  if (current?.integrationIntent?.operationId === operationId && current.integrationIntent.state === 'prepared') {
  service.store.updateTask(taskId, { mergeState: 'conflict', mergeError: merged.error,
    integrationIntent: { ...intent, state: 'unknown', error: merged.error }, needsCaptain: true }, { publicationOwner: operationId });
  } else {
  const team = service.store.getTeam(teamId);
  service.store.updateTeam(teamId, { needsCaptain: true, integrationConflicts: [...(team.integrationConflicts ?? []), { ...intent, state: 'unknown', error: merged.error }] }, { publicationOwner: operationId });
  }
  service.store.updateTeam(teamId, { needsCaptain: true,
  publicationGuard: undefined }, { publicationOwner: operationId });
  service.store.addEvent(teamId, 'task.merge_conflict', { taskId, error: merged.error, branch, operationId });
  });
  return merged;
  }
  let settled = false;
  service.store.transaction(() => {
  const current = service.store.getTask(taskId);
  const evidence = merged.ownershipEvidence;
  let expectedPath = '';
  let actualPath = '';
  try {
  expectedPath = realpathSync.native(intent.worktree);
  if (typeof evidence?.worktree === 'string') actualPath = realpathSync.native(evidence.worktree);
  } catch {
  // Missing or replaced paths cannot establish ownership.
  }
  const pathsMatch = process.platform === 'win32'
  ? Boolean(expectedPath && actualPath && expectedPath.toLowerCase() === actualPath.toLowerCase())
  : Boolean(expectedPath && actualPath && expectedPath === actualPath);
  if (!current || current.integrationIntent?.operationId !== operationId || current.integrationIntent.state !== 'prepared'
  || current.status !== 'completed' || evidence?.operationId !== operationId || evidence?.token !== operationId
  || evidence?.branch !== branch || evidence?.refOid !== merged.commit || !pathsMatch) {
  const team = service.store.getTeam(teamId);
  service.store.updateTeam(teamId, { needsCaptain: true, publicationGuard: undefined,
  integrationConflicts: [...(team.integrationConflicts ?? []),
  { ...intent, state: 'unknown', commit: merged.commit, ownership: merged.ownershipEvidence }] }, { publicationOwner: operationId });
  service.store.addEvent(teamId, 'merge.integration_unknown', { taskId, operationId });
  return;
  }
  service.store.updateTask(taskId, {
  mergeState: 'review_pending',
  mergeCommit: committed.commit,
  integrationCommit: merged.commit,
  integrationBranch: branch,
  integrationWorktree: merged.worktree,
  integrationOwnership: merged.ownershipEvidence,
  integrationIntent: { ...intent, state: 'settled', commit: merged.commit, ownership: merged.ownershipEvidence },
  }, { publicationOwner: operationId });
  service.store.updateTeam(teamId, { publicationGuard: undefined }, { publicationOwner: operationId });
  service.store.addEvent(teamId, 'task.merged_to_integration', {
  taskId, commit: committed.commit, integrationCommit: merged.commit, branch, worktree: merged.worktree, operationId,
  });
  settled = true;
  });
  if (!settled) return { ok: false, needsCaptain: true, error: 'integration result requires reconciliation' };
  const review = await service.reviewMerge(teamId, taskId);
  return { ...merged, ok: review.ok === true, merged: true, review };
}

