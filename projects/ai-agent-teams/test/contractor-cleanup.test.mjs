import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupContractorSession } from '../src/service/contractor-cleanup.mjs';
import { CliSessionAdapter } from '../src/session/cli.mjs';
import { ContainerCliSessionAdapter } from '../src/session/container-cli.mjs';
import { ProtocolSessionAdapter } from '../src/session/protocol.mjs';

for (const [name, stopError, closeError, expected] of [
  ['successful cleanup', undefined, undefined, undefined],
  ['stop failure still closes', new Error('stop failed'), undefined, 'stop failed'],
  ['close failure', undefined, new Error('close failed'), 'close failed'],
  ['first failure wins', new Error('stop failed'), new Error('close failed'), 'stop failed'],
  ['non-Error values', 'stop text', 'close text', 'stop text'],
  ['empty first message remains a failure', new Error(''), new Error('close failed'), 'contractor stop failed'],
]) {
  test(`contractor cleanup: ${name}`, async () => {
    const calls = [];
    const adapter = {
      async stop(input) { calls.push(['stop', input]); if (stopError !== undefined) throw stopError; return { ok: true }; },
      async close(input) { calls.push(['close', input]); if (closeError !== undefined) throw closeError; return { ok: true }; },
      async verifySessionTermination(input) { return { verified: true, sessionId: input.sessionId, sideEffectsRevoked: true }; },
    };
    assert.equal(await cleanupContractorSession(adapter, 'session-1'), expected);
    assert.deepEqual(calls, [['stop', { sessionId: 'session-1' }], ['close', { sessionId: 'session-1' }]]);
  });
}

test('contractor cleanup retains occupancy on returned failure or missing proof', async () => {
  assert.equal(await cleanupContractorSession({ stop: async () => ({ ok: false }) }, 'session-1'), 'contractor stop not confirmed');
  assert.equal(await cleanupContractorSession({ stop: async () => ({ ok: true }), close: async () => ({ ok: true }) }, 'session-1'),
    'contractor termination and side-effect revocation not proven');
});

test('contractor cleanup accepts a production protocol proof only when the server forgot the session', async () => {
  let listed = [];
  const client = {
    async request(method) {
      if (method === 'session/create') return { session: { sessionId: 'sess_proto' } };
      if (method === 'session/list') return { sessions: listed };
      return {};
    },
    pendingForSession() { return 0; },
    async close() {},
  };
  const adapter = new ProtocolSessionAdapter({ client, cwd: 'D:/work' });
  await adapter.create({ teamId: 'alpha', memberName: 'a1', prompt: '' });
  assert.equal(await cleanupContractorSession(adapter, 'sess_proto'), undefined);

  listed = [{ sessionId: 'sess_proto' }];
  await adapter.create({ teamId: 'alpha', memberName: 'a1', prompt: '' });
  assert.equal(
    await cleanupContractorSession(adapter, 'sess_proto'),
    'contractor termination and side-effect revocation not proven',
  );
});

test('CLI termination proof requires a killed tree and no live process or send', async () => {
  const adapter = new CliSessionAdapter({ killTree: () => ({ ok: true, status: 'exited' }) });
  adapter.sessions.set('sess_cli', { sessionId: 'sess_cli' });
  assert.equal((await adapter.verifySessionTermination({ sessionId: 'sess_cli' })).verified, false);

  adapter.processes.set('sess_cli', { pid: 4242, exitCode: null });
  const stopped = await adapter.stop({ sessionId: 'sess_cli' });
  assert.equal(stopped.ok, true);
  assert.equal(adapter.processes.has('sess_cli'), false);
  const proof = await adapter.verifySessionTermination({ sessionId: 'sess_cli' });
  assert.deepEqual(proof, { verified: true, sessionId: 'sess_cli', sideEffectsRevoked: true });

  const closed = await adapter.close({ sessionId: 'sess_cli' });
  assert.equal(closed.ok, true);
  assert.match(closed.warning, /no session or credential revocation/);

  adapter.activeSends.set('sess_cli', 1);
  const blocked = await adapter.verifySessionTermination({ sessionId: 'sess_cli' });
  assert.equal(blocked.verified, false);
  assert.equal(blocked.sideEffectsRevoked, false);
  assert.match(blocked.warning, /in-flight turn/);
  adapter.activeSends.delete('sess_cli');
});

test('CLI termination proof stays false when process-tree termination is unverified', async () => {
  const adapter = new CliSessionAdapter({ killTree: () => ({ ok: false, status: 'unknown', error: 'taskkill denied' }) });
  adapter.sessions.set('sess_cli', { sessionId: 'sess_cli' });
  adapter.processes.set('sess_cli', { pid: 4242, exitCode: null });

  const stopped = await adapter.stop({ sessionId: 'sess_cli' });
  assert.equal(stopped.ok, false);
  assert.equal(adapter.processes.get('sess_cli').pid, 4242);

  const closed = await adapter.close({ sessionId: 'sess_cli' });
  assert.equal(closed.ok, false);
  const proof = await adapter.verifySessionTermination({ sessionId: 'sess_cli' });
  assert.equal(proof.verified, false);
  assert.equal(proof.sideEffectsRevoked, false);
});

test('contractor cleanup releases a CLI slot after a confirmed process-tree kill', async () => {
  const adapter = new CliSessionAdapter({ killTree: () => ({ ok: true, status: 'exited' }) });
  adapter.sessions.set('sess_cli', { sessionId: 'sess_cli' });
  adapter.processes.set('sess_cli', { pid: 4242, exitCode: null });
  assert.equal(await cleanupContractorSession(adapter, 'sess_cli'), undefined);
  // The CLI cannot revoke the resumable session id; it intentionally keeps it.
  assert.equal(adapter.sessions.has('sess_cli'), true);
});

test('container termination proof requires cleanup, no live process and an absent runtime container', async () => {
  const adapter = new ContainerCliSessionAdapter({ runtime: 'docker', image: 'worker:test' });
  adapter.sessions.set('sess_ctr', { sessionId: 'sess_ctr', containerName: 'c1', containerNames: ['c1'] });
  adapter.cleanupContainer = () => ({ ok: true });
  let exists = true;
  adapter.queryContainer = () => ({ ok: true, exists });

  const stopped = await adapter.stop({ sessionId: 'sess_ctr' });
  assert.equal(stopped.ok, true);
  // stop alone is not proof while the session record is still present
  assert.equal((await adapter.verifySessionTermination({ sessionId: 'sess_ctr' })).verified, false);

  const closed = await adapter.close({ sessionId: 'sess_ctr' });
  assert.equal(closed.ok, true);
  assert.equal((await adapter.verifySessionTermination({ sessionId: 'sess_ctr' })).verified, false);

  adapter.processes.set('sess_ctr', { pid: 1 });
  assert.equal((await adapter.verifySessionTermination({ sessionId: 'sess_ctr' })).verified, false);
  adapter.processes.delete('sess_ctr');

  exists = false;
  assert.deepEqual(await adapter.verifySessionTermination({ sessionId: 'sess_ctr' }), {
    verified: true,
    sessionId: 'sess_ctr',
    sideEffectsRevoked: true,
  });

  adapter.queryContainer = () => ({ ok: false, error: 'runtime unavailable' });
  const unknown = await adapter.verifySessionTermination({ sessionId: 'sess_ctr' });
  assert.equal(unknown.verified, false);
  assert.equal(unknown.sideEffectsRevoked, false);
  assert.match(unknown.warning, /query failed/);
});

test('contractor cleanup releases a container slot only when cleanup and runtime absence are proven', async () => {
  const adapter = new ContainerCliSessionAdapter({ runtime: 'docker', image: 'worker:test' });
  const record = () => ({ sessionId: 'sess_ctr', containerName: 'c1', containerNames: ['c1'] });
  adapter.sessions.set('sess_ctr', record());
  adapter.cleanupContainer = () => ({ ok: true });
  let exists = true;
  adapter.queryContainer = () => ({ ok: true, exists });

  assert.equal(
    await cleanupContractorSession(adapter, 'sess_ctr'),
    'contractor termination and side-effect revocation not proven',
  );

  adapter.sessions.set('sess_ctr', record());
  exists = false;
  assert.equal(await cleanupContractorSession(adapter, 'sess_ctr'), undefined);
});

test('contractor cleanup keeps the container slot when removal fails', async () => {
  const adapter = new ContainerCliSessionAdapter({ runtime: 'docker', image: 'worker:test' });
  adapter.sessions.set('sess_ctr', { sessionId: 'sess_ctr', containerName: 'c1', containerNames: ['c1'] });
  adapter.cleanupContainer = () => ({ ok: false, error: 'rm denied' });
  adapter.queryContainer = () => ({ ok: true, exists: false });
  const error = await cleanupContractorSession(adapter, 'sess_ctr');
  assert.match(error, /failed to remove container: c1: rm denied/);
});
