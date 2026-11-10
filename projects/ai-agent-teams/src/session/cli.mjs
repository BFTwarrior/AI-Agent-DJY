import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retryAfterMsFrom } from './retry-after.mjs';
import { killProcessTree } from './process-tree.mjs';
import { EXPLICIT_NUMERIC_CODE_PATTERN, HARD_QUOTA_CODE_PATTERN, HARD_QUOTA_TEXT_PATTERN, isHardQuotaError } from '../domain/provider-errors.mjs';

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolve the ZCode CLI. `ZCODE_CLI` wins; then the app install directory; then PATH.
 * @returns {string}
 */
export function resolveCli() {
  const env = process.env.ZCODE_CLI;
  if (env && existsSync(env)) return env;
  const candidates = [
    ...(process.platform === 'win32' ? [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Zcode', 'resources', 'glm', 'zcode.cjs')] : []),
    join(process.env.APPDATA ?? '', 'npm', 'zcode.cmd'),
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return 'zcode';
}

/**
 * @param {string} cli
 * @returns {{ command: string, prefix: string[] }}
 */
export function commandFor(cli) {
  if (/\.(cjs|mjs|js)$/i.test(cli)) return { command: process.execPath, prefix: [cli] };
  return { command: cli, prefix: [] };
}

/**
 * @param {{ prompt: string, cwd?: string, mode?: string }} input
 * @returns {string[]}
 */
export function buildCreateArgs({ prompt, cwd, mode = 'build', disallowedTools = [] }) {
  const args = ['-p', prompt, '--json', '--mode', mode];
  if (cwd) args.push('--cwd', cwd);
  if (disallowedTools.length > 0) args.push('--disallowed-tools', ...disallowedTools);
  return args;
}

/**
 * @param {{ sessionId: string, message: string, cwd?: string, mode?: string, disallowedTools?: string[] }} input
 * @returns {string[]}
 */
export function buildSendArgs({ sessionId, message, cwd, mode = 'build', disallowedTools = [] }) {
  const args = ['--resume', sessionId, '-p', message, '--json', '--mode', mode];
  if (cwd) args.push('--cwd', cwd);
  if (disallowedTools.length > 0) args.push('--disallowed-tools', ...disallowedTools);
  return args;
}

/**
 * Parse the JSON printed by `zcode -p ... --json`, tolerating leading log lines.
 * @param {string} stdout
 * @returns {any}
 */
export function parseCliOutput(stdout) {
  const text = String(stdout ?? '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('CLI output did not contain JSON');
    return JSON.parse(text.slice(start, end + 1));
  }
}

/**
 * @param {string} stdout
 * @returns {any | undefined}
 */
export function tryParseCliOutput(stdout) {
  try {
    return parseCliOutput(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Extract structured provider failure fields from a CLI JSON payload.
 * The CLI may report `{error:{...}}`, `{failure:{...}}`, or `{ok:false,...}`.
 *
 * @param {any} parsed
 * @returns {{ message: string, code?: string, type?: string, retryable?: boolean, retryAfterMs?: number } | undefined}
 */
export function providerErrorDetails(parsed) {
  const raw = parsed?.error ?? parsed?.failure ?? (parsed?.ok === false ? parsed : undefined);
  if (!raw) return undefined;
  if (typeof raw === 'string') return providerErrorFromText(raw);
  const message = raw.message ?? raw.detail ?? raw.underlyingErrorMessage ?? JSON.stringify(raw);
  const text = String(message).slice(0, 2000);
  const hint = retryAfterMsFrom(raw);
  const code = raw.code || raw.errorCode || raw.status || raw.statusCode;
  const hardQuota = HARD_QUOTA_CODE_PATTERN.test(String(code ?? '')) || HARD_QUOTA_TEXT_PATTERN.test(text);
  return {
    message: text,
    ...(code !== undefined ? { code } : {}),
    ...(raw.type ?? raw.errorType ? { type: raw.type ?? raw.errorType } : {}),
    ...(hardQuota ? { retryable: false } : (typeof raw.retryable === 'boolean' ? { retryable: raw.retryable } : {})),
    ...(hint ? { retryAfterMs: hint } : {}),
  };
}

const KNOWN_PROVIDER_CODE = /\b(429|401|403|400|404|insufficient[ _-]?quota|current[ _-]?quota|exceeded_current_quota_error|credit[ _-]?balance[ _-]?exhausted|rate[ _-]?limit[ _-]?exceeded|too[ _-]?many[ _-]?requests|overloaded)\b/i;

/**
 * Parse the plain-text stderr line that the real ZCode CLI writes when a
 * headless prompt fails (`Error: ... (traceId: ...)`). It has no JSON payload,
 * so only the message and a few well-known codes can be recovered.
 *
 * @param {string} text
 * @returns {{ message: string, code?: string, retryable?: boolean } | undefined}
 */
export function providerErrorFromText(text) {
  const value = String(text ?? '').trim();
  if (!value) return undefined;
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((item) => /^(?:Error|Cause):/i.test(item));
  const matching = [...lines].reverse().find((item) => /error|fail|quota|rate|429|invalid|unauthorized|2056|20097/i.test(item));
  const line = errorLine ?? matching ?? lines[0];
  const message = line.replace(/^\s*(?:Error|Cause):\s*/i, '').slice(0, 2000);
  const match = message.match(KNOWN_PROVIDER_CODE);
  const numeric = message.match(EXPLICIT_NUMERIC_CODE_PATTERN);
  const hardQuota = isHardQuotaError({ code: numeric?.[1], message });
  return {
    message,
    ...(numeric?.[1] ?? match?.[1] ? { code: numeric?.[1] ?? match?.[1] } : {}),
    ...(hardQuota ? { retryable: false } : {}),
  };
}

export function providerErrorDetailsFromProcess(error) {
  return providerErrorDetails(tryParseCliOutput(error?.stdout))
    ?? providerErrorDetails(tryParseCliOutput(error?.stderr))
    ?? providerErrorFromText(error?.stderr)
    ?? providerErrorFromText(error?.stdout);
}

function attachCliFailure(error) {
  const details = providerErrorDetailsFromProcess(error);
  if (details && error && typeof error === 'object') Object.assign(error, details);
  return error;
}

/**
 * @param {{ command: string, args: string[], cwd?: string, timeoutMs?: number }} input
 * @returns {Promise<string>}
 */
export function runCli({ command, args, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, onProcess }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      // POSIX: own process group so a timeout can kill the app-server
      // grandchild together with the wrapper. Windows uses `taskkill /T`.
      detached: process.platform !== 'win32',
      // CLI adapter prompts are member/contractor sessions, never the captain
      // UI session: suppress the panel SessionStart hook.
      env: { ...process.env, AI_AGENT_TEAMS_WORKER: '1', ...(env ?? {}) },
    });
    onProcess?.(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // `child.kill()` only signals the Node wrapper; the ZCode app-server is
      // a grandchild and would survive as an orphan.
      killProcessTree(child);
      reject(new Error(`ZCode CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (timedOut) return;
      killProcessTree(child);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) {
        const error = new Error(`ZCode CLI exited ${code}: ${stderr.slice(0, 2000) || stdout.slice(0, 2000)}`);
        error.exitCode = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve(stdout);
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM';
  }
}

export class CliSessionAdapter {
  constructor({
    cliPath = resolveCli(),
    mode = 'build',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    baseUrl,
    token,
    killTree = killProcessTree,
  } = {}) {
    this.kind = 'cli';
    this.supportsModelSwitch = false;
    this.cliPath = cliPath;
    this.mode = mode;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
    this.token = token;
    this.killTree = killTree;
    this.sessions = new Map();
    this.processes = new Map();
    this.activeSends = new Map();
    this.terminatedSessions = new Map();
  }

  async create({ teamId, memberName, cwd, prompt, ephemeral = false, mode = this.mode, disallowedTools = [], token, home, mcpMode = 'minimal', timeoutMs = this.timeoutMs, shadow = false }) {
    void mcpMode; // CLI has no MCP-list flag; exact-name denylists enforce the boundary.
    this.teamId = teamId;
    const launched = commandFor(this.cliPath);
    const cli = fileURLToPath(new URL('../team-cli.mjs', import.meta.url));
    const teamCli = ephemeral ? '' : `

Team CLI is available at ${cli}. Use it to claim/update/heartbeat/message:
` +
      `node "${cli}" claim <taskId> <attemptId>
` +
      `node "${cli}" update <taskId> <attemptId> <status> '<json>'
` +
      `node "${cli}" send <to> "<message>"`;
    const promptWithCli = `${prompt}${teamCli}`;
    const args = [...launched.prefix, ...buildCreateArgs({ prompt: promptWithCli, cwd, mode, disallowedTools })];
    let stdout;
    let child;
    const processKey = `creating:${memberName}:${Date.now()}`;
    try {
      stdout = await runCli({
        command: launched.command,
        args,
        cwd,
        // The contractor runner bounds creation by its own lifetime; a hanging
        // create has no session id yet, so this timer is the only thing that
        // can kill the process tree before the adapter's global default.
        timeoutMs,
        env: ephemeral ? undefined : this.envFor(memberName, token, teamId, home, shadow),
        onProcess: (value) => {
          child = value;
          this.processes.set(processKey, value);
        },
      });
    } catch (error) {
      throw attachCliFailure(error);
    } finally {
      if (this.processes.get(processKey) === child) this.processes.delete(processKey);
    }
    const parsed = parseCliOutput(stdout);
    const failure = providerErrorDetails(parsed);
    if (failure) {
      const error = new Error(failure.message);
      Object.assign(error, failure);
      throw error;
    }
    if (!parsed?.sessionId) throw new Error('ZCode CLI returned no sessionId');
    const record = { sessionId: parsed.sessionId, memberName, teamId, cwd, usage: parsed.usage, teamCli, ephemeral, token, home, shadow };
    this.sessions.set(parsed.sessionId, record);
    this.recordProcessExit(parsed.sessionId, child);
    return { sessionId: parsed.sessionId, response: parsed.response, usage: parsed.usage };
  }

  async send({ sessionId, message, cwd, delivery = 'queue', disallowedTools = [], mode = this.mode, home, timeoutMs = this.timeoutMs }) {
    const launched = commandFor(this.cliPath);
    const record = this.sessions.get(sessionId);
    const messageWithCli = `${message}${record?.ephemeral ? '' : (record?.teamCli ?? '')}`;
    const args = [...launched.prefix, ...buildSendArgs({ sessionId, message: messageWithCli, cwd, mode, disallowedTools })];
    // A new turn invalidates the previous turn's exit evidence. Otherwise a
    // timed-out send could reuse the create process's exit record and be
    // treated as proven.
    this.terminatedSessions.delete(sessionId);
    this.activeSends.set(sessionId, (this.activeSends.get(sessionId) ?? 0) + 1);
    try {
      let parsed;
      let child;
      try {
        const stdout = await runCli({
          command: launched.command,
          args,
          cwd,
          // A contractor turn carries its remaining lifetime; the CLI timer is
          // what kills the process tree when that lifetime runs out.
          timeoutMs,
          env: record?.ephemeral ? undefined : this.envFor(record?.memberName, record?.token, record?.teamId, home ?? record?.home, record?.shadow === true),
          onProcess: (value) => {
            child = value;
            this.processes.set(sessionId, value);
          },
        });
        parsed = parseCliOutput(stdout);
      } catch (error) {
        throw attachCliFailure(error);
      } finally {
        if (this.processes.get(sessionId) === child) this.processes.delete(sessionId);
      }
      this.recordProcessExit(sessionId, child);
      const failure = providerErrorDetails(parsed);
      if (failure) {
        return {
          ok: false,
          warning: `CLI provider error: ${failure.message}`,
          error: failure,
        };
      }
      return {
        ok: true,
        response: parsed.response,
        usage: parsed.usage,
        warning: delivery === 'guide' ? 'CLI adapter cannot guide; delivered on the next turn' : undefined,
      };
    } finally {
      const remaining = (this.activeSends.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.activeSends.set(sessionId, remaining);
      else this.activeSends.delete(sessionId);
    }
  }

  envFor(memberName, memberToken, teamId, home, shadow = false) {
    if (!this.baseUrl) return undefined;
    if (!memberToken) throw new Error('member token required for a CLI member session; refusing to fall back to the daemon admin token');
    return {
      AGENT_TEAMS_URL: this.baseUrl,
      AGENT_TEAMS_TOKEN: memberToken,
      AGENT_TEAMS_TEAM: teamId ?? this.teamId,
      AGENT_TEAMS_MEMBER: memberName,
      ...(shadow ? { AGENT_TEAMS_SHADOW: '1' } : {}),
      ...(home ? { AGENT_TEAMS_MEMBER_HOME: home, TMP: `${home}/tmp`, TEMP: `${home}/tmp` } : {}),
    };
  }

  /**
   * Wait until the wrapper pid disappears. Windows `taskkill /T /F` reports
   * success once it accepted the request, so the pid probe is the actual
   * evidence that the tree is gone. POSIX kills are verified inside
   * killProcessTree and never reach this path.
   * @param {any} child
   * @param {{ attempts?: number, delayMs?: number }} [options]
   * @returns {Promise<boolean>}
   */
  async treeExited(child, { attempts = 20, delayMs = 25 } = {}) {
    if (!child || child.pid === undefined) return false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (child.exitCode !== null && child.exitCode !== undefined) return true;
      if (!pidAlive(child.pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return false;
  }

  /**
   * A CLI turn is one wrapper process and `runCli` only resolves after the
   * child closes. Record that normal exit as termination evidence; otherwise
   * cleanup sees "no live handle" after every successful turn and can never
   * prove termination, which would pin the contractor slot forever.
   */
  recordProcessExit(sessionId, child) {
    if (!child) return;
    const exitCode = child.exitCode;
    const signalCode = child.signalCode ?? null;
    // Only a clean, unsignalled wrapper exit proves this turn ended. A
    // timeout/kill path rejects in runCli and records nothing, so cleanup
    // stays conservative instead of reusing an older turn's evidence.
    if (exitCode !== 0 || signalCode !== null) return;
    this.terminatedSessions.set(sessionId, {
      status: 'exited', exitCode, signalCode: null, verified: true, terminatedAt: Date.now(),
    });
  }

  async stop({ sessionId } = {}) {
    const child = sessionId ? this.processes.get(sessionId) : undefined;
    if (!child) {
      if (sessionId && this.terminatedSessions.get(sessionId)?.verified === true) {
        // A synchronous CLI turn already ended and its exit was recorded. No
        // live wrapper remains, so stopping it is a proven no-op.
        return { ok: true, status: 'exited', warning: 'no live CLI process; recorded process exit is the termination evidence' };
      }
      return {
        ok: false,
        status: 'unknown',
        warning: 'no live CLI process handle; session termination and credential revocation are unverified; session retained',
      };
    }
    const killed = this.killTree(child);
    if (!killed.ok) {
      const exited = killed.signalSent === true && await this.treeExited(child);
      if (!exited) {
        return { ok: false, status: 'unknown', warning: `CLI process-tree termination is unverified; session retained: ${killed.error}` };
      }
    }
    this.processes.delete(sessionId);
    this.terminatedSessions.set(sessionId, {
      status: killed.status ?? 'exited', verified: true, terminatedAt: Date.now(),
    });
    return { ok: true, status: killed.status ?? 'exited' };
  }

  async compact() {
    return { ok: false, warning: 'CLI adapter cannot compact a live session; cold close + summary is used' };
  }

  async setModel() {
    return { ok: false, warning: 'CLI has no --model; use protocol session/setModel' };
  }

  async close({ sessionId }) {
    const child = this.processes.get(sessionId);
    if (child) {
      const killed = this.killTree(child);
      if (!killed.ok) {
        const exited = killed.signalSent === true && await this.treeExited(child);
        if (!exited) {
          return { ok: false, status: 'unknown', warning: `CLI process-tree termination is unverified; session retained: ${killed.error}` };
        }
      }
      this.processes.delete(sessionId);
      this.terminatedSessions.set(sessionId, {
        status: killed.status ?? 'exited', verified: true, terminatedAt: Date.now(),
      });
    }
    if (this.terminatedSessions.get(sessionId)?.verified !== true) {
      // A missing local handle proves nothing: the CLI has no revoke
      // operation and the session id stays resumable.
      return { ok: false, status: 'unknown', warning: 'no live CLI process and no confirmed process-tree termination; session retained' };
    }
    // The member credential and session id cannot be revoked through the CLI.
    // That is a limitation of the transport, not a live side effect: the
    // process tree and every in-flight turn are confirmed gone. Keep the
    // local record so a cold resume remains possible.
    return {
      ok: true,
      status: 'exited',
      warning: 'CLI provides no session or credential revocation; process-tree termination is confirmed',
    };
  }

  /**
   * Side-effect proof for the CLI transport. Credential revocation does not
   * exist, so the proof is: this adapter killed the process tree, no wrapper
   * is live, and no send is still in progress. The retained session id is
   * deliberately not treated as a live side effect.
   */
  async verifySessionTermination({ sessionId } = {}) {
    const terminated = this.terminatedSessions.get(sessionId);
    const liveChild = this.processes.get(sessionId);
    const active = (this.activeSends.get(sessionId) ?? 0) > 0;
    const verified = terminated?.verified === true && liveChild === undefined && !active;
    return {
      verified,
      sessionId,
      sideEffectsRevoked: verified,
      ...(verified ? {} : { warning: 'CLI process-tree termination or in-flight turn is not proven' }),
    };
  }

  async shutdown() {
    const unresolved = [];
    for (const [sessionId, child] of this.processes) {
      const result = this.killTree(child);
      if (result.ok) this.processes.delete(sessionId);
      else unresolved.push({ sessionId, status: 'unknown', error: result.error });
    }
    // Session ids and member credentials remain usable for later CLI resumes;
    // shutdown cannot revoke them, even when no wrapper process is live.
    const retainedSessions = [...this.sessions.keys()];
    return {
      ok: unresolved.length === 0 && retainedSessions.length === 0,
      status: unresolved.length || retainedSessions.length ? 'unknown' : 'exited',
      unresolved,
      retainedSessions,
    };
  }

  async probe() {
    const launched = commandFor(this.cliPath);
    const args = [...launched.prefix, '--help'];
    try {
      const help = await runCli({ command: launched.command, args, timeoutMs: 20000 });
      const methods = ['cli/create', 'cli/resume', 'cli/cwd', 'cli/disallowed-tools'];
      if (help.includes('guide')) methods.push('cli/guide');
      return {
        methods,
        warnings: ['CLI turns are synchronous: provider errors are returned from send and retried immediately. There is no live event stream for mid-turn events.'],
      };
    } catch (error) {
      return { methods: [], warnings: [error instanceof Error ? error.message : String(error)] };
    }
  }
}
