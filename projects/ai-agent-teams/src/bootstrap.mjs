import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoveryPathForWorkspace, readDiscovery, readDiscoveryForWorkspace } from './discovery.mjs';
import { recommendPreset } from './domain/lifecycle.mjs';
import { isGitWorkspace, sameWorkspace } from './domain/workspace.mjs';

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Read from disk on every call instead of caching at import time. A long-lived
// supervisor keeps this module loaded across upgrades, so a cached value can
// describe an older package than the one on disk. After an upgrade, that stale
// version made `healthy` reject the current daemon and the older-version guard
// log the same error on every supervisor interval without stopping the daemon.
export function packageVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function probeHealth(discovery) {
  if (!discovery?.port) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return undefined;
    const body = await response.json();
    const data = body?.data;
    return data && data.status === 'ok' ? data : undefined;
  } catch {
    return undefined;
  }
}

async function authenticatedProbe(discovery) {
  if (!discovery?.port || !discovery?.token) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/api/v1/teams`, {
      headers: { authorization: `Bearer ${discovery.token}` },
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function identityMatches(discovery, health) {
  if (!discovery || !health) return false;
  if (Number(health.pid) !== Number(discovery.pid)) return false;
  if (discovery.instanceId && health.instanceId !== discovery.instanceId) return false;
  if (discovery.workspace && health.workspace && !sameWorkspace(discovery.workspace, health.workspace)) return false;
  return true;
}

// Health means the daemon is alive, answers with the identity and workspace we
// recorded, and its record agrees with what it reports. Version is deliberately
// NOT part of this test: a self-consistent daemon may be running a different
// package from this caller. `ensureDaemon` checks version skew separately before
// deciding whether the identified daemon may be replaced.
export async function healthy(discovery, workspace) {
  if (!discovery?.port || !discovery?.token) return false;
  if (workspace && !sameWorkspace(discovery.workspace, workspace)) return false;
  const health = await probeHealth(discovery);
  return Boolean(health
    && health.version === discovery.version
    && identityMatches(discovery, health)
    && (!workspace || (typeof health.workspace === 'string' && sameWorkspace(health.workspace, workspace))));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function stopStaleDaemon(discovery) {
  const pid = Number(discovery?.pid);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    // already exited or not ours; the new daemon still gets a fresh discovery file
    return false;
  }
}

async function acquireBootstrapLock(lockPath, timeoutMs) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      closeSync(fd);
      return () => {
        try { rmSync(lockPath, { force: true }); } catch { /* best effort */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    let stale = false;
    let ownerRaw;
    try {
      ownerRaw = readFileSync(lockPath, 'utf8');
      const owner = JSON.parse(ownerRaw);
      const pid = Number(owner.pid);
      const age = Date.now() - Number(owner.startedAt);
      stale = !Number.isInteger(pid) || pid <= 1 || !Number.isFinite(age) || age > 120000 || !processAlive(pid);
    } catch {
      stale = true;
    }
    if (stale) {
      if (ownerRaw === undefined) {
        await sleep(100);
        continue;
      }
      try {
        if (readFileSync(lockPath, 'utf8') !== ownerRaw) continue;
      } catch {
        continue;
      }
      rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for another AgentTeams bootstrap');
    await sleep(250);
  }
}

export async function prerequisiteReport() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeMinor = Number(process.versions.node.split('.')[1]);
  const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
  let sqlite = false;
  try {
    await import('node:sqlite');
    sqlite = true;
  } catch {
    sqlite = false;
  }
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  const docker = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  const zcode = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['zcode'], { encoding: 'utf8' });
  const appCli = process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Zcode', 'resources', 'glm', 'zcode.cjs') : '';
  const cliCandidates = [process.env.ZCODE_CLI, appCli].filter(Boolean);
  const knownCli = cliCandidates.find((candidate) => existsSync(candidate));
  const zcodeOk = zcode.status === 0 || knownCli !== undefined;
  const memoryGb = Math.max(1, Math.round(totalmem() / 1024 ** 3));
  return {
    node: { version: process.versions.node, ok: nodeOk },
    sqlite,
    git: { ok: git.status === 0, version: (git.stdout ?? '').trim() },
    docker: { ok: docker.status === 0, version: (docker.stdout ?? '').trim(), optional: true },
    zcodeCli: {
      ok: zcodeOk,
      path: knownCli ?? ((zcode.stdout ?? '').trim().split(/\r?\n/)[0] || undefined),
      optional: true,
    },
    hardware: { memoryGb, logicalCpus: cpus().length, platform: process.platform },
    recommendedPresets: {
      conservative: recommendPreset({ memoryGb, mode: 'conservative', teams: 2 }),
      balanced: recommendPreset({ memoryGb, mode: 'balanced', teams: 2 }),
    },
    zcodeLimits: {
      maxSubagents: null,
      source: 'not exposed by ZCode 0.17.0 runtime/capabilities or config',
    },
  };
}

/**
 * Start the daemon if a healthy one is not already running.
 * The MCP server calls this on startup, so enabling the plugin is enough.
 * @param {{ workspace?: string, configPath?: string, dbPath?: string, timeoutMs?: number }} [options]
 */
export async function ensureDaemon(options = {}) {
  const workspace = resolve(options.workspace ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const workspaceConfig = join(workspace, 'config', 'local.json');
  const configPath = resolve(options.configPath
    ?? process.env.AGENT_TEAMS_CONFIG
    ?? (existsSync(workspaceConfig) ? workspaceConfig : join(PACKAGE_ROOT, 'config', 'example.v06.json')));
  const dbPath = options.dbPath ?? '.ai-agent-teams/state.db';
  const timeoutMs = options.timeoutMs ?? 20000;
  let isolationMode;
  try {
    isolationMode = JSON.parse(readFileSync(configPath, 'utf8')).isolation?.mode;
  } catch {
    isolationMode = undefined;
  }
  if (['worktree', 'soft'].includes(isolationMode) && !isGitWorkspace(workspace)) {
    throw new Error(`workspace ${workspace} is not a git repository but config requests ${isolationMode} isolation; run the install wizard to generate config/local.json or initialize git`);
  }

  const discoveryPath = discoveryPathForWorkspace(workspace);
  let existing = readDiscoveryForWorkspace(workspace);
  // Set when a running daemon of a different version was replaced, so the
  // caller can log the upgrade instead of it looking like a silent restart.
  let replacedVersion;
  // Adopting an existing daemon needs BOTH properties:
  //   - `healthy` — it is alive and agrees with its own discovery record, and
  //   - `usable`  — it runs the version on disk right now.
  // Dropping the version test here would make an upgrade a no-op: a daemon that
  // is self-consistently older would be adopted forever and the replacement
  // branch below could never run. Dropping `healthy` instead is what used to
  // happen, which made a fresh daemon look unhealthy to a caller whose cached
  // version predated it.
  const usable = (discovery) => discovery?.version === packageVersion();
  if (existing && usable(existing) && await healthy(existing, workspace)) {
    return { started: false, discovery: existing, workspace };
  }
  const releaseLock = await acquireBootstrapLock(`${discoveryPath}.lock`, timeoutMs);
  try {
    existing = readDiscoveryForWorkspace(workspace);
    if (existing && usable(existing) && await healthy(existing, workspace)) {
      return { started: false, discovery: existing, workspace };
    }
    if (existing) {
      const health = await probeHealth(existing);
      if (health) {
        // Recheck the discovery workspace and any workspace reported by health
        // before stopping a daemon; a mismatched process must not be terminated.
        const same = sameWorkspace(existing.workspace, workspace)
          && (typeof health.workspace !== 'string' || sameWorkspace(health.workspace, workspace));
        if (!same) {
          throw new Error(`another AgentTeams daemon is running for workspace ${health.workspace ?? existing.workspace}; stop it before starting ${workspace}`);
        }
        // A version mismatch used to throw before the ownership checks below.
        // A long-lived supervisor with a cached package version then logged the
        // same error on every interval and left the daemon running. Version skew
        // is now handled as a stale daemon: only after identity and token checks
        // prove ownership do we stop it and start the current on-disk version.
        const wantedVersion = packageVersion();
        const versionSkew = existing.version !== wantedVersion || health.version !== wantedVersion;
        if (identityMatches(existing, health)) {
          if (!await authenticatedProbe(existing)) {
            throw new Error(`daemon on port ${existing.port} did not accept its discovery token; refusing to kill PID ${existing.pid}`);
          }
          const stopped = stopStaleDaemon(existing);
          if (!stopped && processAlive(Number(existing.pid))) {
            throw new Error(`failed to stop the stale AgentTeams daemon on port ${existing.port} (PID ${existing.pid}); stop it manually`);
          }
          for (let attempt = 0; attempt < 20; attempt += 1) {
            if (!await probeHealth(existing)) break;
            await sleep(250);
          }
          if (await probeHealth(existing)) {
            throw new Error(`stale AgentTeams daemon on port ${existing.port} is still responding after stop; refusing to start a duplicate`);
          }
          if (versionSkew) replacedVersion = health.version ?? existing.version;
        } else {
          throw new Error(`daemon on port ${existing.port} did not prove its PID/instance identity; refusing to kill PID ${existing.pid}`);
        }
      }
      try { rmSync(discoveryPath, { force: true }); } catch { /* best effort */ }
    }

    mkdirSync(workspace, { recursive: true });
    const daemon = join(PACKAGE_ROOT, 'src', 'daemon.mjs');
    if (!existsSync(daemon)) throw new Error(`daemon not found: ${daemon}`);
    const daemonArgs = [
      daemon,
      '--config', configPath,
      '--cwd', workspace,
      '--db', dbPath,
      '--port', String(process.env.AGENT_TEAMS_PORT || 8779),
    ];
    // On Windows a detached node.exe still gets a console window in some host
    // combinations, even with windowsHide. wscript.exe is a GUI-subsystem host:
    // run-hidden.vbs starts node with a hidden console and no window at all.
    const launcher = join(PACKAGE_ROOT, 'scripts', 'run-hidden.vbs');
    const useHiddenLauncher = process.platform === 'win32' && existsSync(launcher);
    const child = spawn(
      useHiddenLauncher ? 'wscript.exe' : process.execPath,
      useHiddenLauncher ? [launcher, process.execPath, ...daemonArgs] : daemonArgs,
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, AGENT_TEAMS_AUTOSTART: '0', AGENT_TEAMS_DISCOVERY: discoveryPath },
      },
    );
    child.unref();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(300);
      const discovery = readDiscovery(discoveryPath);
      // `healthy` only asks whether the daemon agrees with its own record, so a
      // caller with an out-of-date idea of the version still recognises the
      // daemon it just started.
      if (discovery && await healthy(discovery, workspace)) {
        return { started: true, discovery, workspace, ...(replacedVersion ? { replacedVersion } : {}) };
      }
    }
    throw new Error('AgentTeams daemon did not become healthy');
  } finally {
    releaseLock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await prerequisiteReport();
  console.log(JSON.stringify(report, null, 2));
  if (!report.node.ok || !report.sqlite) {
    console.error('Node >= 22.5 with node:sqlite is required');
    process.exit(1);
  }
  if (process.argv.includes('--recommend')) process.exit(0);
  const result = await ensureDaemon();
  console.log(`AgentTeams daemon ${result.started ? 'started' : 'already running'} on port ${result.discovery.port}`);
  console.log(`workspace ${result.workspace}`);
}
