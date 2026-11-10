import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fail, lstatOrNull } from './support.mjs';

const DEFAULT_HEALTH_TIMEOUT_MS = 15000;
const STDERR_TAIL_BYTES = 4096;
const AGENT_TEAMS_ENV_PREFIX = 'AGENT_TEAMS_';
// A health probe must not inherit the host's build caches. A cache path from
// the shell that runs the installer would otherwise send the probe's writes
// (or a compiler's output) into a shared directory the caller never chose, and
// the probe would report success against a different tree than the one the
// daemon will later use. Names are compared case-insensitively.
const HEALTH_ENV_EXCLUDED_NAMES = new Set([
  'npm_config_cache',
  'npm_config_prefix',
  'npm_config_userconfig',
  'npm_config_globalconfig',
  'npm_config_tmp',
  'cargo_target_dir',
  'cargo_home',
  'gocache',
  'gomodcache',
  'pip_cache_dir',
  'uv_cache_dir',
  'gradle_user_home',
  'xdg_cache_home',
]);

function healthFailure(message, extra = {}) {
  return { ok: false, tools: null, error: message, ...extra };
}

// A health probe must not inherit the host's team credentials, and it must not
// inherit the host's build caches either: a cache path chosen for a build shell
// would send the probe's writes somewhere the installer never inspected. Every
// `AGENT_TEAMS_*` variable is dropped; only variables the caller passes
// explicitly survive, and those names are reported back so an install can
// record them. `AGENT_TEAMS_AUTOSTART=0` is not an overridable default: a probe
// that is allowed to start the daemon runs the code it is supposed to check.
function buildHealthEnvironment(explicitEnv) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Windows environment names are case-insensitive, so `agent_teams_url` is
    // the same variable as `AGENT_TEAMS_URL` and must be dropped as well.
    if (key.toUpperCase().startsWith(AGENT_TEAMS_ENV_PREFIX)) continue;
    if (HEALTH_ENV_EXCLUDED_NAMES.has(key.toLowerCase())) continue;
    env[key] = value;
  }
  env.AGENT_TEAMS_AUTOSTART = '0';
  const overrides = new Set();
  const ignored = new Set();
  for (const [key, value] of Object.entries(explicitEnv ?? {})) {
    if (value === undefined) continue;
    const name = key.toUpperCase();
    if (name === 'AGENT_TEAMS_AUTOSTART' && String(value) !== '0') {
      // Reported, never applied: see the note above.
      ignored.add(name);
      continue;
    }
    if (name.startsWith(AGENT_TEAMS_ENV_PREFIX)) {
      // Normalized so a lowercase spelling cannot create a second variable next
      // to the forced AGENT_TEAMS_AUTOSTART on Windows.
      env[name] = String(value);
      overrides.add(name);
      continue;
    }
    env[key] = String(value);
  }
  return { env, overrides: [...overrides].sort(), ignored: [...ignored].sort() };
}

/**
 * Warn about explicit overrides the probe refused to apply, so an install
 * cannot look as if it honoured a request that would have started a daemon.
 *
 * @param {{ ignoredEnvOverrides?: string[] }} health
 * @returns {string[]}
 */
export function describeIgnoredOverrides(health) {
  return (health?.ignoredEnvOverrides ?? []).map(
    (key) => `health check ignored an explicit non-zero ${key}; autostart stays disabled for a probe`,
  );
}

/**
 * Spawn a runtime entry and prove it answers `initialize` and `tools/list`.
 * Autostart is disabled for the probe so a health check never starts a daemon
 * as a side effect; the caller can override any environment variable.
 *
 * @param {{ entry?: string, cwd?: string, env?: Record<string, string>, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, tools: number | null, error: string | null, durationMs: number, stderrTail?: string }>}
 */
export async function runHealthCheck(options = {}) {
  const startedAt = Date.now();
  const { env, overrides, ignored } = buildHealthEnvironment(options.env);
  if (typeof options.entry !== 'string' || !options.entry.trim()) {
    return healthFailure('health check requires a runtime entry path', {
      durationMs: 0,
      envOverrides: overrides,
      ignoredEnvOverrides: ignored,
    });
  }
  const entryPath = resolve(options.entry);
  const stat = await lstatOrNull(entryPath);
  if (!stat || !stat.isFile()) {
    return healthFailure(`runtime entry does not exist: ${entryPath}`, {
      durationMs: Date.now() - startedAt,
      envOverrides: overrides,
      ignoredEnvOverrides: ignored,
    });
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_HEALTH_TIMEOUT_MS;
  return new Promise((resolvePromise) => {
    let settled = false;
    let stderrTail = '';
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { reader?.close(); } catch { /* already closed */ }
      try { child?.stdin?.end(); } catch { /* stdin may be gone */ }
      try { child?.kill(); } catch { /* the child may already have exited */ }
      resolvePromise({
        ok: result.ok === true,
        tools: result.tools ?? null,
        error: result.ok === true ? null : (result.error ?? 'health check failed'),
        durationMs: Date.now() - startedAt,
        envOverrides: overrides,
        ignoredEnvOverrides: ignored,
        ...(stderrTail ? { stderrTail } : {}),
      });
    };
    let reader = null;
    try {
      child = spawn(process.execPath, [entryPath], {
        cwd: options.cwd ?? process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise(healthFailure(`failed to spawn ${entryPath}: ${error.message}`, {
        durationMs: Date.now() - startedAt,
        envOverrides: overrides,
        ignoredEnvOverrides: ignored,
      }));
      return;
    }
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch {
        return false;
      }
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: `runtime did not complete initialize + tools/list within ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => finish({ ok: false, error: `failed to run ${entryPath}: ${error.message}` }));
    child.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_BYTES);
    });
    reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (typeof message.method === 'string' && message.id !== undefined) {
        // The probe cannot answer server-to-client requests; reply with a
        // deterministic error instead of letting the runtime hang.
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'hot-update health probe does not serve host requests' } });
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          finish({ ok: false, error: `initialize failed: ${message.error.message ?? 'unknown error'}` });
          return;
        }
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        return;
      }
      if (message.id === 2) {
        if (message.error) {
          finish({ ok: false, error: `tools/list failed: ${message.error.message ?? 'unknown error'}` });
          return;
        }
        const tools = message.result?.tools;
        if (!Array.isArray(tools)) {
          finish({ ok: false, error: 'tools/list did not return a tools array' });
          return;
        }
        finish({ ok: true, tools: tools.length });
      }
    });
    // `close` (unlike `exit`) fires after stdio has been flushed, so a runtime
    // that dies early still leaves its stderr tail in the error report.
    child.on('close', (code, signal) => {
      finish({ ok: false, error: `runtime exited before completing the health check (code=${code ?? 'unknown'}, signal=${signal ?? 'none'})` });
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ai-agent-teams-hot-update', version: '1' },
      },
    });
  });
}

/**
 * Run the configured health check (or the real probe) and turn a failure into
 * a stable `HOT_UPDATE_HEALTH_FAILED` error before the pointer can move.
 *
 * @param {string} entryPath
 * @param {{ healthCheck?: Function, cwd?: string, env?: Record<string, string>, timeoutMs?: number }} options
 * @param {string} label
 */
export async function assertHealth(entryPath, options, label) {
  const health = options.healthCheck
    ? await options.healthCheck({ entry: entryPath, label })
    : await runHealthCheck({ entry: entryPath, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
  if (!health || health.ok !== true) {
    fail('HOT_UPDATE_HEALTH_FAILED', `${label} failed its health check: ${health?.error ?? 'unknown error'}`, { health });
  }
  return health;
}
