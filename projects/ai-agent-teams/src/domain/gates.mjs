/**
 * Compatible public surface for pure quality gates. Implementations live under
 * gates/ by responsibility; internal modules never import this facade.
 * The daemon still owns command execution and persisted evidence.
 */
export { normalizeWorkspacePath, isDefaultExcludedPath, pathMatchesScope, classifyChangedPath } from './changes.mjs';
export { repairScopeReport, deriveRepairScope } from './repair-scope.mjs';
export { QUALITY_KINDS, TERMINAL, TRANSITIONS } from './gates/policy.mjs';
export { openHighFindings, validateFindings, REVIEW_SCORE_MIN_OVERALL, REVIEW_SCORE_MIN_CODE, reviewScoresSatisfied, boundReviewScoresSatisfied, parseBoundPostMergeReview } from './gates/findings.mjs';
export { findingPriority, deriveRepairObjective, findingsFingerprint, closedLoopTaskId, closedLoopReviewTaskId, closedLoopRepairTaskId, closedLoopVerificationTaskId, closedLoopKnownRepairTaskId } from './gates/identity.mjs';
export { transitionError, acceptanceCovered, commandsCovered, validateCompletion, evidenceBackedCompletion } from './gates/completion.mjs';
export { planCompletionReview } from './gates/completion-review.mjs';
export { planCompletionFanOut } from './gates/completion-fanout.mjs';
export { planFailedReviewFollowUp } from './gates/review-repair.mjs';
export { planFollowUp } from './gates/follow-up.mjs';
export { deliveryAudit } from './gates/delivery-audit.mjs';
