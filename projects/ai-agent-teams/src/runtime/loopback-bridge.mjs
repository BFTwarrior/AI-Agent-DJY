import { createServer, connect } from 'node:net';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

/**
 * WHATWG URL returns IPv6 hostnames with brackets (`[::1]`), while net.listen
 * expects the address without them. Normalize at both boundaries.
 * @param {string} host
 * @returns {string}
 */
export function stripHostBrackets(host) {
  const value = String(host ?? '').trim();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

/**
 * @param {string} host
 * @returns {string}
 */
export function formatHostPort(host, port) {
  const value = stripHostBrackets(host);
  const rendered = value.includes(':') ? `[${value}]` : value;
  return `${rendered}:${port}`;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(stripHostBrackets(host).toLowerCase());
}

/**
 * Decide whether a host-loopback model provider should be bridged. The only
 * allowed listen sources are an explicit `hostAddress` or a strict WSL/Hyper-V
 * detection; `containerUrl` never supplies the listen address. A loopback or
 * container-host alias in `containerUrl` is local, not a remote runtime.
 * @param {{ explicitHost?: string, strictDetected?: string, containerUrl?: string }} input
 * @returns {{ start: boolean, listenHost?: string, reason?: string }}
 */
export function selectBridgeTarget({ explicitHost, strictDetected, containerUrl } = {}) {
  const listenHost = stripHostBrackets(explicitHost ?? strictDetected ?? '');
  if (!listenHost || isLoopbackHost(listenHost)) {
    return {
      start: false,
      reason: 'local model provider is loopback-only, but no explicit hostAddress or strict WSL/Hyper-V address is available',
    };
  }
  let remoteHost;
  try {
    remoteHost = containerUrl ? stripHostBrackets(new URL(containerUrl).hostname) : undefined;
  } catch {
    remoteHost = undefined;
  }
  if (remoteHost) {
    const normalized = remoteHost.toLowerCase();
    const localAlias = normalized === 'host.docker.internal' || normalized === 'host.containers.internal';
    if (!isLoopbackHost(normalized) && !localAlias && normalized !== listenHost.toLowerCase()) {
      return {
        start: false,
        reason: `configured containerUrl host ${remoteHost} is not the local container host ${listenHost}`,
      };
    }
  }
  return { start: true, listenHost };
}

/**
 * Expose one host-loopback TCP service on a container-reachable interface.
 * This is intentionally a narrow TCP forwarder, not a general proxy: the target
 * must be loopback, and callers choose the listen address (normally the WSL
 * gateway). It lets a container reach a model proxy that only binds 127.0.0.1
 * without rewriting the proxy itself or mounting host networking.
 *
 * @param {{ listenHost: string, listenPort?: number, targetHost?: string, targetPort: number }} input
 * @returns {Promise<{ host: string, port: number, targetHost: string, targetPort: number, close: () => Promise<void> }>}
 */
export function startLoopbackBridge({
  listenHost,
  listenPort = 0,
  targetHost = '127.0.0.1',
  targetPort,
}) {
  return new Promise((resolve, reject) => {
    const host = stripHostBrackets(listenHost);
    const target = stripHostBrackets(targetHost).toLowerCase();
    const port = Number(targetPort);
    if (!host) return reject(new Error('loopback bridge requires listenHost'));
    if (!isLoopbackHost(target)) {
      return reject(new Error(`loopback bridge target must be loopback, got ${targetHost}`));
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return reject(new Error(`loopback bridge requires a valid targetPort, got ${targetPort}`));
    }
    if (WILDCARD_HOSTS.has(host)) {
      return reject(new Error('loopback bridge must bind a specific container-reachable interface, not a wildcard address'));
    }
    const sockets = new Set();
    const server = createServer((client) => {
      const upstream = connect({ host: target, port });
      sockets.add(client);
      sockets.add(upstream);
      const closeBoth = () => {
        sockets.delete(client);
        sockets.delete(upstream);
        client.destroy();
        upstream.destroy();
      };
      client.on('error', closeBoth);
      upstream.on('error', closeBoth);
      client.on('close', closeBoth);
      upstream.on('close', closeBoth);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.once('error', reject);
    server.listen({ host, port: Number(listenPort) || 0 }, () => {
      const address = server.address();
      server.off('error', reject);
      server.on('error', () => {
        // A late runtime error must not become an unhandled EventEmitter error.
        // The listener health check will surface the dead bridge to the daemon.
      });
      server.unref?.();
      resolve({
        host,
        port: address.port,
        targetHost: target,
        targetPort: port,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          const timer = setTimeout(done, 1000);
          timer.unref?.();
          server.close(() => {
            clearTimeout(timer);
            done();
          });
        }),
      });
    });
  });
}
