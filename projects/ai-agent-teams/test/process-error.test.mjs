import test from 'node:test';
import assert from 'node:assert/strict';
import { providerErrorDetailsFromProcess } from '../src/session/cli.mjs';
import { ContainerCliSessionAdapter } from '../src/session/container-cli.mjs';

const json = (message) => JSON.stringify({ error: { message, code: 'rate_limit_exceeded', retryAfterMs: 45000 } });
for (const [name, stdout, stderr, message] of [
  ['stdout JSON wins', json('stdout json'), json('stderr json'), 'stdout json'],
  ['stderr JSON beats stdout text', 'Error: stdout text', json('stderr json'), 'stderr json'],
  ['stderr text beats stdout text', 'Error: stdout text', 'Error: stderr text', 'stderr text'],
  ['stdout text fallback', 'Error: stdout text', '', 'stdout text'],
]) {
  test(`process provider error precedence: ${name}`, () => {
    const error = Object.assign(new Error('process failed'), { stdout, stderr });
    assert.equal(providerErrorDetailsFromProcess(error).message, message);
    assert.equal(error.message, 'process failed');
  });
}

test('missing process output has no provider details', () => {
  assert.equal(providerErrorDetailsFromProcess(undefined), undefined);
  assert.equal(providerErrorDetailsFromProcess({ stdout: '', stderr: '' }), undefined);
});

for (const parseProviderError of [true, false]) {
  test(`container runTurn retains error identity and cleanup order (parse=${parseProviderError})`, async () => {
    const calls = [];
    const child = {};
    const processes = new Map();
    const error = Object.assign(new Error('process failed'), { stdout: json('provider failed'), stderr: '', exitCode: 7 });
    const context = {
      runtimeCommand: 'unused', timeoutMs: 1000, processes,
      runner: async ({ onProcess }) => { onProcess(child); throw error; },
      cleanupContainer(name) { calls.push(name); assert.equal(processes.get('turn'), child); },
    };
    await assert.rejects(ContainerCliSessionAdapter.prototype.runTurn.call(context, {
      name: 'container-1', args: [], processKey: 'turn', env: {}, parseProviderError, keepRetryHint: true,
    }), (thrown) => {
      assert.equal(thrown, error);
      assert.equal(thrown.exitCode, 7);
      assert.equal(thrown.stdout, json('provider failed'));
      assert.equal(thrown.message, parseProviderError ? 'provider failed' : 'process failed');
      if (parseProviderError) assert.equal(thrown.retryAfterMs, 45000);
      return true;
    });
    assert.deepEqual(calls, ['container-1']);
    assert.equal(processes.has('turn'), false);
  });
}
