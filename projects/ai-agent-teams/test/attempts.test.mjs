import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAttempt,
  beginAttempt,
  closeAttempt,
  invalidateAttempt,
  isLeaseExpired,
  parkAttempt,
  stallAttempt,
} from '../src/domain/attempts.mjs';

const base = { id: 't1', teamId: 'alpha', subject: 't1', status: 'pending', dependencies: [], output: 'old' };

test('beginAttempt creates a capability and clears old results', () => {
  const task = beginAttempt(base, 'alice', { now: 1000, leaseMs: 5000 });
  assert.equal(task.status, 'claimed');
  assert.equal(task.attempt, 1);
  assert.match(task.attemptId, /^[0-9a-f-]{36}$/);
  assert.equal(task.leaseExpiresAt, 6000);
  assert.equal(task.output, undefined);
});

test('stale attempt is rejected after invalidation', () => {
  const started = beginAttempt(base, 'alice', { now: 1000 });
  const revoked = invalidateAttempt(started, { assignee: 'bob', now: 2000 });
  assert.equal(revoked.status, 'pending');
  assert.equal(revoked.reassigning, true);
  assert.equal(revoked.attemptId, undefined);
  assert.equal(revoked.handoffFromMemberId, 'alice');
  assert.throws(() => assertAttempt(revoked, started.attemptId), /stale attempt/);
});

test('parked attempt keeps its capability and lease can expire', () => {
  const started = beginAttempt(base, 'alice', { now: 1000, leaseMs: 100 });
  const parked = parkAttempt(started, { now: 1050 });
  assert.equal(parked.parked, true);
  assert.equal(parked.attemptId, started.attemptId);
  assert.equal(isLeaseExpired(parked, 1101), true);
  assert.equal(stallAttempt(parked, 1101).stalled, true);
});

test('terminal results are immutable', () => {
  const started = beginAttempt(base, 'alice', { now: 1000 });
  const completed = closeAttempt(started, 'completed', { output: 'done' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.leaseExpiresAt, undefined);
  assert.throws(() => closeAttempt(completed, 'failed'), /already terminal/);
});
