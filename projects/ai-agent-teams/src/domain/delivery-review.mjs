import { createHash } from 'node:crypto';

const INACTIVE = new Set(['archived', 'historical', 'superseded']);

const REVIEW_SCORE_FIELDS = ['completeness', 'correctness', 'requirements', 'omissions'];
const CODE_SCORE_FIELDS = ['correctness', 'structure', 'readability', 'simplicity', 'maintainability'];

function stableId(parts) {
  return `review_${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

export function validateReviewPolicy(policy) {
  const roles = policy?.requiredRoles;
  const counts = policy?.kByRole;
  if (!Array.isArray(roles) || roles.length === 0 || roles.some((role) => typeof role !== 'string' || !role.trim() || role !== role.trim())
    || new Set(roles).size !== roles.length || !counts || typeof counts !== 'object' || Array.isArray(counts)) {
    return { valid: false, error: 'invalid-required-roles' };
  }
  const keys = Object.keys(counts);
  if (keys.length !== roles.length || keys.some((key) => !roles.includes(key))) return { valid: false, error: 'k-by-role-keys-mismatch' };
  let total = 0;
  for (const role of roles) {
    const k = counts[role];
    if (!Number.isInteger(k) || k < 1 || k > 32) return { valid: false, error: 'invalid-role-count', role };
    total += k;
  }
  if (total > 64) return { valid: false, error: 'review-job-limit-exceeded' };
  return { valid: true, total };
}

/** Creates a deterministic plan only. It does not persist jobs or start reviewers. */
export function planReviewJobs({ unitId, artifactDigest, reviewEpoch, policyVersion, rubricVersion, codeTask, deadlineMs, policy } = {}) {
  const validation = validateReviewPolicy(policy);
  if (!validation.valid) return { action: 'rejected', error: validation.error, jobs: [] };
  if (![unitId, artifactDigest, policyVersion, rubricVersion].every((value) => typeof value === 'string' && value.trim().length > 0)
    || typeof codeTask !== 'boolean' || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0
    || !Number.isSafeInteger(reviewEpoch) || reviewEpoch < 0) {
    return { action: 'rejected', error: 'incomplete-review-binding', jobs: [] };
  }
  const jobs = policy.requiredRoles.flatMap((role) => Array.from({ length: policy.kByRole[role] }, (_, slotOrdinal) => ({
    id: stableId([unitId, artifactDigest, reviewEpoch, role, slotOrdinal]), unitId, artifactDigest, reviewEpoch,
    policyVersion, rubricVersion, codeTask, role, slotOrdinal, attempt: 0, status: 'queued',
  })));
  return { action: 'planned', binding: { unitId, artifactDigest, reviewEpoch, policyVersion, rubricVersion, codeTask, deadlineMs }, jobs };
}

/** Advances an existing slot attempt without changing its stable job identity. */
export function retryReviewJob(job) {
  if (!job?.id || !Number.isSafeInteger(job.attempt) || job.attempt < 0
    || job.status !== 'stopped' || job.terminationVerified !== true) {
    return { action: 'rejected', reason: 'invalid-or-terminal-job' };
  }
  return { action: 'retry', job: { ...job, attempt: job.attempt + 1, status: 'queued', attemptId: undefined,
    leaseId: undefined, principalKey: undefined, memberId: undefined, licenseId: undefined, leaseExpiresAt: undefined, terminationVerified: undefined } };
}

function scoreIsValid(scores, fields) {
  return scores && fields.every((field) => Number.isInteger(scores[field]) && scores[field] >= 1 && scores[field] <= 5)
    && Object.keys(scores).every((field) => fields.includes(field));
}

function resultIsComplete(result) {
  if (typeof result.summary !== 'string' || !result.summary.trim() || !result.rubricVersion
    || !scoreIsValid(result.scores, REVIEW_SCORE_FIELDS) || !Array.isArray(result.findings)
    || result.findings.some((finding) => !finding || typeof finding !== 'object')
    || !Array.isArray(result.evidence) || result.evidence.length === 0
    || result.evidence.some((item) => typeof item !== 'string' || !item.trim())) return false;
  if (result.codeTask === true) return scoreIsValid(result.codeScores, CODE_SCORE_FIELDS)
    && Array.isArray(result.codeEvidence) && result.codeEvidence.length > 0
    && result.codeEvidence.every((item) => typeof item === 'string' && item.trim());
  return result.codeScores === null;
}

/** Pure closed-world aggregation; any invalid, conflicting, or missing proof fails closed. */
export function aggregateReviewResults({ plan, results = [], implementerPrincipalKey, implementerMemberIds, nowEpoch, currentReviewEpoch } = {}) {
  if (!plan?.binding || !Array.isArray(plan.jobs) || !Number.isFinite(nowEpoch)
    || typeof implementerPrincipalKey !== 'string' || !implementerPrincipalKey.trim()
    || !Array.isArray(implementerMemberIds) || implementerMemberIds.length === 0
    || implementerMemberIds.some((id) => typeof id !== 'string' || !id.trim())
    || !Number.isSafeInteger(plan.binding.deadlineMs)
    || !Number.isSafeInteger(currentReviewEpoch)) {
    return { verdict: 'hold', needsCaptain: true, reason: 'missing-round-binding' };
  }
  const accepted = new Map();
  const rejected = [];
  let conflict = false;
  if (nowEpoch >= plan.binding.deadlineMs) {
    return { verdict: 'hold', needsCaptain: true, reason: 'blocked_sla', results };
  }
  for (const result of results) {
    const job = plan.jobs.find((candidate) => candidate.id === result.jobId);
    const identity = result.trustedIdentity;
    const bindingMatches = job && result.unitId === job.unitId && result.artifactDigest === job.artifactDigest
      && result.reviewEpoch === job.reviewEpoch && result.policyVersion === job.policyVersion
      && result.role === job.role && result.slotOrdinal === job.slotOrdinal && result.attempt === job.attempt
      && result.rubricVersion === plan.binding.rubricVersion && result.codeTask === plan.binding.codeTask
      && job.status === 'claimed' && job.attemptId === result.attemptId && job.leaseId === result.leaseId
      && job.principalKey === result.trustedIdentity?.principalKey && job.memberId === result.trustedIdentity?.memberId
      && job.licenseId === result.trustedIdentity?.licenseId;
    if (!bindingMatches || result.reviewEpoch !== currentReviewEpoch || !Number.isFinite(result.receivedAt)
      || result.receivedAt > nowEpoch || !Number.isFinite(job?.leaseExpiresAt) || nowEpoch >= job.leaseExpiresAt) {
      rejected.push({ resultId: result.id, reason: 'late-or-binding-mismatch', result }); continue;
    }
    if (!result.attemptId || !identity?.verified || !identity.principalKey || !identity.memberId || !identity.licenseId
      || identity.principalKey === implementerPrincipalKey || implementerMemberIds.includes(identity.memberId) || !result.leaseId || !result.summary
      || !resultIsComplete(result)) {
      rejected.push({ resultId: result.id, reason: 'missing-or-untrusted-evidence', result }); continue;
    }
    const duplicatePrincipal = [...accepted.values()].some((item) => (item.trustedIdentity.principalKey === identity.principalKey
      || item.trustedIdentity.memberId === identity.memberId) && item.jobId !== result.jobId);
    if (duplicatePrincipal) { rejected.push({ resultId: result.id, reason: 'principal-reused', result }); continue; }
    const prior = accepted.get(job.id);
    if (prior) {
      if (prior.attemptId === result.attemptId && JSON.stringify(prior) === JSON.stringify(result)) continue;
      conflict = true; rejected.push({ resultId: result.id, reason: 'duplicate-or-conflicting-result', result }); continue;
    }
    accepted.set(job.id, result);
  }
  if (conflict) return { verdict: 'hold', needsCaptain: true, reason: 'conflicting-results', accepted: [...accepted.values()], rejected };
  if ([...accepted.values()].some((result) => result.verdict === 'reject')) {
    return { verdict: 'reject', escalationOnly: true, needsCaptain: true, accepted: [...accepted.values()], rejected };
  }
  const complete = plan.jobs.length > 0 && accepted.size === plan.jobs.length;
  if (!complete) return { verdict: 'pending', complete: false, accepted: [...accepted.values()], rejected };
  const verdicts = [...accepted.values()].map((result) => result.verdict);
  if (verdicts.some((verdict) => !['pass', 'reject', 'needs_revision'].includes(verdict))) {
    return { verdict: 'hold', needsCaptain: true, reason: 'invalid-verdict', accepted: [...accepted.values()], rejected };
  }
  if (new Set(verdicts).size > 1) {
    return { verdict: 'hold', needsCaptain: true, reason: 'conflicting-verdicts', accepted: [...accepted.values()], rejected };
  }
  for (const result of accepted.values()) {
    if (result.verdict === 'pass' && (Object.values(result.scores).reduce((sum, n) => sum + n, 0) / REVIEW_SCORE_FIELDS.length < 4.5
      || (plan.binding.codeTask && Object.values(result.codeScores).reduce((sum, n) => sum + n, 0) / CODE_SCORE_FIELDS.length < 4)
      || result.findings.some((finding) => !finding.resolved && ['high', 'blocker'].includes(finding.severity)))) {
      return { verdict: 'hold', needsCaptain: true, reason: 'pass-quality-threshold-not-met', accepted: [...accepted.values()], rejected };
    }
    if (result.verdict === 'needs_revision' && result.findings.length === 0) {
      return { verdict: 'hold', needsCaptain: true, reason: 'revision-without-findings', accepted: [...accepted.values()], rejected };
    }
  }
  if (verdicts.includes('needs_revision')) return { verdict: 'needs_revision', repairDecision: 'create_once', accepted: [...accepted.values()], rejected };
  return { verdict: 'pass', accepted: [...accepted.values()], rejected };
}

export function isInactiveHistory(task) {
  return !task || task.archived === true || task.historical === true
    || task.superseded === true || task.cancelReason === 'superseded' || INACTIVE.has(task.historyState);
}

function legacyReviewOrder(a, b) {
  return Math.max(b.legacyReviewEpoch ?? 0, b.reviewEpoch ?? 0)
    - Math.max(a.legacyReviewEpoch ?? 0, a.reviewEpoch ?? 0)
    || (b.round ?? 0) - (a.round ?? 0)
    || (b.attempt ?? 0) - (a.attempt ?? 0)
    || (b.createdAt ?? 0) - (a.createdAt ?? 0)
    || String(a.id).localeCompare(String(b.id));
}

export function selectCurrentReview(reviews, mode = 'bound') {
  return [...(reviews ?? [])].sort((a, b) =>
    (b.deliveryGeneration ?? 0) - (a.deliveryGeneration ?? 0)
    || (mode === 'legacy' ? legacyReviewOrder(a, b)
      : (b.unitReviewSeq ?? 0) - (a.unitReviewSeq ?? 0)
        || (b.reviewEpoch ?? 0) - (a.reviewEpoch ?? 0)
        || String(a.id).localeCompare(String(b.id))))[0];
}

function resolveLegacyRoot(task, tasks) {
  let current = task;
  const seen = new Set();
  while (current) {
    if (!current.id || seen.has(current.id)) return undefined;
    seen.add(current.id);
    if (['implementation', 'work', 'integration'].includes(current.kind)) return current;
    if (current.kind !== 'repair' && current.kind !== 'review') return undefined;
    const parentId = current.sourceTaskId ?? current.reviewedTaskId;
    if (!parentId) return undefined;
    current = tasks.find((item) => item.id === parentId);
  }
  return undefined;
}

function isLegacyReview(review) {
  if (review?.legacyUnbound === true) return true;
  if (review?.reviewMode === 'legacy') return true;
  if (review?.reviewMode === 'bound') return false;
  return !review?.binding?.sourceCommit;
}

export function isCurrentDeliveryTask(task, tasks = []) {
  if (!task || isInactiveHistory(task)) return false;
  if (!['implementation', 'repair', 'work', 'integration'].includes(task.kind)) return true;
  const root = task.kind === 'repair'
    ? (task.parentIntegrationId ? tasks.find((item) => item.id === task.parentIntegrationId)
      : task.deliveryUnitId ? tasks.find((item) => item.id === task.deliveryUnitId) : resolveLegacyRoot(task, tasks))
    : task;
  if (!root || isInactiveHistory(root)) return false;
  return task.kind !== 'repair' || (task.deliveryGeneration !== undefined
    && task.deliveryGeneration === (root.taskEpoch ?? 0));
}

export function isCurrentReview(review, tasks = []) {
  if (!review || isInactiveHistory(review)) return false;
  const source = tasks.find((task) => task.id === review.reviewedTaskId);
  if (!source || isInactiveHistory(source)) return false;
  const root = review.binding?.deliveryUnitId
    ? tasks.find((task) => task.id === review.binding.deliveryUnitId)
    : resolveLegacyRoot(source, tasks);
  if (!root || isInactiveHistory(root) || (review.deliveryGeneration ?? 0) !== (root.taskEpoch ?? 0)) return false;
  const legacy = isLegacyReview(review);
  const unitIds = new Set(tasks.filter((task) => task.id === root.id || task.deliveryUnitId === root.id).map((task) => task.id));
  const belongsToRoot = (task) => {
    if (!legacy) return unitIds.has(task.reviewedTaskId);
    return task.id === root.id || resolveLegacyRoot(task, tasks)?.id === root.id;
  };
  const candidates = tasks.filter((task) => task.kind === 'review' && belongsToRoot(task)
    && isLegacyReview(task) === legacy);
  const latest = selectCurrentReview(candidates, legacy ? 'legacy' : 'bound');
  return latest?.id === review.id && !isInactiveHistory(latest);
}

export function selectRepairEpisode({ review, tasks = [], retryPermit } = {}) {
  if (!review?.id) return { action: 'none', needsCaptain: true, reason: 'review-identity-missing' };
  const key = `review:${review.id}`;
  const rows = tasks.filter((task) => task.kind === 'repair'
    && (task.repairKey === key || task.parentReviewTaskId === review.id))
    .sort((a, b) => (b.repairGeneration ?? 0) - (a.repairGeneration ?? 0)
      || String(a.id).localeCompare(String(b.id)));
  const latest = rows[0];
  if (latest && latest.status !== 'cancelled' && !isInactiveHistory(latest)) return { action: 'existing', task: latest };
  const generation = latest ? Math.max(...rows.map((task) => task.repairGeneration ?? 0)) + 1 : 0;
  if (latest && (!retryPermit || retryPermit.reviewId !== review.id || retryPermit.generation !== generation
    || retryPermit.consumed === true || retryPermit.authorizedBy?.role !== 'captain')) {
    return { action: 'none', needsCaptain: true, reason: 'repair-cancelled-retry-requires-captain' };
  }
  return { action: 'new', key, generation, consumeRetryPermit: latest ? retryPermit.id : undefined };
}

export function bindPendingRechecks(repair, reviews = []) {
  if (repair?.status !== 'completed' || !repair.sourceCommit) return { action: 'none', reason: 'repair-not-committed' };
  const selected = reviews.filter((review) => review.reviewedTaskId === repair.id && !isInactiveHistory(review));
  const updates = [];
  for (const review of selected) {
    if (review.expectedRepairTaskEpoch !== (repair.taskEpoch ?? 0)
      // Legacy repairs predate deliveryGeneration. Only compare it when the
      // repair actually carries one, otherwise a valid legacy recheck could
      // never bind.
      || (repair.deliveryGeneration !== undefined && review.deliveryGeneration !== repair.deliveryGeneration)) {
      return { action: 'blocked', needsCaptain: true, reason: 'recheck-generation-mismatch' };
    }
    if (review.bindingPending !== true) {
      if (review.reviewedSourceCommit !== repair.sourceCommit) return { action: 'blocked', needsCaptain: true, reason: 'recheck-commit-mismatch' };
      continue;
    }
    if (review.status !== 'pending') return { action: 'blocked', needsCaptain: true, reason: 'unbound-review-already-dispatched' };
    updates.push({ id: review.id, reviewedSourceCommit: repair.sourceCommit, bindingPending: false, reviewedTaskEpoch: repair.taskEpoch ?? 0 });
  }
  return { action: 'bind_rechecks', updates };
}
