#!/usr/bin/env node
/**
 * Real app-server lifecycle check: create -> prompt -> compact -> close -> resume -> prompt.
 * The wrapper exists because `zcode -p` has no `--model`; model selection goes
 * through Protocol session/setModel instead.
 *
 * Usage:
 *   npm run zcode:lifecycle -- --model provider-b/model-x --reasoning max
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { ProtocolSessionAdapter } from '../src/session/protocol.mjs';

const parsed = parseArgs({
  allowPositionals: false,
  options: {
    model: { type: 'string' },
    reasoning: { type: 'string' },
    cwd: { type: 'string' },
    timeout: { type: 'string' },
  },
});
const model = parsed.values.model ?? process.env.PROBE_MODEL ?? 'provider-b/model-x';
const reasoning = parsed.values.reasoning ?? 'max';
const cwd = resolve(parsed.values.cwd ?? process.cwd());
const timeoutMs = Number(parsed.values.timeout ?? 120000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('ERROR: --timeout must be positive');
  process.exit(2);
}
const adapter = new ProtocolSessionAdapter({ cwd, mode: 'plan' });
let sessionId;
try {
  const created = await adapter.create({
    teamId: 'probe', memberName: 'probe', cwd, prompt: '',
    model, reasoning, mode: 'plan',
  });
  sessionId = created.sessionId;
  console.log('created', sessionId);
  const beforeFirst = await adapter.turnCursor({ sessionId });
  const first = await adapter.send({
    sessionId, message: 'Reply with exactly OK and nothing else.',
    wait: true, timeoutMs,
  });
  console.log('first', JSON.stringify({ ok: first.ok, response: first.response }));
  const firstDone = await adapter.waitForSessionEvent({
    sessionId,
    afterSeq: beforeFirst,
    types: ['turn.completed', 'turn.failed'],
    timeoutMs,
  });
  console.log('firstDone', firstDone.type);
  const compact = await adapter.compact({
    sessionId,
    instructions: 'Summarize this short conversation in one sentence.',
    wait: true,
    timeoutMs,
  });
  console.log('compact', JSON.stringify({
    ok: compact.ok,
    state: compact.state,
    warning: compact.warning,
    eventType: compact.event?.type,
  }));
  await adapter.close({ sessionId });
  console.log('closed');
  const resumed = await adapter.resume({ sessionId, cwd });
  console.log('resumed', JSON.stringify(resumed));
  const second = await adapter.send({
    sessionId: resumed.sessionId,
    message: 'Reply with exactly RESUMED and nothing else.',
    wait: true, timeoutMs,
  });
  console.log('second', JSON.stringify({ ok: second.ok, response: second.response, warning: second.warning }));
} catch (error) {
  console.error('PROBE_ERROR', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try { await adapter.close({ sessionId }); } catch { /* best effort */ }
  }
  await adapter.shutdown();
}
