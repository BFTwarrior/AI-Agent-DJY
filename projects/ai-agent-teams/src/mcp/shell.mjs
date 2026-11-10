import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { RuntimeSupervisor } from './shell/runtime-supervisor.mjs';

export { RUNTIME_API_VERSION, DEFAULT_RUNTIME_ENTRY } from './shell/runtime-target.mjs';
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const DEFAULT_PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_POINTER_PATH = join(DEFAULT_PLUGIN_ROOT, 'runtime', 'current.json');

const DEFAULT_HEALTH_TIMEOUT_MS = 15000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5000;
const DEFAULT_KILL_GRACE_MS = 2000;
const DEFAULT_RESTART_DELAY_MS = 250;
const MAX_RESTART_DELAY_MS = 5000;
const DEFAULT_WATCH_INTERVAL_MS = 500;
const DEFAULT_STABLE_AFTER_MS = 5000;
const DEFAULT_MAX_CONSECUTIVE_CRASHES = 3;
const DEFAULT_HOST_REQUEST_TIMEOUT_MS = 60000;

/**
 * Create the stable shell. Exposed for tests; `runShell` wires it to stdio.
 *
 * @param {{
 *   pluginRoot?: string, pointerPath?: string, workspace?: string,
 *   resolveWorkspace?: string | (() => string), watch?: boolean, watchIntervalMs?: number,
 *   healthTimeoutMs?: number, drainTimeoutMs?: number, killGraceMs?: number,
 *   restartDelayMs?: number, maxRestartDelayMs?: number,
 *   stableAfterMs?: number, maxConsecutiveCrashes?: number, hostRequestTimeoutMs?: number,
 *   env?: Record<string, string>,
 *   onNotification?: (message: object) => void, onHostRequest?: (message: object) => void,
 *   onLog?: (message: string) => void,
 * }} [options]
 */
export function createMcpShell(options = {}) {
  const pluginRoot = resolve(options.pluginRoot ?? DEFAULT_PLUGIN_ROOT);
  const pointerPath = resolve(options.pointerPath ?? DEFAULT_POINTER_PATH);
  const watchEnabled = options.watch !== false;
  const watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  const maxRestartDelayMs = options.maxRestartDelayMs ?? MAX_RESTART_DELAY_MS;
  const stableAfterMs = options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS;
  const maxConsecutiveCrashes = Math.max(1, options.maxConsecutiveCrashes ?? DEFAULT_MAX_CONSECUTIVE_CRASHES);
  const hostRequestTimeoutMs = options.hostRequestTimeoutMs ?? DEFAULT_HOST_REQUEST_TIMEOUT_MS;
  const workspaceOption = options.resolveWorkspace ?? options.workspace;
  const runtimeEnv = options.env ?? {};
  const onHostRequest = typeof options.onHostRequest === 'function' ? options.onHostRequest : null;
  const log = options.onLog ?? ((message) => {
    try {
      process.stderr.write(`[agent-teams-shell] ${message}\n`);
    } catch {
      // stderr is best-effort; never fail the MCP loop over a log line.
    }
  });
  const onNotification = options.onNotification ?? ((message) => {
    process.stdout.write(JSON.stringify(message) + '\n');
  });

  const supervisor = new RuntimeSupervisor({
    pluginRoot, pointerPath, workspaceOption, runtimeEnv, drainTimeoutMs,
    killGraceMs, restartDelayMs, maxRestartDelayMs, stableAfterMs, maxConsecutiveCrashes,
  }, {
    onHostRequest, onNotification, log, healthTimeoutMs, hostRequestTimeoutMs,
    packageVersion: PACKAGE_VERSION,
  }, { watchEnabled, watchIntervalMs });
  supervisor.watcher.startWatching();
  // Keep the public functions detached-call safe, as the original closure was.
  return {
    pluginRoot: supervisor.pluginRoot,
    pointerPath: supervisor.pointerPath,
    handleMessage: supervisor.handleMessage.bind(supervisor),
    reload: supervisor.reload.bind(supervisor),
    whenIdle: supervisor.whenIdle.bind(supervisor),
    close: supervisor.close.bind(supervisor),
    status: supervisor.status.bind(supervisor),
    resolveWorkspace: supervisor.resolveWorkspacePath.bind(supervisor),
  };
}

/** Wire the stable shell to process stdio. */
export async function runShell(options = {}) {
  const shell = createMcpShell({
    ...options,
    // Host-directed output is written exactly like a response; the shell keeps
    // the runtime -> host request id mapping so the host's answer can be
    // routed back to the runtime that asked.
    onHostRequest: options.onHostRequest ?? ((message) => {
      process.stdout.write(JSON.stringify(message) + '\n');
    }),
  });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let stopping = false;

  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    try {
      rl.close();
    } catch {
      // Already closed.
    }
    await shell.close().catch(() => {});
    process.exit(code);
  }

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    void shell.handleMessage(message).then((response) => {
      if (response !== null && response !== undefined) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    });
  });
  rl.on('close', () => {
    void shutdown(0);
  });
  process.once('SIGINT', () => {
    void shutdown(0);
  });
  process.once('SIGTERM', () => {
    void shutdown(0);
  });
  return shell;
}
