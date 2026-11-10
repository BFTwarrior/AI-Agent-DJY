import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, lstatSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sameWorkspace } from './domain/workspace.mjs';

const DISCOVERY_DIR = '.ai-agent-teams';
const DISCOVERY_FILE = 'runtime.json';

export function discoveryBaseDir() {
  // Tests and isolated installs can point discovery at a scratch directory;
  // production uses the per-user home as before.
  const override = process.env.AGENT_TEAMS_DISCOVERY_BASE;
  return override ? resolve(override) : join(homedir(), DISCOVERY_DIR);
}

export function legacyDiscoveryPath() {
  return join(discoveryBaseDir(), DISCOVERY_FILE);
}

export function workspaceKey(workspace) {
  const path = resolve(workspace);
  const normalized = process.platform === 'win32' ? path.toLowerCase() : path;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Per-workspace discovery keeps two workspaces from overwriting each other's
 * URL/token. The legacy file is still written for older consumers.
 * @param {string} [workspace]
 * @returns {string}
 */
export function discoveryPathForWorkspace(workspace) {
  if (!workspace) return legacyDiscoveryPath();
  return join(discoveryBaseDir(), 'workspaces', workspaceKey(workspace), DISCOVERY_FILE);
}

/**
 * @param {any} value
 * @returns {any|undefined}
 */
export function normalizeDiscovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const port = Number(value.port);
  const pid = Number(value.pid);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  if (typeof value.token !== 'string' || !value.token) return undefined;
  if (typeof value.workspace !== 'string' || !value.workspace) return undefined;
  if (typeof value.version !== 'string' || !value.version) return undefined;
  const normalized = { ...value };
  delete normalized.uiKey;
  return {
    ...normalized,
    port,
    ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    ...(typeof value.uiKey === 'string' && value.uiKey ? { uiKey: value.uiKey } : {}),
  };
}

/**
 * @param {string} [path]
 * @returns {any|undefined}
 */
export function readDiscovery(path = legacyDiscoveryPath()) {
  if (!existsSync(path)) return undefined;
  try {
    return normalizeDiscovery(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Prefer the workspace-specific file, then accept the legacy file only when it
 * belongs to the same workspace.
 * @param {string} [workspace]
 * @returns {any|undefined}
 */
export function readDiscoveryForWorkspace(workspace) {
  if (!workspace) return readDiscovery();
  const specific = readDiscovery(discoveryPathForWorkspace(workspace));
  if (specific && sameWorkspace(specific.workspace, workspace)) return specific;
  const legacy = readDiscovery();
  if (legacy && sameWorkspace(legacy.workspace, workspace)) return legacy;
  return undefined;
}

/**
 * Restrict the bearer-token file to the daemon user. On Windows POSIX modes are
 * ignored, so use the absolute system icacls.exe and break ACL inheritance.
 * @param {string} path
 * @param {{ platform?: string, runner?: Function }} [options]
 * @returns {{ ok: boolean, error?: string }}
 */
export function restrictDiscoveryFile(path, { platform = process.platform, runner = spawnSync } = {}) {
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    return { ok: false, error: `chmod 0600 failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (platform !== 'win32') return { ok: true };
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const icacls = join(systemRoot, 'System32', 'icacls.exe');
  if (!existsSync(icacls)) return { ok: false, error: `icacls not found at ${icacls}` };
  let username;
  try {
    username = userInfo().username;
  } catch (error) {
    return { ok: false, error: `cannot read current user: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = runner(icacls, [path, '/inheritance:r', '/grant:r', `${username}:F`], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    stdio: 'ignore',
  });
  if (result.status !== 0) {
    return { ok: false, error: `icacls failed with status ${result.status}` };
  }
  return { ok: true };
}

function writePrivateFile(path, payload) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* Windows or a filesystem without POSIX modes */ }
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, payload, { mode: 0o600 });
  const restricted = restrictDiscoveryFile(temp);
  if (!restricted.ok) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw new Error(`cannot restrict discovery file permissions: ${restricted.error}`);
  }
  try {
    renameSync(temp, path);
  } catch {
    // Windows can refuse replace-on-rename; the fallback keeps the token
    // private but is non-atomic, so readers simply see the old file or none.
    rmSync(path, { force: true });
    renameSync(temp, path);
  }
  restrictDiscoveryFile(path);
}

/**
 * @param {{ port: number, token: string, version: string, workspace?: string, pid?: number, instanceId?: string, apiVersion?: string, startedAt?: number, uiKey?: string }} input
 * @param {{ path?: string, legacy?: boolean }} [options]
 * @returns {string}
 */
export function writeDiscovery(input, { path, legacy = true } = {}) {
  const payload = {
    port: input.port,
    token: input.token,
    pid: input.pid ?? process.pid,
    version: input.version,
    workspace: input.workspace ? resolve(input.workspace) : undefined,
    instanceId: input.instanceId,
    ...(input.uiKey ? { uiKey: input.uiKey } : {}),
    apiVersion: input.apiVersion ?? 'v1',
    startedAt: input.startedAt ?? Date.now(),
  };
  const target = path ?? discoveryPathForWorkspace(input.workspace);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  writePrivateFile(target, text);
  const legacyPath = legacyDiscoveryPath();
  if (legacy && resolve(target) !== resolve(legacyPath)) writePrivateFile(legacyPath, text);
  return target;
}

/**
 * Remove only a discovery file that still identifies this daemon instance.
 * @param {{ path: string, pid?: number, instanceId?: string }} input
 */
export function removeDiscovery({ path, pid = process.pid, instanceId }) {
  const current = readDiscovery(path);
  if (!current) return false;
  if (current.pid !== pid) return false;
  if (instanceId && current.instanceId !== instanceId) return false;
  rmSync(path, { force: true });
  // The legacy mirror is shared by all workspaces. Remove it only when it
  // still identifies this daemon, otherwise it belongs to a newer instance.
  const legacyPath = legacyDiscoveryPath();
  if (resolve(path) !== resolve(legacyPath)) {
    const legacy = readDiscovery(legacyPath);
    if (legacy && legacy.pid === pid && (!instanceId || legacy.instanceId === instanceId)) {
      try { rmSync(legacyPath, { force: true }); } catch { /* best effort */ }
    }
  }
  return true;
}
export function reclaimDiscoveryDirectories({ baseDir = discoveryBaseDir(), now = Date.now(), ttlMs = 7 * 86400000 } = {}) {
  const report = { removed: [], errors: [] };
  const root = join(baseDir, 'workspaces');
  if (!existsSync(root)) return report;
  let activeKey;
  try {
    const active = JSON.parse(readFileSync(join(baseDir, 'active-workspace.json'), 'utf8'));
    if (typeof active.workspace !== 'string' || !active.workspace) throw new Error('invalid active workspace');
    activeKey = workspaceKey(active.workspace);
  } catch (error) {
    // An unreadable active pointer makes every candidate ambiguous.
    if (error.code !== 'ENOENT') { report.errors.push({ path: baseDir, error: error.message }); return report; }
  }
  if (lstatSync(root).isSymbolicLink()) throw new Error('discovery root is a link');
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f]{16}$/u.test(entry.name) || entry.name === activeKey) continue;
    const dir = join(root, entry.name);
    try {
      if (existsSync(join(dir, 'runtime.json')) || existsSync(join(dir, 'runtime.json.lock'))) continue;
      if (now - lstatSync(dir).mtimeMs <= ttlMs || readdirSync(dir).length > 0) continue;
      // rmdir is atomic and never removes a runtime/lock created after the checks.
      rmdirSync(dir);
      report.removed.push(dir);
    } catch (error) {
      report.errors.push({ path: dir, error: error.message });
    }
  }
  return report;
}

export function appendRotatingLog(path, text, maxBytes = 5 * 1024 * 1024) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).size + Buffer.byteLength(text, 'utf8') > maxBytes) {
    rmSync(`${path}.1`, { force: true });
    renameSync(path, `${path}.1`);
  }
  appendFileSync(path, text, 'utf8');
}
