import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { buildContainerArgs, containerSelfTest, ensureContainerRuntime } from '../runtime/container.mjs';
import { buildCreateArgs, buildSendArgs, parseCliOutput, providerErrorDetails, providerErrorDetailsFromProcess } from './cli.mjs';
import { retryAfterMsFrom } from './retry-after.mjs';
import { normalizeWorkerModel, seedWorkerHome, writeMemberMcpConfig } from './worker-home.mjs';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function safeName(value) {
  return String(value).replace(/\.\./g, '_').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
}

function parseContainerOutput(stdout) {
  try {
    return parseCliOutput(stdout);
  } catch {
    const text = String(stdout ?? '').trim().slice(0, 2000);
    throw new Error(`container CLI returned non-JSON output: ${text || '(empty)'}`);
  }
}

/**
 * Run a container command and collect stdout/stderr. The container itself is
 * ephemeral (`--rm`); the worktree and home volume carry state between turns.
 * @param {{ command: string, args: string[], timeoutMs?: number, onProcess?: Function }} input
 * @returns {Promise<string>}
 */
export function runContainerCommand({ command, args, env, timeoutMs = DEFAULT_TIMEOUT_MS, onProcess }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    onProcess?.(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`container command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error(`container exited ${code}: ${stderr.slice(0, 2000) || stdout.slice(0, 2000)}`);
        error.exitCode = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Container-backed CLI adapter. Each turn runs the configured ZCode CLI inside
 * a hardened container that mounts only the task worktree, the member home and
 * the read-only package root. It is intentionally gated by containerSelfTest.
 */
export class ContainerCliSessionAdapter {
  constructor({
    runtime = 'docker',
    runtimeCommand = runtime,
    image,
    cliPath = 'zcode',
    packageRoot,
    baseUrl,
    containerBaseUrl,
    mode = 'build',
    workerMode = 'yolo',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    network = 'none',
    cpus = 2,
    memoryMb = 2048,
    pidsLimit = 512,
    readOnlyRoot = true,
    nonRoot = true,
    runner = runContainerCommand,
    homeRoot = join(tmpdir(), 'agent-teams-container-homes'),
    homeSeed = null,
    workerModel = null,
    providerBaseUrl = '',
  } = {}) {
    this.kind = 'cli';
    this.supportsModelSwitch = false;
    this.runtime = runtime;
    this.runtimeCommand = runtimeCommand;
    this.image = image;
    this.cliPath = cliPath;
    this.packageRoot = packageRoot;
    this.baseUrl = baseUrl;
    this.containerBaseUrl = this.toContainerUrl(containerBaseUrl ?? baseUrl);
    this.mode = mode;
    this.workerMode = workerMode;
    this.timeoutMs = timeoutMs;
    this.network = network;
    this.cpus = cpus;
    this.memoryMb = memoryMb;
    this.pidsLimit = pidsLimit;
    this.readOnlyRoot = readOnlyRoot;
    this.nonRoot = nonRoot;
    this.runner = runner;
    this.homeRoot = homeRoot;
    this.homeSeed = homeSeed;
    this.workerModel = normalizeWorkerModel(workerModel);
    this.providerBaseUrl = providerBaseUrl;
    this.seedWarnings = new Set();
    this.cleanupStaleHomes();
    this.sessions = new Map();
    this.processes = new Map();
    this.activeSends = new Map();
    this.terminatedSessions = new Map();
  }

  toContainerUrl(baseUrl) {
    if (!baseUrl) return undefined;
    try {
      const url = new URL(baseUrl);
      if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
        url.hostname = 'host.docker.internal';
      }
      return url.toString().replace(/\/$/, '');
    } catch {
      return baseUrl;
    }
  }

  envFor({ memberName, token, teamId, shadow = false }) {
    const env = {
      HOME: '/home/zcode',
      TMPDIR: '/tmp',
      XDG_CONFIG_HOME: '/home/zcode/.config',
      XDG_CACHE_HOME: '/home/zcode/.cache',
      XDG_DATA_HOME: '/home/zcode/.local/share',
      // Container sessions may inherit the plugin; never run the captain
      // panel SessionStart hook inside a worker.
      AI_AGENT_TEAMS_WORKER: '1',
      ...(memberName ? { AGENT_TEAMS_MEMBER: memberName } : {}),
      ...(teamId ? { AGENT_TEAMS_TEAM: teamId } : {}),
      ...(shadow ? { AGENT_TEAMS_SHADOW: '1' } : {}),
    };
    if (!token) return env;
    if (!this.containerBaseUrl) throw new Error('container mode requires a URL reachable from the container');
    return {
      ...env,
      AGENT_TEAMS_URL: this.containerBaseUrl,
      AGENT_TEAMS_TOKEN: token,
      AGENT_TEAMS_MEMBER_HOME: '/home/zcode',
    };
  }

  teamCliText(ephemeral) {
    if (ephemeral) return '';
    return `

Team tools are available through the agent-teams-member MCP server (claim_task, update_task, send_message). Read-only plan mode has no Bash, so prefer the MCP tools.

Team CLI is available at /opt/agent-teams/src/team-cli.mjs inside the container:
node /opt/agent-teams/src/team-cli.mjs claim <taskId> <attemptId>
node /opt/agent-teams/src/team-cli.mjs update <taskId> <attemptId> <status> '<json>'
node /opt/agent-teams/src/team-cli.mjs send <to> "<message>"`;
  }

  cleanupContainer(name) {
    if (!name) return { ok: true };
    try {
      const result = spawnSync(this.runtimeCommand, ['rm', '-f', name], {
        encoding: 'utf8', windowsHide: true, timeout: 30000,
      });
      if (result.error) return { ok: false, error: result.error.message };
      if (result.status !== 0) {
        const message = (result.stderr || result.stdout || '').trim() || `container rm exited ${result.status}`;
        // `rm -f` on a missing container is the desired end state. The runtime
        // reports it as an error, so map that one message to "already absent".
        if (/no such (?:container|object)|not found|does not exist|no container with/i.test(message)) {
          return { ok: true, absent: true, warning: message };
        }
        return { ok: false, error: message };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Ask the container runtime whether a container still exists. A query
   * failure (runtime down, permission error, unknown CLI shape) is returned as
   * `{ ok: false }` and must not be read as absence.
   * @param {string} name
   * @returns {{ ok: boolean, exists?: boolean, error?: string }}
   */
  queryContainer(name) {
    if (!name) return { ok: false, error: 'container name unavailable' };
    try {
      const result = spawnSync(
        this.runtimeCommand,
        ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 },
      );
      if (result.error) return { ok: false, error: result.error.message };
      if (result.status !== 0) {
        return { ok: false, error: (result.stderr || result.stdout || '').trim() || `runtime ps exited ${result.status}` };
      }
      const names = String(result.stdout ?? '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      return { ok: true, exists: names.includes(name) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  removeHome(record) {
    if (!record?.ephemeral || !record.home) return;
    const root = `${resolve(this.homeRoot)}${sep}`;
    const target = resolve(record.home);
    if (!target.startsWith(root)) return;
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // best effort; stale cleanup will retry
    }
  }

  cleanupStaleHomes(maxAgeMs = 24 * 60 * 60 * 1000) {
    try {
      if (!existsSync(this.homeRoot)) return;
      const now = Date.now();
      for (const entry of readdirSync(this.homeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(this.homeRoot, entry.name);
        try {
          if (now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { recursive: true, force: true });
        } catch {
          // another process may be using it
        }
      }
    } catch {
      // best effort
    }
  }

  buildArgs({ name, worktree, home, command, env }) {
    return buildContainerArgs({
      image: this.image,
      worktree,
      home,
      name,
      packageRoot: this.packageRoot,
      network: this.network,
      cpus: this.cpus,
      memory: `${Math.max(128, Number(this.memoryMb) || 2048)}m`,
      pids: this.pidsLimit,
      readOnlyRoot: this.readOnlyRoot,
      nonRoot: this.nonRoot,
      env,
      command,
    });
  }

  async runTurn({ name, args, processKey, env, parseProviderError = false, keepRetryHint = false }) {
    let child;
    let stdout;
    try {
      stdout = await this.runner({
        command: this.runtimeCommand,
        args,
        env,
        timeoutMs: this.timeoutMs,
        onProcess: (value) => {
          child = value;
          this.processes.set(processKey, value);
        },
      });
    } catch (error) {
      if (parseProviderError) {
        const details = providerErrorDetailsFromProcess(error);
        if (details) Object.assign(error, details);
      }
      if (keepRetryHint) {
        const hint = retryAfterMsFrom(error);
        if (hint) error.retryAfterMs = hint;
      }
      this.cleanupContainer(name);
      throw error;
    } finally {
      if (this.processes.get(processKey) === child) this.processes.delete(processKey);
    }
    return stdout;
  }

  warnOnce(key, message) {
    if (this.seedWarnings.has(key)) return;
    this.seedWarnings.add(key);
    console.warn(message);
  }

  /**
   * Prepare a member home before a container turn: copy the host ZCode profile
   * when configured, then write the member MCP config for persistent members.
   * Ephemeral contractors never receive a token, so they get no MCP config.
   * @param {string} home
   * @param {{ memberName?: string, teamId?: string, token?: string, shadow?: boolean }} [member]
   */
  seedHome(home, { memberName, teamId, token, shadow = false } = {}) {
    let result;
    if (!this.homeSeed) {
      this.warnOnce(`no-seed:${home}`, 'WARN container worker homeSeed is not configured; the worker will start without the host ZCode login/model.');
    } else {
      result = seedWorkerHome(home, {
        seedDir: this.homeSeed,
        model: this.workerModel,
        providerBaseUrl: this.providerBaseUrl,
      });
      if (result.seeded) {
        this.warnOnce(`seeded:${home}`, 'WARN container worker home seeded from the host ZCode profile; worker tasks can use the host login.');
      } else {
        const existing = existsSync(join(home, '.zcode', 'v2', 'credentials.json'));
        if (existing) {
          this.warnOnce(`refresh:${home}`, `WARN container worker home refresh failed; using the existing profile: ${result.reason ?? 'unknown reason'}`);
        } else {
          this.warnOnce(`unseeded:${home}`, `WARN container worker home is not authenticated: ${result.reason ?? 'unknown reason'}`);
        }
      }
      if (this.workerModel && !result.modelInjected) {
        this.warnOnce(`model:${home}`, `WARN container worker model was not injected: ${result.reason ?? 'provider config missing'}`);
      }
    }
    const mcp = token
      ? writeMemberMcpConfig(home, {
        baseUrl: this.containerBaseUrl,
        token,
        teamId,
        memberName,
        shadow,
      })
      : { written: false, reason: 'no member token; member MCP config is not written for ephemeral sessions' };
    if (!mcp.written && token) {
      this.warnOnce(`mcp:${home}`, `WARN container member MCP config was not written: ${mcp.reason ?? 'unknown reason'}`);
    }
    return { ...(result ?? {}), mcp };
  }

  async create({ teamId, memberName, memberId, cwd, prompt, ephemeral = false, mode = this.mode, disallowedTools = [], token, home, shadow = false }) {
    if (!cwd) throw new Error('container session requires a worktree cwd');
    if (!ephemeral && !token) throw new Error('member token required for a persistent container member session');
    const effectiveMode = mode === 'plan' ? 'plan' : this.workerMode;
    if (mode !== 'plan' && mode !== this.workerMode) {
      this.warnOnce(`mode:${home ?? memberName}`, `WARN container worker mode "${mode}" was overridden to "${this.workerMode}"`);
    }
    const sessionHome = home ?? join(this.homeRoot, safeName(`${teamId}-${memberName}-${memberId ?? 'member'}`));
    mkdirSync(sessionHome, { recursive: true });
    this.seedHome(sessionHome, { memberName, teamId, token: ephemeral ? undefined : token, shadow });
    const name = safeName(`agent-teams-${teamId}-${memberName}-${Date.now()}`);
    const env = this.envFor({ memberName, token, teamId, shadow });
    const args = this.buildArgs({
      name,
      worktree: cwd,
      home: sessionHome,
      env,
      command: [
        this.cliPath,
        ...buildCreateArgs({
          prompt,
          cwd: '/workspace',
          mode: effectiveMode,
          disallowedTools,
        }),
      ],
    });
    const processKey = `creating:${memberName}:${Date.now()}`;
    const stdout = await this.runTurn({
      name,
      args,
      env,
      processKey,
      parseProviderError: true,
    });
    const parsed = parseContainerOutput(stdout);
    const failure = providerErrorDetails(parsed);
    if (failure) {
      const error = new Error(failure.message);
      Object.assign(error, failure);
      throw error;
    }
    if (!parsed?.sessionId) throw new Error('ZCode CLI in container returned no sessionId');
    this.sessions.set(parsed.sessionId, {
      sessionId: parsed.sessionId,
      memberName,
      teamId,
      cwd,
      home: sessionHome,
      token,
      ephemeral,
      shadow,
      containerName: name,
      containerNames: [name],
    });
    return { sessionId: parsed.sessionId, response: parsed.response, usage: parsed.usage };
  }

  async send({ sessionId, message, cwd, disallowedTools = [], mode = this.mode, home, token, teamId, memberName }) {
    this.activeSends.set(sessionId, (this.activeSends.get(sessionId) ?? 0) + 1);
    try {
      const record = this.sessions.get(sessionId);
      const worktree = record?.cwd ?? cwd;
      const memberHome = home ?? record?.home;
      const memberToken = token ?? record?.token;
      const memberTeam = teamId ?? record?.teamId;
      const member = memberName ?? record?.memberName;
      if (!worktree || !memberHome) throw new Error('unknown container session');
      const effectiveMode = mode === 'plan' ? 'plan' : this.workerMode;
      if (mode !== 'plan' && mode !== this.workerMode) {
        this.warnOnce(`mode:${memberHome}`, `WARN container worker mode "${mode}" was overridden to "${this.workerMode}"`);
      }
      mkdirSync(memberHome, { recursive: true });
      this.seedHome(memberHome, {
        memberName: member,
        teamId: memberTeam,
        token: record?.ephemeral ? undefined : memberToken,
        shadow: record?.shadow === true,
      });
      const name = safeName(`agent-teams-${memberTeam}-${member}-${Date.now()}`);
      if (record) {
        record.containerName = name;
        record.containerNames = [...new Set([...(record.containerNames ?? []), name])];
      }
      const env = this.envFor({ memberName: member, token: memberToken, teamId: memberTeam, shadow: record?.shadow === true });
      const args = this.buildArgs({
        name,
        worktree,
        home: memberHome,
        env,
        command: [
          this.cliPath,
          ...buildSendArgs({
            sessionId,
            message: `${message}${record?.ephemeral ? '' : this.teamCliText(false)}`,
            cwd: '/workspace',
            mode: effectiveMode,
            disallowedTools,
          }),
        ],
      });
      const stdout = await this.runTurn({
        name,
        args,
        env,
        processKey: sessionId,
        parseProviderError: true,
        keepRetryHint: true,
      });
      const parsed = parseContainerOutput(stdout);
      const failure = providerErrorDetails(parsed);
      if (failure) return { ok: false, warning: `container provider error: ${failure.message}`, error: failure };
      return { ok: true, response: parsed.response, usage: parsed.usage };
    } finally {
      const remaining = (this.activeSends.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.activeSends.set(sessionId, remaining);
      else this.activeSends.delete(sessionId);
    }
  }

  async stop({ sessionId } = {}) {
    const child = sessionId ? this.processes.get(sessionId) : undefined;
    if (child) {
      try { child.kill(); } catch { /* best effort */ }
      this.processes.delete(sessionId);
    }
    const record = sessionId ? this.sessions.get(sessionId) : undefined;
    const names = record
      ? [...new Set([...(record.containerNames ?? []), record.containerName].filter(Boolean))]
      : [];
    const failures = [];
    for (const name of names) {
      const cleaned = this.cleanupContainer(name);
      if (cleaned.ok === false) failures.push(`${name}: ${cleaned.error}`);
    }
    this.removeHome(record);
    if (failures.length > 0) {
      return { ok: false, status: 'unknown', warning: `failed to remove container: ${failures.join('; ')}` };
    }
    if (!record || names.length === 0) {
      // No recorded container name means removal cannot be proven even if the
      // docker CLI wrapper is gone.
      return { ok: false, status: 'unknown', warning: 'no container name is recorded for this session; container removal is unverified' };
    }
    this.terminatedSessions.set(sessionId, { containerNames: names, terminatedAt: Date.now() });
    return { ok: true, status: 'exited' };
  }

  async close({ sessionId } = {}) {
    const stopped = await this.stop({ sessionId });
    if (stopped?.ok !== true) {
      // Keep the session record so a later retry still knows the container
      // names. Deleting it here lost the only handle to `podman rm` and made
      // the cleanup permanently unverifiable.
      return stopped ?? { ok: false, status: 'unknown', warning: 'container termination not confirmed' };
    }
    this.sessions.delete(sessionId);
    return { ok: true, status: 'exited' };
  }

  /**
   * Prove that a container session has no live side effects: a cleanup already
   * removed its recorded containers, no container runtime process is live,
   * the session record is gone, no send is in progress, and the runtime
   * confirms every container name no longer exists. Query failures are
   * unverified, never "absent".
   */
  async verifySessionTermination({ sessionId } = {}) {
    const failed = (warning) => ({ verified: false, sessionId, sideEffectsRevoked: false, warning });
    const terminated = this.terminatedSessions.get(sessionId);
    if (!terminated) return failed('container removal is not confirmed');
    if (this.processes.get(sessionId) !== undefined) return failed('a container runtime process is still live');
    if (this.sessions.has(sessionId)) return failed('the container session record is still present');
    if ((this.activeSends.get(sessionId) ?? 0) > 0) return failed('a container send is still in progress');
    const names = terminated.containerNames ?? [];
    if (names.length === 0) return failed('no container name was recorded for verification');
    for (const name of names) {
      const result = this.queryContainer(name);
      if (result?.ok !== true) return failed(`container state query failed for ${name}: ${result?.error ?? 'unknown error'}`);
      if (result.exists === true) return failed(`container ${name} still exists`);
    }
    return { verified: true, sessionId, sideEffectsRevoked: true };
  }

  async shutdown() {
    for (const sessionId of new Set([...this.processes.keys(), ...this.sessions.keys()])) {
      await this.stop({ sessionId });
    }
    this.sessions.clear();
    this.activeSends.clear();
    this.cleanupStaleHomes();
  }

  async compact() {
    return { ok: false, warning: 'container CLI cannot compact a live session; cold close + summary is used' };
  }

  async setModel() {
    return { ok: false, warning: 'container CLI has no setModel; use the app-server adapter for model switching' };
  }

  async probe() {
    const detected = ensureContainerRuntime(this.runtime);
    if (!detected.available) {
      return { methods: [], warnings: [`container runtime ${this.runtime} is not available${detected.machineStartError ? `: ${detected.machineStartError}` : ''}`] };
    }
    const selfTest = containerSelfTest({ runtime: detected.runtime, command: detected.command, image: this.image, cliPath: this.cliPath });
    if (!selfTest.ready) return { methods: [], warnings: [selfTest.reason ?? 'container self-test failed'] };
    return {
      methods: ['container/create', 'container/resume', 'container/cwd', 'container/self-test'],
      warnings: ['Container turns are synchronous; there is no live event stream.'],
    };
  }
}
