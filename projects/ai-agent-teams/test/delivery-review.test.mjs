import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReviewResults, bindPendingRechecks, isCurrentDeliveryTask, isCurrentReview, isInactiveHistory, planReviewJobs, retryReviewJob, selectCurrentReview, selectRepairEpisode, validateReviewPolicy } from '../src/domain/delivery-review.mjs';

const reviewPolicy = { requiredRoles: ['security', 'quality'], kByRole: { security: 3, quality: 3 } };
function reviewRound() {
  const plan = planReviewJobs({ unitId: 'unit-1', artifactDigest: 'sha256:abc', reviewEpoch: 7, policyVersion: 'v18', rubricVersion: 'rubric-v1', codeTask: false, deadlineMs: 101, policy: reviewPolicy });
  plan.jobs = plan.jobs.map((job) => ({ ...job, status: 'claimed', attemptId: `attempt-${job.id}-${job.attempt}`,
    leaseId: `lease-${job.id}-${job.attempt}`, leaseExpiresAt: 101, memberId: `member-${job.role}-${job.slotOrdinal}`, principalKey: `principal-${job.role}-${job.slotOrdinal}`,
    licenseId: `license-principal-${job.role}-${job.slotOrdinal}` }));
  return plan;
}
function resultFor(job, overrides = {}) {
  const principalKey = `principal-${job.role}-${job.slotOrdinal}`;
  return {
    id: `result-${job.id}`, jobId: job.id, unitId: job.unitId, artifactDigest: job.artifactDigest,
    reviewEpoch: job.reviewEpoch, policyVersion: job.policyVersion, role: job.role, slotOrdinal: job.slotOrdinal,
    attempt: job.attempt, attemptId: `attempt-${job.id}-${job.attempt}`, leaseId: `lease-${job.id}-${job.attempt}`, receivedAt: 100,
    trustedIdentity: { verified: true, memberId: `member-${job.role}-${job.slotOrdinal}`, principalKey, licenseId: `license-${principalKey}` },
    summary: '审查完成，摘要覆盖变更与结论。', rubricVersion: 'rubric-v1',
    scores: { completeness: 5, correctness: 5, requirements: 5, omissions: 5 }, findings: [], evidence: ['diff:sha256:abc'],
    codeTask: false, codeScores: null, verdict: 'pass', ...overrides,
  };
}

test('policy validation enforces exact role keys and bounded k; invalid plans create no jobs', () => {
  for (const policy of [
    { requiredRoles: [], kByRole: {} },
    { requiredRoles: ['x', 'x'], kByRole: { x: 1 } },
    { requiredRoles: ['x', 'y'], kByRole: { x: 1 } },
    { requiredRoles: ['x'], kByRole: { x: 1, y: 1 } },
    ...[0, 1.5, 33].map((k) => ({ requiredRoles: ['x'], kByRole: { x: k } })),
    { requiredRoles: ['a', 'b', 'c'], kByRole: { a: 32, b: 32, c: 1 } },
  ]) {
    assert.equal(validateReviewPolicy(policy).valid, false);
    assert.deepEqual(planReviewJobs({ unitId: 'u', artifactDigest: 'd', reviewEpoch: 1, policyVersion: 'p', policy }).jobs, []);
  }
});

test('review plan creates deterministic role slots bound to digest, epoch, and policy', () => {
  const first = reviewRound();
  const second = reviewRound();
  assert.equal(first.jobs.length, 6);
  assert.deepEqual(first.jobs.map(({ id, role, slotOrdinal }) => ({ id, role, slotOrdinal })), second.jobs.map(({ id, role, slotOrdinal }) => ({ id, role, slotOrdinal })));
  assert.deepEqual(first.jobs.filter((job) => job.role === 'security').map((job) => job.slotOrdinal), [0, 1, 2]);
  assert.notEqual(first.jobs[0].id, planReviewJobs({ unitId: 'unit-1', artifactDigest: 'sha256:other', reviewEpoch: 7, policyVersion: 'v18', rubricVersion: 'rubric-v1', codeTask: false, deadlineMs: 101, policy: reviewPolicy }).jobs[0].id);
  const retried = retryReviewJob({ ...first.jobs[0], status: 'stopped', terminationVerified: true });
  assert.equal(retried.job.id, first.jobs[0].id);
  assert.equal(retried.job.attempt, 1);
  assert.equal(retryReviewJob({ ...first.jobs[0], status: 'completed' }).action, 'rejected');
});

test('aggregation waits for every slot and rejects untrusted, implementer, reused, and late identities', () => {
  const plan = reviewRound();
  const results = plan.jobs.map((job) => resultFor(job));
  assert.equal(aggregateReviewResults({ plan, results: results.slice(0, -1), implementerPrincipalKey: 'author', implementerMemberIds: ['author-member'], nowEpoch: 100, currentReviewEpoch: 7 }).verdict, 'pending');
  const author = resultFor(plan.jobs[0], { trustedIdentity: { verified: true, principalKey: 'author', licenseId: 'l' } });
  const duplicate = resultFor(plan.jobs[1], { trustedIdentity: results[0].trustedIdentity });
  const late = resultFor(plan.jobs[2], { receivedAt: 101 });
  const untrusted = resultFor(plan.jobs[3], { trustedIdentity: { verified: false, principalKey: 'bad', licenseId: 'l' } });
  const outcome = aggregateReviewResults({ plan, results: [author, results[0], duplicate, late, untrusted, ...results.slice(4)], implementerPrincipalKey: 'author', implementerMemberIds: ['author-member'], nowEpoch: 100, currentReviewEpoch: 7 });
  assert.equal(outcome.verdict, 'pending');
  assert.equal(outcome.accepted.length, 3);
});

test('reject escalates immediately; needs_revision waits for all and creates one repair decision', () => {
  const plan = reviewRound();
  const all = plan.jobs.map((job) => resultFor(job));
  const partialReject = aggregateReviewResults({ plan, results: [resultFor(plan.jobs[0], { verdict: 'reject' })], implementerPrincipalKey: 'author', implementerMemberIds: ['author-member'], nowEpoch: 100, currentReviewEpoch: 7 });
  assert.equal(partialReject.verdict, 'reject');
  const reject = aggregateReviewResults({ plan, results: all.map((result, index) => index === 4 ? { ...result, verdict: 'reject' } : result), implementerPrincipalKey: 'author', implementerMemberIds: ['author-member'], nowEpoch: 100, currentReviewEpoch: 7 });
  assert.equal(reject.verdict, 'reject');
  assert.equal(reject.escalationOnly, true);
  const revision = aggregateReviewResults({ plan, results: all.map((result, index) => index === 2 ? { ...result, verdict: 'needs_revision', findings: [{ severity: 'high', problem: 'x', requiredFix: 'fix' }] } : result), implementerPrincipalKey: 'author', implementerMemberIds: ['author-member'], nowEpoch: 100, currentReviewEpoch: 7 });
  assert.equal(revision.reason, 'conflicting-verdicts');
  assert.equal(revision.needsCaptain, true);
  const unanimous = aggregateReviewResults({ plan, results: all.map((result) => ({ ...result, verdict: 'needs_revision', findings: [{ severity: 'high', problem: 'x', requiredFix: 'fix' }] })), implementerPrincipalKey: 'author', implementerMemberIds: ['author-member'], nowEpoch: 100, currentReviewEpoch: 7 });
  assert.equal(unanimous.verdict, 'needs_revision');
  assert.equal(unanimous.repairDecision, 'create_once');
});

test('conflicting replay and epoch or score defects fail closed', () => {
  const plan = reviewRound();
  const first = resultFor(plan.jobs[0]);
  const conflict = aggregateReviewResults({ plan, results: [first, { ...first, verdict: 'reject', id: 'conflict' }], implementerPrincipalKey: 'author', implementerMemberIds: ['author-member'], nowEpoch: 100, currentReviewEpoch: 7 });
  assert.equal(conflict.verdict, 'hold');
  assert.equal(conflict.needsCaptain, true);
  assert.equal(conflict.rejected[0].result.verdict, 'reject');
  const malformed = aggregateReviewResults({ plan, results: [resultFor(plan.jobs[0], { scores: { completeness: 6 } })], implementerPrincipalKey: 'author', implementerMemberIds: ['author-member'], nowEpoch: 100, currentReviewEpoch: 8 });
  assert.equal(malformed.accepted.length, 0);
});

test('review slots reject a repeated member even if principal strings differ', () => {
  const plan = reviewRound();
  const first = resultFor(plan.jobs[0]);
  plan.jobs[1].memberId = first.trustedIdentity.memberId;
  const second = resultFor(plan.jobs[1], { trustedIdentity: { verified: true,
    memberId: first.trustedIdentity.memberId, principalKey: plan.jobs[1].principalKey, licenseId: plan.jobs[1].licenseId } });
  const outcome = aggregateReviewResults({ plan, results: [first, second], implementerPrincipalKey: 'author',
    implementerMemberIds: ['author-member'], nowEpoch: 100, currentReviewEpoch: 7 });
  assert.equal(outcome.verdict, 'pending');
  assert.equal(outcome.rejected[0].reason, 'principal-reused');
  assert.equal(outcome.rejected[0].result, second);
});

test('review rounds require author identity, a live claim, fixed rubric and passing scores', () => {
  const plan = reviewRound();
  const results = plan.jobs.map((job) => resultFor(job));
  const run = (items, overrides = {}) => aggregateReviewResults({ plan, results: items,
    implementerPrincipalKey: 'author', implementerMemberIds: ['author-member'], nowEpoch: 100, currentReviewEpoch: 7, ...overrides });
  assert.equal(run(results, { implementerPrincipalKey: undefined }).verdict, 'hold');
  assert.equal(run(results, { nowEpoch: 101 }).reason, 'blocked_sla');
  assert.equal(run([{ ...results[0], attemptId: 'forged' }, ...results.slice(1)]).verdict, 'pending');
  assert.equal(run([{ ...results[0], rubricVersion: 'changed' }, ...results.slice(1)]).verdict, 'pending');
  assert.equal(run([{ ...results[0], codeTask: true }, ...results.slice(1)]).verdict, 'pending');
  const low = { ...results[0], scores: { completeness: 4, correctness: 4, requirements: 4, omissions: 4 } };
  assert.equal(run([low, ...results.slice(1)]).reason, 'pass-quality-threshold-not-met');
  assert.equal(retryReviewJob({ ...plan.jobs[0], status: 'stopped' }).action, 'rejected');
});

test('selectCurrentReview includes archived rows so an older pass cannot revive', () => {
  const rows = [{ id: 'old-pass', deliveryGeneration: 1, unitReviewSeq: 1, verdict: 'pass' },
    { id: 'new-cancelled', deliveryGeneration: 1, unitReviewSeq: 2, archived: true }];
  assert.equal(selectCurrentReview(rows).id, 'new-cancelled');
  assert.equal(selectCurrentReview([{ id: 'g1', deliveryGeneration: 1 }, { id: 'g2', deliveryGeneration: 2 }]).id, 'g2');
});

test('current generation guard excludes reopen history and missing-generation repairs', () => {
  const root = { id: 'root', kind: 'work', taskEpoch: 2 };
  assert.equal(isCurrentDeliveryTask({ id: 'old', kind: 'repair', deliveryUnitId: 'root', deliveryGeneration: 1 }, [root]), false);
  assert.equal(isCurrentDeliveryTask({ id: 'missing', kind: 'repair', deliveryUnitId: 'root' }, [root]), false);
  assert.equal(isCurrentDeliveryTask({ id: 'new', kind: 'repair', deliveryUnitId: 'root', deliveryGeneration: 2 }, [root]), true);
  assert.equal(isCurrentDeliveryTask({ id: 'archived', kind: 'work', historical: true }, []), false);
});

test('isCurrentReview rejects old generation and archived latest review without falling back', () => {
  const root = { id: 'root', kind: 'work', taskEpoch: 2 };
  const old = { id: 'old', kind: 'review', reviewedTaskId: 'root', deliveryGeneration: 1 };
  const current = { id: 'current', kind: 'review', reviewedTaskId: 'root', deliveryGeneration: 2, unitReviewSeq: 2, archived: true };
  assert.equal(isCurrentReview(old, [root, old, current]), false);
  assert.equal(isCurrentReview(current, [root, old, current]), false);
});

test('legacy review membership follows every source/review edge through a repair chain', () => {
  const root = { id: 'root', kind: 'work', taskEpoch: 4 };
  const repair1 = { id: 'repair-1', kind: 'repair', sourceTaskId: 'root', taskEpoch: 1 };
  const review1 = { id: 'review-1', kind: 'review', reviewedTaskId: 'repair-1', reviewMode: 'legacy', deliveryGeneration: 4, legacyReviewEpoch: 1 };
  const repair2 = { id: 'repair-2', kind: 'repair', sourceTaskId: 'repair-1', taskEpoch: 1 };
  const review2 = { id: 'review-2', kind: 'review', reviewedTaskId: 'repair-2', reviewMode: 'legacy', deliveryGeneration: 4, legacyReviewEpoch: 2 };
  const tasks = [root, repair1, review1, repair2, review2];
  assert.equal(isCurrentReview(review1, tasks), false);
  assert.equal(isCurrentReview(review2, tasks), true);
  assert.equal(isCurrentDeliveryTask({ ...repair1, deliveryGeneration: 4 }, [root, repair1]), true);
});

test('legacy root resolution rejects missing parents, cycles, and unsupported node kinds', () => {
  const missing = { id: 'orphan', kind: 'repair', sourceTaskId: 'absent', deliveryGeneration: 1 };
  const a = { id: 'a', kind: 'repair', sourceTaskId: 'b', deliveryGeneration: 1 };
  const b = { id: 'b', kind: 'repair', sourceTaskId: 'a', deliveryGeneration: 1 };
  const malformed = { id: 'bad', kind: 'repair', parentTaskId: 'root', deliveryGeneration: 1 };
  const root = { id: 'root', kind: 'work', taskEpoch: 1 };
  assert.equal(isCurrentDeliveryTask(missing, [missing]), false);
  assert.equal(isCurrentDeliveryTask(a, [a, b]), false);
  assert.equal(isCurrentDeliveryTask(malformed, [root, malformed]), false);
});

test('legacy review selection uses reviewMode/binding, ignores task.mode, and compares max legacy epoch', () => {
  const root = { id: 'root', kind: 'work', taskEpoch: 3 };
  const repair = { id: 'repair', kind: 'repair', sourceTaskId: 'root', deliveryGeneration: 3 };
  const legacyOld = { id: 'legacy-old', kind: 'review', reviewedTaskId: 'root', reviewMode: 'legacy', mode: 'bound', deliveryGeneration: 3, legacyReviewEpoch: 9 };
  const legacyNew = { id: 'legacy-new', kind: 'review', reviewedTaskId: 'repair', reviewMode: 'legacy', mode: 'bound', deliveryGeneration: 3, legacyReviewEpoch: 2, reviewEpoch: 10 };
  const bound = { id: 'bound', kind: 'review', reviewedTaskId: 'root', binding: { deliveryUnitId: 'root', sourceCommit: 'commit' }, mode: 'legacy', deliveryGeneration: 3, unitReviewSeq: 1 };
  const tasks = [root, repair, legacyOld, legacyNew, bound];
  assert.equal(selectCurrentReview([legacyOld, legacyNew], 'legacy').id, 'legacy-new');
  assert.equal(isCurrentReview(legacyOld, tasks), false);
  assert.equal(isCurrentReview(legacyNew, tasks), true);
  assert.equal(isCurrentReview(bound, tasks), true);
  assert.equal(isInactiveHistory({ id: 'cancelled-history', cancelReason: 'superseded' }), true);
});

test('explicit review mode wins; an old partial binding without sourceCommit is legacy', () => {
  const root = { id: 'root', kind: 'implementation', taskEpoch: 0 };
  const legacy = { id: 'legacy', kind: 'review', reviewedTaskId: 'root', binding: { deliveryUnitId: 'root' }, reviewEpoch: 1 };
  const explicitBound = { id: 'bound', kind: 'review', reviewedTaskId: 'root', reviewMode: 'bound', unitReviewSeq: 1 };
  assert.equal(isCurrentReview(legacy, [root, legacy, explicitBound]), true);
  assert.equal(isCurrentReview(explicitBound, [root, legacy, explicitBound]), true);
});

test('selectRepairEpisode is idempotent for terminal repairs and requires captain permit after cancellation', () => {
  const review = { id: 'review-1' };
  const completed = { id: 'repair-1', kind: 'repair', parentReviewTaskId: review.id, repairGeneration: 0, status: 'completed' };
  assert.deepEqual(selectRepairEpisode({ review, tasks: [completed] }), { action: 'existing', task: completed });
  const cancelled = { ...completed, id: 'repair-cancelled', status: 'cancelled' };
  assert.equal(selectRepairEpisode({ review, tasks: [cancelled] }).needsCaptain, true);
  const result = selectRepairEpisode({ review, tasks: [cancelled], retryPermit: { id: 'permit', reviewId: review.id, generation: 1, authorizedBy: { role: 'captain' } } });
  assert.deepEqual(result, { action: 'new', key: 'review:review-1', generation: 1, consumeRetryPermit: 'permit' });
  for (const retryPermit of [
    { id: 'wrong-review', reviewId: 'other', generation: 1, authorizedBy: { role: 'captain' } },
    { id: 'wrong-generation', reviewId: review.id, generation: 2, authorizedBy: { role: 'captain' } },
    { id: 'used', reviewId: review.id, generation: 1, consumed: true, authorizedBy: { role: 'captain' } },
    { id: 'not-captain', reviewId: review.id, generation: 1, authorizedBy: { role: 'reviewer' } },
  ]) assert.equal(selectRepairEpisode({ review, tasks: [cancelled], retryPermit }).action, 'none');
});

test('bindPendingRechecks binds once, keeps commit immutable and rejects drift or dispatched pending binding', () => {
  const repair = { id: 'repair', status: 'completed', sourceCommit: 'c1', taskEpoch: 3, deliveryGeneration: 2 };
  const pending = { id: 'recheck', reviewedTaskId: 'repair', status: 'pending', bindingPending: true, expectedRepairTaskEpoch: 3, deliveryGeneration: 2 };
  const binding = bindPendingRechecks(repair, [pending]);
  assert.deepEqual(binding.updates, [{ id: 'recheck', reviewedSourceCommit: 'c1', bindingPending: false, reviewedTaskEpoch: 3 }]);
  assert.deepEqual(bindPendingRechecks(repair, [{ ...pending, bindingPending: false, reviewedSourceCommit: 'c1' }]).updates, []);
  assert.equal(bindPendingRechecks({ ...repair, sourceCommit: 'c2' }, [{ ...pending, bindingPending: false, reviewedSourceCommit: 'c1' }]).action, 'blocked');
  assert.equal(bindPendingRechecks(repair, [{ ...pending, expectedRepairTaskEpoch: 4 }]).reason, 'recheck-generation-mismatch');
  assert.equal(bindPendingRechecks(repair, [{ ...pending, status: 'in_progress' }]).reason, 'unbound-review-already-dispatched');
});
