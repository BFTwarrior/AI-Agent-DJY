import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, listenWithFallback } from '../src/http/server.mjs';

test('daemon port fallback picks a free loopback port when preferred is occupied', async () => {
  const store = { subscribe: () => () => {} };
  const blocker = createApp({ store, service: {}, token: 'blocker' });
  const preferred = await blocker.listen(0);
  const fallback = createApp({ store, service: {}, token: 'fallback' });
  try {
    const actual = await listenWithFallback(fallback, preferred);
    assert.notEqual(actual, preferred);
    assert.ok(actual > 0);
  } finally {
    await fallback.close();
    await blocker.close();
  }
});
