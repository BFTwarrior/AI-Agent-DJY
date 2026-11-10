import { acceptanceCovered, commandsCovered, parseBoundPostMergeReview } from '../domain/gates.mjs';
import { parseContractorVerdict } from '../domain/lifecycle.mjs';

export function isBoundMergeReview(task) {
  return task.mode === 'bound' || (task.mode !== 'legacy' && Boolean(task.sourceCommit));
}

export function parseMergeReviewResult(task, result, boundDelivery = isBoundMergeReview(task)) {
  let parsed = boundDelivery ? parseBoundPostMergeReview(result, { codeTask: task.kind !== 'work' })
    : parseContractorVerdict(result);
  if (boundDelivery && parsed?.verdict === 'pass'
    && (!acceptanceCovered(task.acceptance ?? [], parsed.acceptanceResults)
      || !commandsCovered(task.verify ?? [], parsed.commandsRun))) parsed = undefined;
  return parsed;
}
