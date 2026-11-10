// Publication and integration recovery.
//
// Extracted from SchedulerService: a daemon restart or a captain-confirmed
// publication can leave Git and the task row disagreeing. These routines are
// the only place that reconciles that disagreement, so they live together
// instead of inside the core scheduler loop.
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  cleanupIntegration,
  discardIntegrationArtifact,
  fastForwardBranch,
  integrationBranchTip,
  integrationWorktreeHead,
  isAncestorCommit,
  mergeBaseCommit,
  rangeDiffDigest,
} from '../git/merge-queue.mjs';

/**
 * The publication already moved the target ref, but the checked-out worktree
 * could not be reset. Later publications read `git status` in that repository
 * and would fail as dirty, so the discrepancy must be surfaced instead of
 * reporting a clean publication.
 */
export function publicationWorktreeWarning(integration) {
  if (integration?.ok !== true || integration.worktreeSynced !== false) return undefined;
  return `target ${integration.target} advanced to ${integration.commit} but its worktree could not be reset; run "git reset --hard ${integration.commit}" before the next publication`;
}

export async function reconcileIntegrationIntent(service, teamId, task) {
  const intent = task.integrationIntent;
  if (!intent || intent.state !== 'prepared') return false;
  const branch = intent.branch ?? task.integrationBranch;
  const worktree = intent.worktree ?? task.integrationWorktree;
  let tip = null;
  let tipReadFailed = false;
  if (branch) {
    try {
      tip = await integrationBranchTip(service.repo, branch);
    } catch {
      // A transient git/IO failure is not proof that the branch was never
      // created. Fall through to the hold path instead of clearing the intent.
      tipReadFailed = true;
    }
  }
  const releaseGuard = () => {
    const team = service.store.getTeam(teamId);
    if (team?.publicationGuard?.operationId === intent.operationId) {
      service.store.updateTeam(teamId, { publicationGuard: undefined, needsCaptain: true },
        { publicationOwner: intent.operationId });
    }
  };
  if (!tip && !tipReadFailed) {
    service.store.transaction(() => {
      const current = service.store.getTask(task.id);
      if (current?.integrationIntent?.operationId !== intent.operationId
        || current.integrationIntent.state !== 'prepared') return;
      service.store.updateTask(task.id, {
        integrationIntent: undefined, mergeState: undefined, mergeError: undefined,
        needsCaptain: false, publicationRecovery: undefined,
        publicationRecoveryState: 'integration_intent_cleared',
      }, { publicationOwner: intent.operationId });
      releaseGuard();
      service.store.addEvent(teamId, 'merge.integration_intent_cleared', {
        taskId: task.id, operationId: intent.operationId, recovery: 'no_external_artifact',
      });
    });
    return true;
  }
  const head = worktree ? await integrationWorktreeHead(worktree) : null;
  let canonicalWorktree;
  try {
    canonicalWorktree = worktree ? realpathSync.native(worktree) : undefined;
  } catch {
    canonicalWorktree = undefined;
  }
  const baseBranch = intent.baseBranch
    ?? service.config.teams.find((item) => item.id === teamId)?.baseBranch ?? 'main';
  const baseCommit = await mergeBaseCommit(service.repo, baseBranch, branch);
  const artifactBase = intent.artifactBase ?? task.sourceBase;
  const expectedDigest = artifactBase && intent.sourceCommit
    ? await rangeDiffDigest(service.repo, artifactBase, intent.sourceCommit) : null;
  const actualDigest = baseCommit && tip ? await rangeDiffDigest(service.repo, baseCommit, tip) : null;
  // A branch created before the patch was applied sits exactly at the base
  // commit. Adopting it would mark an empty integration as delivered, so the
  // recovered tip must carry the same diff as the reviewed artifact.
  const carriesArtifact = Boolean(expectedDigest && actualDigest
    && expectedDigest === actualDigest && tip !== baseCommit);
  if (head && head === tip && canonicalWorktree && carriesArtifact) {
    const evidence = {
      token: intent.operationId, operationId: intent.operationId,
      canonicalRepo: realpathSync.native(service.repo), branch, worktree: canonicalWorktree, refOid: tip,
    };
    service.store.transaction(() => {
      const current = service.store.getTask(task.id);
      if (current?.integrationIntent?.operationId !== intent.operationId
        || current.integrationIntent.state !== 'prepared') return;
      service.store.updateTask(task.id, {
        integrationIntent: { ...intent, state: 'settled', commit: tip, ownership: evidence },
        mergeState: 'review_pending',
        mergeCommit: intent.sourceCommit,
        integrationCommit: tip,
        integrationBranch: branch,
        integrationWorktree: worktree,
        integrationOwnership: evidence,
        needsCaptain: false,
        publicationRecovery: undefined,
        publicationRecoveryState: 'integration_adopted_after_restart',
      }, { publicationOwner: intent.operationId });
      releaseGuard();
      service.store.addEvent(teamId, 'merge.integration_adopted_after_restart', {
        taskId: task.id, operationId: intent.operationId, commit: tip, branch,
      });
    });
    return true;
  }
  service.store.transaction(() => {
    const current = service.store.getTask(task.id);
    if (current?.integrationIntent?.operationId !== intent.operationId
      || current.integrationIntent.state !== 'prepared') return;
    service.store.updateTask(task.id, {
      integrationIntent: { ...intent, state: 'unknown' },
      integrationBranch: branch,
      integrationWorktree: worktree,
      mergeState: 'review_pending',
      mergeReviewError: 'integration outcome unknown after daemon restart',
      needsCaptain: true,
      mergeBlockReason: 'integration_outcome_unknown',
      publicationRecovery: undefined,
      publicationRecoveryState: 'integration_outcome_unknown',
    }, { publicationOwner: intent.operationId });
    releaseGuard();
    service.store.addEvent(teamId, 'merge.integration_recovery_held', {
      taskId: task.id, operationId: intent.operationId, branch, tip,
    });
  });
  return true;

}

export async function reconcilePublication(service, teamId, taskId, { applied, publishedCommit, actor } = {}) {
  if (!service.canActAsCaptain(teamId, actor)) {
    throw Object.assign(new Error('reconciling a publication requires captain authority'), { status: 403, code: 'E_FORBIDDEN' });
  }
  if (typeof applied !== 'boolean') {
    throw Object.assign(new Error('reconcilePublication requires applied=true|false'), { status: 400, code: 'E_INVALID' });
  }
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  const team = service.store.getTeam(teamId);
  const guard = team?.publicationGuard?.taskId === taskId ? team.publicationGuard : undefined;
  const recovery = task.publicationRecovery;
  const intentRecovery = task.integrationIntent
    && ['unknown', 'prepared'].includes(task.integrationIntent.state)
    ? { operationId: task.integrationIntent.operationId, expectedCommit: task.integrationIntent.sourceCommit }
    : undefined;
  const operationId = guard?.operationId ?? recovery?.operationId ?? intentRecovery?.operationId;
  if (!operationId) {
    throw Object.assign(new Error('no pending publication for this task'), { status: 409, code: 'E_STATE' });
  }
  const releaseGuard = () => {
    const fresh = service.store.getTeam(teamId);
    if (fresh?.publicationGuard?.operationId === operationId) {
      service.store.updateTeam(teamId, { publicationGuard: undefined }, { publicationOwner: operationId });
    }
  };
  const expectedCommit = guard?.expectedCommit ?? recovery?.expectedCommit ?? task.mergeCommit ?? task.sourceCommit;
  if (!applied) {
    const branch = task.integrationBranch ?? task.integrationIntent?.branch;
    const worktree = task.integrationWorktree ?? task.integrationIntent?.worktree;
    if (task.integrationCommit) {
      // The integration commit exists; only publication is in doubt. If the
      // post-merge review already passed, the only valid retry is the
      // publication itself: going back to review_pending would be terminal
      // because reviewMergeUnlocked returns alreadyReviewed and mergeTask
      // refuses to re-integrate a settled intent.
      if (task.postMergeReview === 'pass' || task.mergeState === 'ff_failed') {
        service.store.transaction(() => {
          service.store.updateTask(taskId, {
            mergeState: 'ff_failed',
            ffAttempt: 0,
            mergeReviewError: undefined, mergeError: undefined, needsCaptain: false,
            publicationRecovery: undefined,
            publicationRecoveryState: 'captain_confirmed_not_applied_retry_publication',
          }, { publicationOwner: operationId });
          releaseGuard();
          service.store.addEvent(teamId, 'merge.publication_confirmed_not_applied', {
            taskId, operationId, actor: actor?.name ?? actor?.role ?? 'captain', recovery: 'retry_publication',
          });
        });
        return { ok: true, applied: false, retryable: true, recovery: 'retry_publication' };
      }
      service.store.transaction(() => {
        service.store.updateTask(taskId, {
          mergeState: 'review_pending',
          postMergeClaim: undefined,
          mergeReviewError: undefined, mergeError: undefined, needsCaptain: false,
          publicationRecovery: undefined,
          publicationRecoveryState: 'captain_confirmed_not_applied_integration',
        }, { publicationOwner: operationId });
        releaseGuard();
        service.store.addEvent(teamId, 'merge.publication_confirmed_not_applied', {
          taskId, operationId, actor: actor?.name ?? actor?.role ?? 'captain', recovery: 'resume_review',
        });
      });
      return { ok: true, applied: false, retryable: true, recovery: 'resume_review' };
    }
    if (branch) {
      const discarded = await discardIntegrationArtifact({ repo: service.repo, branch, worktree });
      if (!discarded.ok) {
        // The captain confirmed "not applied", but the artifact could not be
        // removed. Keep the guard and the recovery record so the decision can
        // be retried instead of silently leaving an orphan branch/worktree.
        service.store.addEvent(teamId, 'merge.publication_discard_failed', {
          taskId, operationId, branch, worktree, error: discarded.error,
        });
        service.store.updateTask(taskId, {
          needsCaptain: true,
          mergeReviewError: `discard integration artifact failed: ${discarded.error ?? 'unknown error'}`,
          publicationRecoveryState: 'discard_failed',
        }, { publicationOwner: operationId });
        return { ok: false, applied: false, retryable: true, needsCaptain: true, error: discarded.error };
      }
    }
    service.store.transaction(() => {
      service.store.updateTask(taskId, {
        mergeState: task.mergeState === 'publication_unknown' ? undefined : task.mergeState,
        mergeError: undefined, mergeReviewError: undefined, needsCaptain: false,
        integrationIntent: undefined, integrationBranch: undefined, integrationWorktree: undefined,
        integrationOwnership: undefined, postMergeClaim: undefined,
        publicationRecovery: undefined,
        publicationRecoveryState: 'captain_confirmed_not_applied',
      }, { publicationOwner: operationId });
      releaseGuard();
      service.store.addEvent(teamId, 'merge.publication_confirmed_not_applied', {
        taskId, operationId, actor: actor?.name ?? actor?.role ?? 'captain', recovery: 'discard_artifact',
      });
    });
    return { ok: true, applied: false, retryable: true, recovery: 'discard_artifact' };
  }
  const baseBranch = service.config.teams.find((item) => item.id === teamId)?.baseBranch ?? 'main';
  const published = await integrationBranchTip(service.repo, baseBranch);
  const integrationCommit = task.integrationCommit;
  let confirmedCommit = published;
  if (integrationCommit) {
    // A post-merge reviewed integration is only "applied" when the target
    // branch actually contains that commit and the review passed.
    if (task.postMergeReview !== 'pass') {
      throw Object.assign(new Error('cannot confirm a publication before a passing post-merge review'),
        { status: 409, code: 'E_STATE' });
    }
    if (!published || isAncestorCommit(service.repo, integrationCommit, published) !== true) {
      throw Object.assign(new Error('integration commit is not contained in the target branch'),
        { status: 409, code: 'E_STATE' });
    }
    confirmedCommit = published;
  } else {
    // Direct publication (post-merge review off) has no integration commit.
    // The captain must name the exact published commit and it must be on the
    // target branch; a bare "applied" is not evidence.
    if (service.config.quality.postMergeReview !== 'off') {
      throw Object.assign(new Error('a publication without an integration commit requires postMergeReview=off'),
        { status: 409, code: 'E_STATE' });
    }
    if (typeof publishedCommit !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(publishedCommit)) {
      throw Object.assign(new Error('applied=true requires the exact publishedCommit for a direct publication'),
        { status: 400, code: 'E_INVALID' });
    }
    if (!published || isAncestorCommit(service.repo, publishedCommit, published) !== true) {
      throw Object.assign(new Error('publishedCommit is not contained in the target branch'),
        { status: 409, code: 'E_STATE' });
    }
    confirmedCommit = publishedCommit;
  }
  let result;
  let deliveryError;
  service.store.transaction(() => {
    const snapshot = service.store.updateTask(taskId, {
      mergeState: 'merged',
      mergeCommit: task.mergeCommit ?? task.sourceCommit ?? expectedCommit,
      mergedCommit: confirmedCommit,
      mergeReviewError: undefined, mergeError: undefined, needsCaptain: false,
      publicationRecovery: undefined,
      publicationRecoveryState: 'captain_confirmed_applied',
    }, { publicationOwner: operationId });
    const delivery = service.resolveDeliveryMergeTarget(teamId, snapshot);
    let excluded = [];
    if (delivery.ok && !delivery.integration) {
      const marked = service.markDeliveryMerged(teamId, delivery, confirmedCommit, operationId);
      excluded = marked.excluded ?? [];
    } else if (!delivery.ok) {
      // The task itself is confirmed, but the delivery group could not be
      // resolved. Do not report a clean success and leave siblings without
      // a receipt.
      deliveryError = delivery.blocked ?? 'delivery_unknown';
      service.store.updateTask(taskId, { needsCaptain: true,
        mergeReviewError: `publication confirmed but delivery receipt is incomplete: ${deliveryError}` },
      { publicationOwner: operationId });
    }
    if (task.parentIntegrationId) {
      const parent = service.store.getTask(task.parentIntegrationId);
      if (parent?.kind === 'integration') {
        service.store.updateTask(parent.id, {
          mergeState: 'merged',
          mergedCommit: confirmedCommit,
          mergeCommit: parent.mergeCommit ?? task.mergeCommit ?? confirmedCommit,
          mergeReverted: false,
          mergeRevertedAt: undefined,
          closedLoop: { ...(parent.closedLoop ?? {}), deliveredBy: task.id, deliveredAt: service.now() },
        }, { publicationOwner: operationId });
      }
    }
    if (excluded.length > 0) service.store.updateTeam(teamId, { needsCaptain: true }, { publicationOwner: operationId });
    releaseGuard();
    service.store.addEvent(teamId, 'merge.publication_confirmed_applied', {
      taskId, operationId, commit: confirmedCommit, excluded, deliveryError,
      actor: actor?.name ?? actor?.role ?? 'captain',
    });
    result = excluded.length > 0
      ? { ok: false, applied: true, commit: confirmedCommit, blocked: 'sibling_not_in_delivery',
        excluded, needsCaptain: true,
        error: `publication confirmed but ${excluded.join(', ')} is not in the delivered commit range` }
      : deliveryError
        ? { ok: false, applied: true, commit: confirmedCommit, blocked: deliveryError, needsCaptain: true,
          error: `publication confirmed but the delivery group could not be receipted (${deliveryError})` }
        : { ok: true, applied: true, commit: confirmedCommit };
  });
  // The artifact no longer needs to stay checked out after the captain
  // confirmed the publication. Keep the pointers when cleanup fails so
  // retryCleanup can finish the job.
  if (task.integrationBranch) {
    let cleaned;
    try {
      cleaned = await cleanupIntegration({ repo: service.repo, worktree: task.integrationWorktree,
        branch: task.integrationBranch, ownershipEvidence: task.integrationOwnership });
    } catch (error) {
      cleaned = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (cleaned?.ok) {
      service.store.updateTask(taskId, { integrationBranch: undefined, integrationWorktree: undefined,
        integrationOwnership: undefined }, { publicationOwner: operationId });
    } else {
      service.store.updateTask(taskId, { cleanupPending: true, needsCaptain: true,
        mergeReviewError: `integration cleanup failed: ${cleaned?.error ?? 'unknown error'}` },
      { publicationOwner: operationId });
    }
  }
  return result;

}

export async function retryCleanup(service, teamId, taskId) {
  const task = service.store.getTask(taskId);
  if (!task || task.teamId !== teamId) throw new Error(`unknown task: ${taskId}`);
  if (!task.cleanupPending) return { ok: true, alreadyClean: true };
  if (!task.integrationBranch) {
    service.store.updateTask(taskId, { cleanupPending: false, mergeReviewError: undefined, needsCaptain: false });
    return { ok: true, cleaned: true };
  }
  let cleaned;
  try {
    cleaned = await cleanupIntegration({ repo: service.repo, worktree: task.integrationWorktree,
      branch: task.integrationBranch, ownershipEvidence: task.integrationOwnership });
  } catch (error) {
    cleaned = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (cleaned?.ok !== true) {
    service.store.updateTask(taskId, { cleanupPending: true, needsCaptain: true,
      mergeReviewError: cleaned?.error ?? 'integration cleanup failed' });
    service.store.addEvent(teamId, 'merge.cleanup_failed', { taskId, error: cleaned?.error, retry: true });
    return { ok: false, cleanupPending: true, needsCaptain: true, error: cleaned?.error };
  }
  service.store.updateTask(taskId, { cleanupPending: false, mergeReviewError: undefined,
    integrationWorktree: undefined, integrationBranch: undefined, integrationOwnership: undefined,
    needsCaptain: false });
  service.store.addEvent(teamId, 'merge.cleanup_retried', { taskId });
  return { ok: true, cleaned: true };

}

export async function retryPublication(service, teamId, taskId) {
  const snapshot = service.store.getTask(taskId);
  if (!snapshot || snapshot.teamId !== teamId) {
    return { ok: false, needsCaptain: true, error: 'unknown task for this team' };
  }
  if (!snapshot.integrationBranch || !snapshot.integrationCommit) {
    return { ok: false, needsCaptain: true, error: 'no integration commit to retry' };
  }
  const publicationOwner = randomUUID();
  let acquired = false;
  service.store.transaction(() => {
    const latestTeam = service.store.getTeam(teamId);
    const latestTask = service.store.getTask(taskId);
    if (!latestTeam || service.store.getPublicationGuard(teamId) || !latestTask
      || latestTask.teamId !== teamId
      || latestTask.status !== 'completed' || latestTask.mergeState !== 'ff_failed'
      || latestTask.integrationCommit !== snapshot.integrationCommit) return;
    service.store.updateTeam(teamId, { publicationGuard: { operationId: publicationOwner, taskId,
      expectedCommit: snapshot.integrationCommit, state: 'publishing' } });
    service.store.addEvent(teamId, 'merge.publication_retry', { taskId, operationId: publicationOwner });
    acquired = true;
  });
  if (!acquired) return { ok: false, needsCaptain: true, error: 'publication state changed or is already held' };
  const baseBranch = service.config.teams.find((team) => team.id === teamId)?.baseBranch ?? 'main';
  const integration = await fastForwardBranch({
    repo: service.repo, branch: snapshot.integrationBranch, target: baseBranch,
    expectedCommit: snapshot.integrationCommit,
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
      const guarded = service.store.getTeam(teamId);
      const uncertain = /after fast-forward/.test(integration.error ?? '');
      service.store.updateTeam(teamId, { needsCaptain: true,
        publicationGuard: uncertain ? { ...guarded.publicationGuard, state: 'unknown' } : undefined,
      }, { publicationOwner });
    });
    service.store.addEvent(teamId, 'merge.ff_failed', { taskId, branch: snapshot.integrationBranch,
      error: integration.error, retry: true });
    return { ok: false, needsCaptain: true, integration };
  }
  // The fast-forward awaited external Git. A concurrent reopen/epoch change
  // must not receive a merged receipt for the previous generation.
  const syncWarning = publicationWorktreeWarning(integration);
  const afterFf = service.store.getTask(taskId);
  const guardAfterFf = service.store.getTeam(teamId)?.publicationGuard;
  if (!afterFf || afterFf.status !== 'completed' || afterFf.mergeState !== 'ff_failed'
    || afterFf.taskEpoch !== snapshot.taskEpoch
    || afterFf.integrationCommit !== snapshot.integrationCommit
    || guardAfterFf?.operationId !== publicationOwner) {
    if (guardAfterFf?.operationId === publicationOwner) {
      service.store.updateTeam(teamId, { publicationGuard: undefined }, { publicationOwner });
    }
    service.store.addEvent(teamId, 'merge.publication_late_ignored', {
      taskId, operationId: publicationOwner, publishedCommit: snapshot.integrationCommit,
      reason: 'task generation or publication guard changed during fast-forward',
    });
    return { ok: false, needsCaptain: true, stalePublication: true,
      error: 'publication state changed during fast-forward; do not treat the old generation as merged' };
  }
  let cleanup;
  try {
    cleanup = await cleanupIntegration({ repo: service.repo, worktree: snapshot.integrationWorktree,
      branch: snapshot.integrationBranch, ownershipEvidence: snapshot.integrationOwnership });
  } catch (error) {
    cleanup = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const publishedCommit = snapshot.integrationCommit;
  if (cleanup?.ok !== true) {
    const error = cleanup?.error ?? 'integration cleanup failed';
    let excluded = [];
    service.store.transaction(() => {
      service.store.updateTask(taskId, { mergeState: 'merged', postMergeReview: 'pass', reviewedAt: service.now(),
        cleanupPending: true, needsCaptain: true,
        mergeReviewError: syncWarning ? `${error}; ${syncWarning}` : error,
        ...(syncWarning ? { publicationWorktreeSync: { target: integration.target, commit: integration.commit, state: 'not_synced' } } : {}) },
      { publicationOwner });
      const delivery = service.resolveDeliveryMergeTarget(teamId, service.store.getTask(taskId));
      if (delivery.ok && !delivery.integration) {
        const marked = service.markDeliveryMerged(teamId, delivery, publishedCommit, publicationOwner);
        excluded = marked.excluded ?? [];
      }
      service.store.updateTeam(teamId, { publicationGuard: undefined }, { publicationOwner });
    });
    service.store.addEvent(teamId, 'merge.cleanup_failed', { taskId, error, retry: true, excluded });
    if (syncWarning) service.store.addEvent(teamId, 'merge.publication_worktree_not_synced', { taskId, ...integration });
    return { ok: false, needsCaptain: true, cleanupPending: true, error,
      ...(excluded.length ? { blocked: 'sibling_not_in_delivery', excluded } : {}) };
  }
  let excluded = [];
  service.store.transaction(() => {
    service.store.updateTask(taskId, { mergeState: 'merged', postMergeReview: 'pass',
      reviewedAt: service.now(), integrationWorktree: undefined,
      ...(syncWarning ? { needsCaptain: true, mergeReviewError: syncWarning,
        publicationWorktreeSync: { target: integration.target, commit: integration.commit, state: 'not_synced' } } : {}) },
    { publicationOwner });
    const delivery = service.resolveDeliveryMergeTarget(teamId, service.store.getTask(taskId));
    if (delivery.ok && !delivery.integration) {
      const marked = service.markDeliveryMerged(teamId, delivery, publishedCommit, publicationOwner);
      excluded = marked.excluded ?? [];
    }
    if (snapshot.parentIntegrationId) {
      const parent = service.store.getTask(snapshot.parentIntegrationId);
      if (parent?.kind === 'integration') {
        service.store.updateTask(parent.id, {
          mergeState: 'merged',
          mergedCommit: publishedCommit,
          mergeCommit: parent.mergeCommit ?? snapshot.mergeCommit ?? publishedCommit,
          mergeReverted: false,
          mergeRevertedAt: undefined,
          closedLoop: { ...(parent.closedLoop ?? {}), deliveredBy: taskId, deliveredAt: service.now() },
        }, { publicationOwner });
      }
    }
    service.store.updateTeam(teamId, { publicationGuard: undefined }, { publicationOwner });
  });
  service.store.addEvent(teamId, 'merge.publication_retried', { taskId, commit: publishedCommit, excluded });
  if (syncWarning) service.store.addEvent(teamId, 'merge.publication_worktree_not_synced', { taskId, ...integration });
  if (excluded.length > 0) {
    return { ok: false, verdict: 'pass', integration, alreadyReviewed: true, needsCaptain: true,
      blocked: 'sibling_not_in_delivery', excluded,
      error: `delivery published but ${excluded.join(', ')} is not in the reviewed commit range` };
  }
  return syncWarning
    ? { ok: true, verdict: 'pass', integration, alreadyReviewed: true, needsCaptain: true, warning: syncWarning }
    : { ok: true, verdict: 'pass', integration, alreadyReviewed: true };

}
