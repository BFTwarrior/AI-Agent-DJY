import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPublicationEffect } from '../src/domain/publication-intent.mjs';

const intent = {
  deliveryOperationId: 'delivery-1',
  rootId: 'root-1',
  mergeTargetId: 'target-1',
  taskEpoch: 2,
  controlEpoch: 3,
  deliveryGeneration: 4,
  targetRef: 'refs/heads/main',
  expectedOldHead: 'head-old',
  appliedCommit: 'commit-new',
  artifactDigest: 'sha256:artifact',
};

const record = (phase, extra = {}) => ({ ...intent, phase, ...extra });

test('missing frozen identity fields produce unknown', () => {
  const incomplete = { ...intent };
  delete incomplete.artifactDigest;
  assert.equal(classifyPublicationEffect({
    intent: incomplete,
    staged: record('staged', { publicationStarted: false }),
    targetHead: intent.expectedOldHead,
  }), 'unknown');
});

test('matching staged intent with publication not started and unchanged target is not published', () => {
  assert.equal(classifyPublicationEffect({
    intent,
    staged: record('staged', { publicationStarted: false }),
    targetHead: intent.expectedOldHead,
    appliedInTarget: false,
    appliedInExpectedOld: false,
  }), 'not_published');
});

test('prepared positive intent with commit in target is published and present', () => {
  assert.equal(classifyPublicationEffect({
    intent,
    positive: record('prepared'),
    targetHead: 'head-after',
    appliedInTarget: true,
    appliedInExpectedOld: false,
  }), 'published_present');
});

test('settled positive intent with commit absent from target is published and removed', () => {
  assert.equal(classifyPublicationEffect({
    intent,
    positive: record('settled'),
    targetHead: 'head-after-removal',
    appliedInTarget: false,
    appliedInExpectedOld: false,
  }), 'published_removed');
});

test('commit already contained in expected old HEAD makes the result unknown', () => {
  assert.equal(classifyPublicationEffect({
    intent,
    positive: record('prepared'),
    targetHead: intent.expectedOldHead,
    appliedInTarget: true,
    appliedInExpectedOld: true,
  }), 'unknown');
});

test('identity mismatch cannot prove publication state', () => {
  assert.equal(classifyPublicationEffect({
    intent,
    positive: record('prepared', { deliveryOperationId: 'another-delivery' }),
    targetHead: 'head-after',
    appliedInTarget: true,
  }), 'unknown');
});

test('missing or null ancestry evidence and identity never prove an outcome', () => {
  const base = { intent, staged: record('staged', { publicationStarted: false }), targetHead: intent.expectedOldHead,
    appliedInTarget: false, appliedInExpectedOld: false };
  for (const field of ['appliedInTarget', 'appliedInExpectedOld']) {
    assert.equal(classifyPublicationEffect({ ...base, [field]: undefined }), 'unknown');
    assert.equal(classifyPublicationEffect({ ...base, [field]: null }), 'unknown');
  }
  for (const field of Object.keys(intent)) {
    assert.equal(classifyPublicationEffect({ ...base, intent: { ...intent, [field]: null } }), 'unknown');
  }
});
