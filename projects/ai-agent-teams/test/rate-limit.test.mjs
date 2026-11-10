import test from 'node:test';
import assert from 'node:assert/strict';
import { IntervalRateLimiter } from '../src/domain/rate-limit.mjs';

test('interval limiter spaces request starts', async () => {
  let clock = 0;
  const slept = [];
  const limiter = new IntervalRateLimiter({
    requestsPerMinute: 2,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();
  assert.deepEqual(slept, [30000, 30000]);
  assert.equal(clock, 60000);
});

test('interval limiter is disabled when requestsPerMinute is zero', async () => {
  let slept = 0;
  const limiter = new IntervalRateLimiter({
    requestsPerMinute: 0,
    sleep: async () => { slept += 1; },
  });
  await limiter.acquire();
  assert.equal(slept, 0);
});
