import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { formatHostPort, isLoopbackHost, selectBridgeTarget, startLoopbackBridge, stripHostBrackets } from '../src/runtime/loopback-bridge.mjs';

function echoServer() {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function send(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let received = '';
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => { received += chunk.toString(); });
    socket.on('end', () => resolve(received));
    socket.on('error', reject);
    setTimeout(() => { socket.end(); }, 50);
  });
}

test('bridge route accepts local aliases, rejects remote/LAN fallbacks, and keeps explicit hosts', () => {
  assert.deepEqual(
    selectBridgeTarget({ strictDetected: '192.0.2.10' }),
    { start: true, listenHost: '192.0.2.10' },
  );
  assert.equal(selectBridgeTarget({ strictDetected: '192.0.2.10', containerUrl: 'http://127.0.0.1:8779' }).start, true);
  assert.equal(selectBridgeTarget({ strictDetected: '192.0.2.10', containerUrl: 'http://host.docker.internal:8779' }).start, true);
  assert.equal(selectBridgeTarget({ strictDetected: '192.0.2.10', containerUrl: 'http://host.containers.internal:8779' }).start, true);
  assert.equal(selectBridgeTarget({ strictDetected: '192.0.2.10', containerUrl: 'http://192.168.1.102:8779' }).start, false);
  assert.equal(selectBridgeTarget({ containerUrl: 'http://192.168.1.102:8779' }).start, false);
  assert.equal(selectBridgeTarget({ explicitHost: '192.168.1.10' }).start, true);
  assert.deepEqual(
    selectBridgeTarget({ explicitHost: '[fd00::1]', containerUrl: 'http://[fd00::1]:8797' }),
    { start: true, listenHost: 'fd00::1' },
  );
  assert.equal(selectBridgeTarget({ strictDetected: '192.0.2.10', containerUrl: 'not a url' }).start, true);
});

test('loopback bridge forwards bytes and rejects unsafe targets', async () => {
  assert.equal(stripHostBrackets('[::1]'), '::1');
  assert.equal(stripHostBrackets('127.0.0.1'), '127.0.0.1');
  assert.equal(formatHostPort('::1', 8787), '[::1]:8787');
  assert.equal(formatHostPort('127.0.0.1', 8787), '127.0.0.1:8787');
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('192.0.2.1'), false);
  const target = await echoServer();
  try {
    const bridge = await startLoopbackBridge({
      listenHost: '127.0.0.1',
      targetPort: target.address().port,
    });
    try {
      assert.equal(await send(bridge.port, 'ping'), 'ping');
    } finally {
      await bridge.close();
    }
    await assert.rejects(
      startLoopbackBridge({ listenHost: '127.0.0.1', targetHost: '192.0.2.1', targetPort: 80 }),
      /target must be loopback/,
    );
    await assert.rejects(
      startLoopbackBridge({ listenHost: '0.0.0.0', targetPort: target.address().port }),
      /specific container-reachable interface/,
    );

    const held = await startLoopbackBridge({ listenHost: '127.0.0.1', targetPort: target.address().port });
    const client = connect({ host: '127.0.0.1', port: held.port });
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    const started = Date.now();
    await held.close();
    assert.ok(Date.now() - started < 1500, 'closing a bridge with an active connection must not hang');
    client.destroy();
  } finally {
    await new Promise((resolve) => target.close(resolve));
  }
});
