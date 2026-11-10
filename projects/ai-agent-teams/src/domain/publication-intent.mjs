const IDENTITY_FIELDS = [
  'deliveryOperationId',
  'rootId',
  'mergeTargetId',
  'taskEpoch',
  'controlEpoch',
  'deliveryGeneration',
  'targetRef',
  'expectedOldHead',
  'appliedCommit',
  'artifactDigest',
];

function hasMatchingIdentity(intent, record) {
  return Boolean(record) && IDENTITY_FIELDS.every((field) => (
    intent?.[field] !== undefined && intent[field] !== null && intent[field] !== '' && record[field] === intent[field]
  ));
}

export function classifyPublicationEffect({
  intent,
  staged,
  positive,
  targetHead,
  appliedInTarget,
  appliedInExpectedOld,
}) {
  if (!hasMatchingIdentity(intent, intent)) return 'unknown';
  if (!targetHead || typeof appliedInTarget !== 'boolean' || typeof appliedInExpectedOld !== 'boolean'
    || intent.expectedOldHead === intent.appliedCommit || appliedInExpectedOld) {
    return 'unknown';
  }

  if (positive) {
    if (!hasMatchingIdentity(intent, positive) || !['prepared', 'settled'].includes(positive.phase)) {
      return 'unknown';
    }
    if (appliedInTarget) return 'published_present';
    if (positive.phase === 'settled') return 'published_removed';
    return targetHead === intent.expectedOldHead ? 'not_published' : 'unknown';
  }

  if (!hasMatchingIdentity(intent, staged) || staged.publicationStarted !== false) {
    return 'unknown';
  }
  return targetHead === intent.expectedOldHead && !appliedInTarget
    ? 'not_published'
    : 'unknown';
}
