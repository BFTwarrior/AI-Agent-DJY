import test from 'node:test';
import assert from 'node:assert/strict';
import { retryAfterMsFrom } from '../src/session/retry-after.mjs';

test('retryAfterMsFrom normalizes common provider hint shapes', () => {
  assert.equal(retryAfterMsFrom({ retryAfterMs: 2500 }), 2500);
  assert.equal(retryAfterMsFrom({ retry_after_ms: '2500' }), 2500);
  assert.equal(retryAfterMsFrom({ retryAfterSeconds: 2.5 }), 2500);
  assert.equal(retryAfterMsFrom({ retry_after_seconds: '2' }), 2000);
  assert.equal(retryAfterMsFrom({ retryAfter: 3 }), 3000);
  assert.equal(retryAfterMsFrom({ retry_after: '3' }), 3000);
});

test('retryAfterMsFrom parses HTTP dates relative to now', () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const hint = retryAfterMsFrom({ retryAfter: future });
  assert.ok(hint >= 3000 && hint <= 7000, `unexpected hint ${hint}`);
  assert.equal(retryAfterMsFrom({ retryAfter: new Date(Date.now() - 5000).toUTCString() }), 0);
});

test('retryAfterMsFrom ignores missing, zero, negative and non-numeric hints', () => {
  for (const error of [
    undefined,
    null,
    {},
    { retryAfterMs: 0 },
    { retryAfterMs: -1 },
    { retryAfterMs: Number.NaN },
    { retryAfterMs: Number.POSITIVE_INFINITY },
    { retryAfterSeconds: 0 },
    { retryAfter: 'not a date' },
    { retryAfter: {} },
  ]) {
    assert.equal(retryAfterMsFrom(error), undefined);
  }
});
