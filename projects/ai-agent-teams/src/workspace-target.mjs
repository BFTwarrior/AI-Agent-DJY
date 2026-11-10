import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  discoveryBaseDir, discoveryPathForWorkspace, readDiscovery, readDiscoveryForWorkspace,
} from './discovery.mjs';
import { sameWorkspace } from './domain/workspace.mjs';

export const ACTIVE_WORKSPACE_FILE = 'active-workspace.json';

/**
 * A workspace is "known" when the daemon/installer left its state directory,
 * or when config/local.json is actually this control plane's config. An
 * unrelated tool's config/local.json must not block daemon fallback.
 */
export function hasTeamConfig(workspace) {
  if (!workspace) return false;
  if (existsSync(join(workspace, '.ai-agent-teams'))) return true;
  const configPath = join(workspace, 'config', 'local.json');
  if (!existsSync(configPath)) return false;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    // Require the config shape this control plane validates: version, a
    // captain/schema marker, and 1-2 teams with the required lead and member
    // bounds. A different tool that happens to have a `teams` array (even with
    // `id`/`name`) must not look like a team project.
    return Number.isInteger(config?.version)
      && typeof config?.$schema === 'string'
      && /(^|\/)schema\.json$/u.test(config.$schema)
      && Array.isArray(config.teams)
      && config.teams.length >= 1
      && config.teams.length <= 2
      && config.teams.every((team) => team
        && typeof team.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/u.test(team.id)
        && typeof team.name === 'string' && team.name.trim().length > 0
        && typeof team.lead === 'string' && team.lead.trim().length > 0
        && Number.isInteger(team.maxMembers) && team.maxMembers >= 1 && team.maxMembers <= 32);
  } catch {
    return false;
  }
}

export function activeWorkspacePath(baseDir = discoveryBaseDir()) {
  return join(baseDir, ACTIVE_WORKSPACE_FILE);
}

/**
 * The saved target is only a hint: a deleted/moved workspace is ignored.
 * @param {string} [path]
 * @returns {string|undefined}
 */
export function readActiveWorkspace(path = activeWorkspacePath()) {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const workspace = typeof value?.workspace === 'string' ? resolve(value.workspace) : undefined;
    if (!workspace || !existsSync(workspace)) return undefined;
    return workspace;
  } catch {
    return undefined;
  }
}

export function writeActiveWorkspace(workspace, path = activeWorkspacePath()) {
  const target = resolve(workspace);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ workspace: target, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  try {
    renameSync(temp, path);
  } catch {
    // Windows can refuse replace-on-rename.
    rmSync(path, { force: true });
    renameSync(temp, path);
  }
  return target;
}

export function clearActiveWorkspace(path = activeWorkspacePath()) {
  try { rmSync(path, { force: true }); } catch { /* best effort */ }
  return !existsSync(path);
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM';
  }
}

/**
 * A discovery record whose process is gone must not make a folder look like a
 * live team workspace; otherwise a stale record blocks daemon fallback.
 * @param {string} workspace
 */
export function readLiveDiscoveryForWorkspace(workspace) {
  const target = resolve(workspace);
  const candidates = [
    readDiscovery(discoveryPathForWorkspace(target)),
    readDiscovery(),
  ];
  for (const discovery of candidates) {
    if (!discovery || !sameWorkspace(discovery.workspace, target)) continue;
    if (processAlive(discovery.pid)) return discovery;
  }
  return undefined;
}

function discoveryEntries(baseDir) {
  const entries = [];
  const legacy = readDiscovery(join(baseDir, 'runtime.json'));
  if (legacy) entries.push({ ...legacy, discoveryPath: join(baseDir, 'runtime.json'), legacy: true, mtime: 0 });
  const workspacesDir = join(baseDir, 'workspaces');
  if (existsSync(workspacesDir)) {
    let names = [];
    try { names = readdirSync(workspacesDir); } catch { /* unreadable directory: no entries */ }
    for (const name of names) {
      const path = join(workspacesDir, name, 'runtime.json');
      const discovery = readDiscovery(path);
      if (!discovery) continue;
      let mtime = 0;
      try { mtime = statSync(path).mtimeMs; } catch { /* raced with removal */ }
      entries.push({ ...discovery, discoveryPath: path, legacy: false, mtime });
    }
  }
  return entries;
}

function canonicalWorkspace(workspace) {
  const path = resolve(workspace);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function stableKey(item) {
  return `${item.port}:${canonicalWorkspace(item.workspace)}`;
}

/**
 * Every workspace that currently has a daemon discovery record, newest first.
 * The legacy mirror can duplicate a per-workspace file; keep the per-workspace one.
 * @param {{ baseDir?: string, alive?: boolean }} [options]
 * @returns {Array<any>}
 */
export function listDiscoveries({ baseDir = discoveryBaseDir(), alive = false } = {}) {
  const byKey = new Map();
  for (const item of discoveryEntries(baseDir)) {
    if (alive && !processAlive(item.pid)) continue;
    const key = stableKey(item);
    const current = byKey.get(key);
    if (!current || (current.legacy && !item.legacy)) byKey.set(key, item);
  }
  return [...byKey.values()].sort((left, right) => {
    const timeDelta = Number(right.startedAt ?? 0) - Number(left.startedAt ?? 0);
    return timeDelta !== 0 ? timeDelta : Number(right.mtime ?? 0) - Number(left.mtime ?? 0);
  });
}

/**
 * @param {{ explicit?: string, envValue?: string, startupWorkspace?: string, active?: string|undefined, statePath?: string, discoveries?: Array<any> }} [input]
 * @returns {{ workspace: string, source: 'explicit'|'env'|'active'|'session'|'saved'|'recent-daemon'|'startup', fallback: boolean }}
 *
 * Precedence is deliberate: an explicit tool argument wins, then the MCP
 * process' `use` choice, then a session workspace that owns a daemon/config.
 * The saved file and the newest daemon only rescue sessions (such as ZCode's
 * default workspace) that have no team setup of their own.
 */
export function resolveWorkspaceTarget({
  explicit,
  envValue,
  startupWorkspace,
  active,
  statePath = activeWorkspacePath(),
  discoveries = listDiscoveries({ alive: true }),
} = {}) {
  if (explicit) return { workspace: resolve(explicit), source: 'explicit', fallback: false };
  if (active) return { workspace: resolve(active), source: 'active', fallback: false };
  if (envValue) return { workspace: resolve(envValue), source: 'env', fallback: false };
  const startup = startupWorkspace ? resolve(startupWorkspace) : resolve(process.cwd());
  const startupKnown = hasTeamConfig(startup)
    || discoveries.some((item) => sameWorkspace(item.workspace, startup))
    || Boolean(readLiveDiscoveryForWorkspace(startup));
  if (startupKnown) return { workspace: startup, source: 'session', fallback: false };
  const saved = readActiveWorkspace(statePath);
  if (saved && (hasTeamConfig(saved) || discoveries.some((item) => sameWorkspace(item.workspace, saved)))) {
    return { workspace: saved, source: 'saved', fallback: true };
  }
  if (discoveries.length > 0) {
    return { workspace: resolve(discoveries[0].workspace), source: 'recent-daemon', fallback: true };
  }
  return { workspace: startup, source: 'startup', fallback: false };
}

/**
 * Describe a workspace without requiring its daemon to be reachable.
 * @param {string} workspace
 * @param {{ discoveries?: Array<any>, current?: string }} [options]
 */
export function workspaceSummary(workspace, { discoveries = listDiscoveries(), current } = {}) {
  const target = resolve(workspace);
  // Prefer a live record (including a live legacy mirror) so `current/list`
  // do not report a dead port while calls would actually use the live one.
  const discovery = readLiveDiscoveryForWorkspace(target)
    ?? discoveries.find((item) => sameWorkspace(item.workspace, target) && processAlive(item.pid))
    ?? readDiscoveryForWorkspace(target)
    ?? discoveries.find((item) => sameWorkspace(item.workspace, target));
  return {
    workspace: target,
    hasTeamConfig: hasTeamConfig(target),
    current: current ? sameWorkspace(current, target) : undefined,
    ...(discovery ? {
      daemon: {
        port: discovery.port,
        pid: discovery.pid,
        version: discovery.version,
        startedAt: discovery.startedAt,
        alive: processAlive(discovery.pid),
        discoveryPath: discovery.discoveryPath ?? discoveryPathForWorkspace(target),
      },
    } : {}),
  };
}
