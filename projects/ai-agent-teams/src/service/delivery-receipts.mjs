// Delivery merge identity and receipt bookkeeping.
//
// These helpers were extracted from SchedulerService so the merge gate, the
// publication itself and the post-merge write-back share one implementation
// without living in the 8k-line service file. They are pure with respect to
// the service: every dependency arrives through the context argument.
import { boundReviewScoresSatisfied } from '../domain/gates.mjs';
import { isCurrentReview, isInactiveHistory } from '../domain/delivery-review.mjs';
import { detectDrift, snapshotScope } from '../domain/artifacts.mjs';
import { isAncestorCommit, isGitRepository } from '../git/merge-queue.mjs';

/**
 * Decide whether a task still needs an independent review for its current
 * artifact. A bound review must match the exact source commit, base, diff
 * hash and delivery slot; a legacy review is matched by its reviewed commit
 * or by a refreshed artifact snapshot.
 */
export function currentMergeReview({ config, store }, teamId, task) {
  if (!config.quality.requireIndependentReview || !['implementation', 'repair'].includes(task.kind)) {
    return { required: false };
  }
  const teamTasks = store.listTasks(teamId);
  const implementer = task.assigneeId && store.getMember(task.assigneeId);
  const artifactMatches = (item) => {
    if (typeof task.sourceCommit === 'string' && task.sourceCommit.length > 0) {
      if (item.reviewMode === 'legacy') return item.reviewedSourceCommit === task.sourceCommit;
      return item.binding?.sourceTaskId === task.id && item.binding?.sourceCommit === task.sourceCommit
        && Boolean(task.sourceBase) && item.binding?.sourceBase === task.sourceBase
        && Boolean(task.diffHash) && item.binding?.diffHash === task.diffHash
        && item.binding?.deliveryUnitId === task.deliveryUnitId
        && item.binding?.deliverySeq === task.deliverySeq;
    }
    if (!task.worktree || !Array.isArray(item.reviewedArtifacts) || item.reviewedArtifacts.length === 0
      || (item.reviewedGaps ?? []).length > 0 || !item.reviewedAttemptId
      || item.reviewedAttemptId !== (task.attemptId ?? task.lastAttemptId)) return false;
    try {
      const snapshot = snapshotScope(task.worktree, task.inScope ?? []);
      return snapshot.gaps.length === 0 && detectDrift(item.reviewedArtifacts, snapshot.artifacts).length === 0;
    } catch {
      return false;
    }
  };
  const review = teamTasks.find((item) => (
    item.kind === 'review' && item.reviewedTaskId === task.id && item.status === 'completed' && item.verdict === 'pass'
    && (!((item.reviewMode === 'bound') || (!item.reviewMode && item.binding?.sourceCommit)) || boundReviewScoresSatisfied(item.scores))
    && isCurrentReview(item, teamTasks) && typeof task.assigneeId === 'string' && typeof item.assigneeId === 'string'
    && task.assigneeId !== item.assigneeId && implementer?.teamId === teamId
    && store.getMember(item.assigneeId)?.teamId === teamId
    && artifactMatches(item)
  ));
  return { required: true, review };
}

/**
 * Resolve the actual delivery unit/group and the newest completed deliverable
 * plus its latest passing review. This is the single merge identity used by
 * the gate, the merge itself and the post-merge write-back.
 */
export function resolveDeliveryMergeTarget({ config, store }, teamId, entry) {
  const tasks = store.listTasks(teamId);
  const byId = new Map(tasks.map((item) => [item.id, item]));
  if (entry.kind === 'repair' && entry.mode === 'legacy' && !entry.deliveryUnitId && entry.sourceTaskId) {
    const parent = byId.get(entry.sourceTaskId);
    if (parent && parent.mode === 'bound') {
      return { ok: false, blocked: 'mixed_mode_requires_captain', needsCaptain: true,
        error: 'a legacy repair cannot be published as a bound delivery; rebuild it as a bound repair' };
    }
  }
  let root = entry;
  if (entry.parentIntegrationId) root = byId.get(entry.parentIntegrationId) ?? entry;
  else if (entry.deliveryUnitId && entry.deliveryUnitId !== entry.id) {
    root = byId.get(entry.deliveryUnitId) ?? entry;
  } else if (entry.kind === 'repair' && entry.sourceTaskId) {
    let cursor = byId.get(entry.sourceTaskId);
    const seen = new Set();
    while (cursor && cursor.kind === 'repair' && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (cursor.deliveryUnitId && byId.has(cursor.deliveryUnitId)) {
        cursor = byId.get(cursor.deliveryUnitId);
        break;
      }
      cursor = cursor.sourceTaskId ? byId.get(cursor.sourceTaskId) : undefined;
    }
    if (cursor) root = cursor;
  }
  if (!root || root.teamId !== teamId) {
    return { ok: false, blocked: 'legacy_root_unresolved', needsCaptain: true,
      error: 'delivery root is missing or belongs to another team' };
  }
  if (root.kind === 'integration') return { ok: true, integration: true, root, group: [root], newest: root };

  const unitId = root.deliveryUnitId ?? root.id;
  const rootMode = root.mode === 'bound' ? 'bound' : 'legacy';
  let group;
  if (rootMode === 'bound') {
    group = tasks.filter((item) => item.id === unitId || item.deliveryUnitId === unitId
      || (item.kind === 'review' && item.binding?.deliveryUnitId === unitId));
  } else {
    const ids = new Set([root.id]);
    const reviewIds = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of tasks) {
        if (item.kind === 'review') {
          if (ids.has(item.reviewedTaskId) && !reviewIds.has(item.id)) {
            reviewIds.add(item.id);
            changed = true;
          }
          continue;
        }
        if (ids.has(item.id)) continue;
        if (item.kind === 'repair' && (ids.has(item.sourceTaskId)
          || (item.deliveryUnitId && ids.has(item.deliveryUnitId))
          || (item.parentReviewTaskId && reviewIds.has(item.parentReviewTaskId)))) {
          ids.add(item.id);
          changed = true;
        }
      }
    }
    group = tasks.filter((item) => ids.has(item.id) || reviewIds.has(item.id));
  }
  const groupIds = new Set(group.map((item) => item.id));
  const mixed = group.some((item) => item.kind === 'repair'
    && ((rootMode === 'legacy' && item.mode === 'bound')
      || (rootMode === 'bound' && item.mode !== 'bound')));
  if (mixed) {
    return { ok: false, blocked: 'mixed_mode_requires_captain', needsCaptain: true,
      error: 'delivery unit mixes bound and legacy repairs' };
  }
  const deliverable = group.filter((item) => ['implementation', 'repair'].includes(item.kind)
    && item.status === 'completed' && !isInactiveHistory(item)
    && (rootMode !== 'bound' || item.kind !== 'repair' || !Number.isInteger(item.deliveryGeneration)
      || item.deliveryGeneration === (root.taskEpoch ?? 0)));
  if (deliverable.length === 0) {
    return { ok: false, blocked: 'no_completed_delivery', needsCaptain: true,
      error: 'delivery group has no completed implementation or repair' };
  }
  if (rootMode === 'legacy') {
    deliverable.sort((left, right) => (
      (right.round ?? 0) - (left.round ?? 0)
      || (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      || (right.createdAt ?? 0) - (left.createdAt ?? 0)
      || String(left.id).localeCompare(String(right.id))
    ));
  } else {
    deliverable.sort((left, right) => (
      (right.deliverySeq ?? -1) - (left.deliverySeq ?? -1)
      || (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      || (right.createdAt ?? 0) - (left.createdAt ?? 0)
      || String(left.id).localeCompare(String(right.id))
    ));
  }
  const newest = deliverable[0];
  // The merge range starts at the delivery unit's base, not at the newest
  // repair's parent: otherwise a cherry-pick applies only the repair delta.
  const deliveryBase = root.sourceBase
    ?? group.find((item) => item.id === unitId)?.sourceBase
    ?? newest.sourceBase;
  // Pre-V15 rows may carry a root commit but no recorded base. Falling back
  // to the newest repair's own base would exclude the root implementation
  // from the range while still marking the root delivered.
  if (rootMode === 'legacy' && deliverable.length > 1
    && !root.sourceBase && !group.find((item) => item.id === unitId)?.sourceBase) {
    return { ok: false, blocked: 'delivery_base_missing', needsCaptain: true, root, group, newest,
      error: 'legacy delivery has no recorded root base; replaying only the repair commits would drop the implementation' };
  }
  const reviews = group.filter((item) => item.kind === 'review'
    && isCurrentReview(item, tasks) && groupIds.has(item.reviewedTaskId));
  reviews.sort((left, right) => (
    ((right.reviewEpoch ?? right.legacyReviewEpoch ?? 0) - (left.reviewEpoch ?? left.legacyReviewEpoch ?? 0))
    || ((right.round ?? 0) - (left.round ?? 0))
    || ((right.attempt ?? 0) - (left.attempt ?? 0))
    || ((right.createdAt ?? 0) - (left.createdAt ?? 0))
    || String(left.id).localeCompare(String(right.id))
  ));
  const latest = reviews[0];
  if (latest && latest.reviewedTaskId !== newest.id) {
    return { ok: false, blocked: 'newer_delivery_unreviewed', needsCaptain: true,
      root, group, newest, review: latest,
      error: `${newest.id} is newer than reviewed ${latest.reviewedTaskId}; merge it through review` };
  }
  if (latest && (latest.status !== 'completed' || latest.verdict !== 'pass')) {
    const blocked = latest.status === 'cancelled' || latest.archived || latest.historical
      ? 'review_cancelled'
      : latest.status === 'failed' ? 'review_failed'
        : ['pending', 'claimed', 'in_progress'].includes(latest.status) ? 'review_pending' : 'review_not_passed';
    return { ok: false, blocked, needsCaptain: true, root, group, newest, review: latest,
      error: `latest delivery review is ${latest.status ?? 'unknown'}${latest.verdict ? `/${latest.verdict}` : ''}` };
  }
  // The latest row may be pending while an older pass exists. Never fall back
  // to that old pass.
  if (!latest) {
    if (config.quality.requireIndependentReview) {
      return { ok: false, blocked: 'review_required', needsCaptain: true, root, group, newest,
        error: 'newest delivery has no current passing independent review' };
    }
    return { ok: true, root, group, newest, review: undefined,
      sourceCommit: newest.sourceCommit, sourceBase: deliveryBase, legacy: rootMode === 'legacy' };
  }
  if (rootMode === 'bound' && (!latest.binding?.sourceCommit
    || latest.binding.sourceCommit !== newest.sourceCommit
    || latest.binding.deliveryUnitId !== unitId
    || latest.binding.deliverySeq !== newest.deliverySeq
    || !boundReviewScoresSatisfied(latest.scores))) {
    return { ok: false, blocked: 'review_delivery_mismatch', needsCaptain: true, root, group, newest, review: latest,
      error: 'latest bound review does not match the newest delivery commit/unit/seq or scores' };
  }
  if (rootMode === 'legacy') {
    if (!latest.reviewedSourceCommit || !newest.sourceCommit) {
      return { ok: false, blocked: 'review_unbound', needsCaptain: true, root, group, newest, review: latest,
        error: 'latest legacy review has no reviewed source commit' };
    }
    if (latest.reviewedSourceCommit !== newest.sourceCommit) {
      return { ok: false, blocked: 'review_delivery_mismatch', needsCaptain: true, root, group, newest, review: latest,
        error: 'latest legacy review does not match the newest delivery commit' };
    }
  }
  if (newest.assigneeId && latest.assigneeId && newest.assigneeId === latest.assigneeId) {
    return { ok: false, blocked: 'review_not_independent', needsCaptain: true, root, group, newest, review: latest,
      error: 'latest review belongs to the delivery author' };
  }
  if (!newest.assigneeId && newest.assignee && latest.assignee && newest.assignee === latest.assignee) {
    return { ok: false, blocked: 'review_not_independent', needsCaptain: true, root, group, newest, review: latest,
      error: 'latest review belongs to the delivery author' };
  }
  const sourceCommit = latest.binding?.sourceCommit ?? latest.reviewedSourceCommit;
  if (!sourceCommit) {
    return { ok: false, blocked: 'no_source_commit', needsCaptain: true, root, group, newest, review: latest,
      error: 'newest delivery has no reviewed source commit' };
  }
  return { ok: true, root, group, newest, review: latest, sourceCommit, sourceBase: deliveryBase,
    legacy: rootMode === 'legacy' };
}

/**
 * Write merged receipts for every member of a delivery group. A sibling whose
 * commit is not inside the published range is marked blocked instead of being
 * silently claimed as delivered.
 */
export function markDeliveryMerged(ctx, teamId, delivery, commit, publicationOwner) {
  const { store, repo } = ctx;
  const group = delivery.group ?? [];
  const excluded = [];
  const tip = delivery.sourceCommit ?? delivery.newest?.sourceCommit;
  // true = git repo, false = git explicitly says "not a repository", null =
  // git could not answer. Only the explicit false may use the no-git fixture
  // fallback; an unreadable repository must stay fail-closed.
  const repoState = isGitRepository(repo);
  // Archived rows belong to a previous delivery generation. Writing a
  // blocked receipt to them (or counting them as siblings) made every
  // reopen->redeliver path look like a partial publication.
  const ids = new Set(group.filter((item) => ['implementation', 'repair'].includes(item.kind)
    && item.status === 'completed' && !isInactiveHistory(item)).map((item) => item.id));
  if (delivery.newest?.status === 'completed' && !isInactiveHistory(delivery.newest)) ids.add(delivery.newest.id);
  if (delivery.root?.status === 'completed' && !isInactiveHistory(delivery.root)) ids.add(delivery.root.id);
  for (const id of ids) {
    const current = store.getTask(id);
    if (!current || current.teamId !== teamId || isInactiveHistory(current)) continue;
    // A delivery group is linear by contract. Do not issue a merged receipt
    // for a sibling repair whose commit never entered the published range:
    // that silently drops its content while claiming it was delivered.
    const hasIdentity = typeof current.sourceCommit === 'string' && current.sourceCommit.length > 0;
    const ancestry = hasIdentity && tip && current.sourceCommit !== tip
      ? isAncestorCommit(repo, current.sourceCommit, tip) : null;
    const ordered = (current.deliverySeq ?? 0) <= (delivery.newest?.deliverySeq ?? 0);
    // A real repository must answer the ancestry question. Returning null
    // (invalid object, missing sourceCommit, git error) is not permission to
    // fall back to deliverySeq; only a git-less fixture may do that.
    const included = hasIdentity
      ? current.id === delivery.newest?.id || current.sourceCommit === tip || ancestry === true
      : repoState === false && ordered;
    if (!included) {
      excluded.push(id);
      store.updateTask(id, {
        mergeState: 'blocked', mergeBlockReason: 'sibling_not_in_delivery',
        needsCaptain: true, bindingState: 'blocked',
      }, { publicationOwner });
      continue;
    }
    store.updateTask(id, {
      mergeState: 'merged',
      bindingState: 'merged',
      // mergeCommit is the reviewed source identity; mergedCommit is the
      // actual commit applied to the target branch.
      mergeCommit: current.sourceCommit ?? commit,
      mergedCommit: commit,
      mergeReverted: false,
      mergeRevertedAt: undefined,
      ffAttempt: 0,
    }, { publicationOwner });
  }
  if (delivery.root?.status === 'failed' && delivery.root.id !== delivery.newest.id) {
    const root = store.getTask(delivery.root.id);
    if (root) {
      store.updateTask(root.id, {
        closedLoop: { ...(root.closedLoop ?? {}), deliveredBy: delivery.newest.id, deliveredAt: ctx.now() },
        mergeState: undefined,
        mergedCommit: undefined,
        mergeCommit: undefined,
      }, { publicationOwner });
    }
  }
  return { excluded };
}
