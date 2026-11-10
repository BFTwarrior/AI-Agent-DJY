import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCli, commandFor } from './cli.mjs';
import { killProcessTree } from './process-tree.mjs';
import { retryAfterMsFrom } from './retry-after.mjs';
import { MEMBER_MCP_SERVER_NAME } from '../domain/team-tools.mjs';

export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_PENDING_REQUESTS = 1000;
export const DEFAULT_MAX_QUEUED_WRITE_BYTES = 16 * 1024 * 1024;

function protocolError(code, message) {
  return Object.assign(new Error(message), { code });
}

function positiveLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function protocolSessionIdOf(item) {
  if (typeof item === 'string') return item;
  return item?.sessionId ?? item?.id ?? item?.session?.sessionId;
}

/**
 * Minimal ZCode app-server client. The protocol shape is `{ id, method, params }`
 * (no `jsonrpc` field); server-initiated requests are answered inline.
 *
 * All three transports are bounded: a single stdout frame, the number of
 * outstanding requests and the number of bytes waiting behind stdin
 * backpressure. Without those limits a stuck or hostile app-server can grow
 * the daemon's heap without bound.
 */
export class AppServerClient {
  constructor({
    cliPath = resolveCli(),
    cwd = process.cwd(),
    timeoutMs = 30000,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
    maxQueuedWriteBytes = DEFAULT_MAX_QUEUED_WRITE_BYTES,
  } = {}) {
    this.cliPath = cliPath;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.maxFrameBytes = positiveLimit(maxFrameBytes, DEFAULT_MAX_FRAME_BYTES);
    this.maxPendingRequests = positiveLimit(maxPendingRequests, DEFAULT_MAX_PENDING_REQUESTS);
    this.maxQueuedWriteBytes = positiveLimit(maxQueuedWriteBytes, DEFAULT_MAX_QUEUED_WRITE_BYTES);
    this.child = undefined;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = undefined;
    this.closing = false;
    // Ready resolvers are bound to the child that owns that stdout stream.
    // A late `startup/storageState` line from an old, killed attempt must
    // never resolve a newly spawned attempt.
    this.readyResolvers = new Map();
    // Pre-ready failures (including an oversized startup frame) must reject
    // the cached start promise so the caller can retry start().
    this.childStartFailures = new Map();
    // stdin backpressure state. While `writeBlocked` is true every later write
    // is queued (and bounded by maxQueuedWriteBytes) until `drain` fires.
    this.writeQueue = [];
    this.queuedWriteBytes = 0;
    this.writeBlocked = false;
    this.writeStream = undefined;
    this.drainHandler = undefined;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.closing = false;
    const launched = commandFor(this.cliPath);
    const child = spawn(launched.command, [...launched.prefix, 'app-server', '--cwd', this.cwd], {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX: own the process group so a failed startup can kill the
      // wrapper/app-server tree. Windows uses `taskkill /T` in killProcessTree.
      detached: process.platform !== 'win32',
      // Worker sessions must not run the captain-panel SessionStart hook.
      env: { ...process.env, AI_AGENT_TEAMS_WORKER: '1' },
    });
    this.child = child;
    this.resetWriteState();
    this.attachOutput(child);
    let promise;
    promise = new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      // Every pre-ready failure (stderr, spawn error, timeout) must clear the
      // cached promise and kill the child tree so the next start() can retry.
      const fail = (error, kill) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.child === child) this.child = undefined;
        if (this.startPromise === promise) this.startPromise = undefined;
        this.readyResolvers.delete(child);
        this.childStartFailures.delete(child);
        this.resetWriteState();
        if (kill) killProcessTree(child);
        reject(error);
      };
      const readyResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.readyResolvers.delete(child);
        this.childStartFailures.delete(child);
        resolve();
      };
      this.childStartFailures.set(child, fail);
      this.readyResolvers.set(child, () => {
        // Ignore a late ready line from an attempt that already failed.
        if (this.child === child) readyResolve();
      });
      const failChild = (error) => {
        if (this.child !== child) return;
        const startFail = this.childStartFailures.get(child);
        if (startFail) {
          startFail(error, true);
          return;
        }
        this.resetAfterWriteFailure(error);
      };
      child.stdin?.on?.('error', failChild);
      child.stdout?.on?.('error', failChild);
      child.stderr.on('data', (chunk) => {
        fail(new Error(chunk.toString().slice(0, 2000)), true);
      });
      child.on('error', (error) => {
        fail(error, true);
      });
      child.on('exit', (code, signal) => {
        if (!settled) {
          fail(new Error(`app-server exited before ready (code ${code ?? 'null'}, signal ${signal ?? 'none'})`), false);
          return;
        }
        // An old child exiting after a retry must not clear the new one.
        if (this.child !== child) return;
        this.child = undefined;
        this.readyResolvers.delete(child);
        this.childStartFailures.delete(child);
        if (this.startPromise === promise) this.startPromise = undefined;
        this.resetWriteState();
        if (this.closing) return;
        this.rejectPending(new Error(`app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`));
      });
      timer = setTimeout(() => {
        fail(new Error(`app-server did not become ready within ${this.timeoutMs}ms`), true);
      }, this.timeoutMs);
    });
    this.startPromise = promise;
    return promise;
  }

  /**
   * Read newline-delimited frames without ever buffering a whole oversized line.
   * The previous readline reader accepted any line length, so a single broken
   * app-server write could exhaust the daemon heap before JSON.parse ran.
   * @param {any} child
   */
  attachOutput(child) {
    const frames = { parts: [], bytes: 0, failed: false };
    child.stdout.on('data', (chunk) => {
      if (frames.failed || this.child !== child) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      let start = 0;
      while (start < buffer.length) {
        const newline = buffer.indexOf(0x0a, start);
        const end = newline === -1 ? buffer.length : newline;
        const size = end - start;
        if (frames.bytes + size > this.maxFrameBytes) {
          frames.failed = true;
          frames.parts = [];
          frames.bytes = 0;
          this.failProtocolFrame(child, protocolError(
            'E_PROTOCOL_FRAME_TOO_LARGE',
            `app-server frame exceeded ${this.maxFrameBytes} bytes; killing app-server`,
          ));
          return;
        }
        if (size > 0) {
          frames.parts.push(buffer.subarray(start, end));
          frames.bytes += size;
        }
        if (newline === -1) return;
        const lineBuffer = frames.parts.length === 1 ? frames.parts[0] : Buffer.concat(frames.parts, frames.bytes);
        frames.parts = [];
        frames.bytes = 0;
        const line = lineBuffer.toString('utf8');
        if (line.trim()) this.handleLine(line, child);
        // handleLine can reset the client through a failed safeWrite; stop
        // touching a child that no longer owns this stream.
        if (frames.failed || this.child !== child) return;
        start = newline + 1;
      }
    });
  }

  /**
   * A protocol-level violation invalidates this child entirely: reject every
   * outstanding request, stop reading, kill the tree and clear the cached
   * start promise so the next request can spawn a fresh app-server.
   * @param {any} child
   * @param {Error} error
   */
  failProtocolFrame(child, error) {
    if (this.child !== child) return;
    const startFail = this.childStartFailures.get(child);
    if (startFail) {
      startFail(error, true);
      return;
    }
    this.detachChild(child, error, true);
  }

  detachChild(child, error, kill) {
    if (this.child !== child) return;
    this.child = undefined;
    this.startPromise = undefined;
    this.readyResolvers.delete(child);
    this.childStartFailures.delete(child);
    this.resetWriteState();
    this.rejectPending(error);
    try { child.stdout?.destroy?.(); } catch { /* stream already closed */ }
    if (kill) killProcessTree(child);
  }

  rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  resetWriteState() {
    this.writeQueue = [];
    this.queuedWriteBytes = 0;
    this.writeBlocked = false;
    const stream = this.writeStream;
    const handler = this.drainHandler;
    if (stream && handler) stream.off?.('drain', handler);
    this.writeStream = undefined;
    this.drainHandler = undefined;
  }

  handleLine(line, child) {
    // A killed old attempt may still have buffered stdout. It must not write
    // responses (or satisfy ready) against the newly spawned child.
    if (this.child !== child) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === 'startup/storageState') {
      if (message.params?.phase === 'ready') this.readyResolvers.get(child)?.();
      return;
    }
    if (message.method === 'session/requestRuntimePreferences') {
      this.safeWrite({ id: message.id, result: { nativeSearchEnhancementsEnabled: false } });
      return;
    }
    if (message.method === 'interaction/requestOfficialMcpAuthHeaders') {
      this.safeWrite({ id: message.id, result: { headers: {} } });
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else resolve(message.result);
    }
  }

  write(message) {
    const stream = this.child?.stdin;
    if (!stream?.writable) throw new Error('app-server stdin is closed');
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.writeBlocked || this.writeQueue.length > 0) {
      if (this.queuedWriteBytes + bytes > this.maxQueuedWriteBytes) {
        const error = protocolError(
          'E_PROTOCOL_WRITE_QUEUE_LIMIT',
          `app-server write queue exceeded ${this.maxQueuedWriteBytes} bytes; resetting app-server`,
        );
        this.resetAfterWriteFailure(error);
        throw error;
      }
      this.writeQueue.push({ line, bytes });
      this.queuedWriteBytes += bytes;
      return;
    }
    if (!stream.write(line)) this.waitForDrain(stream);
  }

  waitForDrain(stream) {
    if (this.writeBlocked) return;
    this.writeBlocked = true;
    this.writeStream = stream;
    const handler = () => {
      if (this.writeStream !== stream) return;
      this.writeBlocked = false;
      this.writeStream = undefined;
      this.drainHandler = undefined;
      this.flushWrites();
    };
    this.drainHandler = handler;
    stream.once('drain', handler);
  }

  flushWrites() {
    while (this.writeQueue.length > 0 && !this.writeBlocked) {
      const stream = this.child?.stdin;
      if (!stream?.writable) {
        this.resetAfterWriteFailure(new Error('app-server stdin is closed'));
        return;
      }
      const entry = this.writeQueue.shift();
      this.queuedWriteBytes -= entry.bytes;
      let accepted;
      try {
        accepted = stream.write(entry.line);
      } catch (error) {
        this.resetAfterWriteFailure(error);
        return;
      }
      if (!accepted) this.waitForDrain(stream);
    }
  }

  safeWrite(message) {
    try {
      this.write(message);
    } catch (error) {
      this.resetAfterWriteFailure(error);
    }
  }

  /**
   * A closed stdin means this client can never recover in place. Kill the
   * dead tree, reject every outstanding request, clear queued writes, and
   * clear the cached start promise so the next request starts a fresh
   * app-server.
   */
  resetAfterWriteFailure(error) {
    const child = this.child;
    if (child) {
      this.detachChild(child, error, true);
      return;
    }
    this.resetWriteState();
    this.rejectPending(error);
  }

  pendingForSession(sessionId) {
    if (!sessionId) return 0;
    let count = 0;
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) count += 1;
    }
    return count;
  }

  async request(method, params, timeoutMs = this.timeoutMs) {
    if (this.pending.size >= this.maxPendingRequests) throw pendingLimitError(method, this.maxPendingRequests);
    await this.start();
    // `start()` can take a while; re-check after the await so concurrent
    // callers cannot race past the limit.
    if (this.pending.size >= this.maxPendingRequests) throw pendingLimitError(method, this.maxPendingRequests);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`protocol request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, sessionId: params?.sessionId });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.resetAfterWriteFailure(error);
        reject(error);
      }
    });
  }

  async close() {
    this.closing = true;
    const error = new Error('app-server closed');
    for (const startFail of [...this.childStartFailures.values()]) startFail(error, true);
    const child = this.child;
    this.child = undefined;
    this.startPromise = undefined;
    this.readyResolvers.clear();
    this.resetWriteState();
    this.rejectPending(error);
    if (child) killProcessTree(child);
  }
}

function pendingLimitError(method, limit) {
  return Object.assign(
    protocolError(
      'E_PROTOCOL_PENDING_LIMIT',
      `app-server pending request limit (${limit}) exceeded while sending ${method}`,
    ),
    { method, requestWritten: false },
  );
}

/**
 * Structured selections preserve both identifiers and their own reasoning.
 * Legacy string references retain the existing last-slash split.
 * @param {string|{providerId: string, modelId: string, options?: {reasoningLevel?: string}}} value
 * @param {string|null} [reasoning] Fallback used only for legacy strings.
 * @returns {{ providerId: string, modelId: string, options?: {reasoningLevel: string} }}
 */
export function parseModelRef(value, reasoning) {
  if (value && typeof value === 'object') {
    const { providerId, modelId, options } = value;
    if (Array.isArray(value) || typeof providerId !== 'string' || !providerId.trim()
      || typeof modelId !== 'string' || !modelId.trim()
      || (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)))
      || (options?.reasoningLevel !== undefined && (typeof options.reasoningLevel !== 'string' || !options.reasoningLevel.trim()))) {
      throw new Error('model selection must contain non-empty providerId/modelId and valid reasoning');
    }
    return {
      providerId,
      modelId,
      ...(options?.reasoningLevel ? { options: { reasoningLevel: options.reasoningLevel } } : {}),
    };
  }
  const text = String(value ?? '').trim();
  const slash = text.lastIndexOf('/');
  if (slash <= 0 || slash === text.length - 1) throw new Error('model must be providerId/modelId');
  return {
    providerId: text.slice(0, slash),
    modelId: text.slice(slash + 1),
    ...(reasoning ? { options: { reasoningLevel: reasoning } } : {}),
  };
}

/**
 * @param {string} teamId
 * @param {string} memberName
 * @param {string} [memberToken]
 * @param {string} [daemonUrl]
 * @returns {string}
 */
export function teamCliFooter(teamId, memberName, memberToken, daemonUrl) {
  const cli = fileURLToPath(new URL('../team-cli.mjs', import.meta.url));
  const tokenPart = memberToken ? `AGENT_TEAMS_TOKEN="${memberToken}" ` : '';
  const urlPart = daemonUrl ? `AGENT_TEAMS_URL="${daemonUrl}" ` : '';
  const prefix = `${urlPart}${tokenPart}AGENT_TEAMS_TEAM="${teamId}" AGENT_TEAMS_MEMBER="${memberName}"`;
  return `\n\nTeam CLI (discovery supplies URL/token):\n${prefix} node "${cli}" claim <taskId> <attemptId>\n${prefix} node "${cli}" update <taskId> <attemptId> <status> '<json>'\n${prefix} node "${cli}" heartbeat <taskId> <attemptId>\n${prefix} node "${cli}" send <to> "<message>"`;
}

/**
 * Only the team-control MCP server is mounted into a member session. Passing
 * the list explicitly prevents every user/plugin MCP from being loaded into
 * every worker just because the host has it configured.
 * @param {{ token?: string, teamId: string, memberName: string, daemonUrl?: string }} input
 * @returns {Array<any>}
 */
export function memberMcpServer({ token, teamId, memberName, daemonUrl, shadow = false }) {
  const serverPath = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));
  const env = [
    { name: 'AGENT_TEAMS_AUTOSTART', value: '0' },
    { name: 'AGENT_TEAMS_TEAM', value: teamId },
    { name: 'AGENT_TEAMS_MEMBER', value: memberName },
  ];
  if (shadow) env.push({ name: 'AGENT_TEAMS_SHADOW', value: '1' });
  const url = daemonUrl || process.env.AGENT_TEAMS_URL;
  if (url) env.push({ name: 'AGENT_TEAMS_URL', value: url });
  if (token) env.push({ name: 'AGENT_TEAMS_TOKEN', value: token });
  return [{
    name: MEMBER_MCP_SERVER_NAME,
    command: process.execPath,
    args: [serverPath],
    env,
    alwaysLoad: true,
    timeoutMs: 30000,
  }];
}

export class ProtocolSessionAdapter {
  constructor({ cliPath = resolveCli(), cwd = process.cwd(), mode = 'build', client, baseUrl } = {}) {
    this.kind = 'protocol';
    this.supportsModelSwitch = true;
    this.cwd = cwd;
    this.mode = mode;
    this.baseUrl = baseUrl;
    this.client = client ?? new AppServerClient({ cliPath, cwd });
    this.sessions = new Map();
    this.closedSessions = new Map();
    this.activeSends = new Map();
  }

  async probe() {
    try {
      await this.client.request('runtime/capabilities', {});
      await this.client.request('session/list', {});
      return {
        methods: ['protocol/create', 'protocol/send', 'protocol/stop', 'protocol/setModel', 'protocol/compact', 'protocol/resume', 'protocol/guide(stop+send)', 'protocol/events'],
        warnings: [],
      };
    } catch (error) {
      return { methods: [], warnings: [error instanceof Error ? error.message : String(error)] };
    }
  }

  async create({ teamId, memberName, cwd, prompt, model, modelSelection, reasoning, ephemeral = false, token, mode = this.mode, disallowedTools = [], home, mcpMode = 'minimal', shadow = false }) {
    // Validate native selections before creating any external session. Keep
    // structured identifiers intact; either ID may itself contain a slash.
    const selection = modelSelection !== undefined ? parseModelRef(modelSelection) : undefined;
    const workspacePath = cwd ?? this.cwd;
    const mcpServers = mcpMode === 'none' || !token
      ? []
      : memberMcpServer({ token, teamId, memberName, daemonUrl: this.baseUrl, shadow });
    const result = await this.client.request('session/create', {
      workspace: { workspacePath, workspaceKey: workspacePath },
      mode,
      mcpServers,
      ...(disallowedTools.length > 0 ? { toolDenylist: disallowedTools } : {}),
    });
    const sessionId = result?.session?.sessionId;
    if (!sessionId) throw new Error('protocol session/create returned no sessionId');
    this.sessions.set(sessionId, { sessionId, teamId, memberName, cwd: workspacePath, ephemeral, token, home, pendingPrompt: prompt });
    if (model || selection) {
      try {
        await this.setModel({ sessionId, model, modelSelection: selection, reasoning });
      } catch (error) {
        try { await this.stop({ sessionId }); } catch { /* best effort */ }
        try { await this.close({ sessionId }); } catch { /* best effort */ }
        this.sessions.delete(sessionId);
        const modelLabel = selection ? `${selection.providerId}/${selection.modelId}` : model;
        throw new Error(`protocol setModel failed for ${modelLabel}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { sessionId, response: 'created', usage: undefined };
  }

  async send({ sessionId, message, cwd: _cwd, delivery = 'queue', wait = false, timeoutMs = 300000 }) {
    const record = this.sessions.get(sessionId);
    if (!record) return { ok: false, warning: 'unknown protocol session' };
    this.activeSends.set(sessionId, (this.activeSends.get(sessionId) ?? 0) + 1);
    try {
      const footer = record?.ephemeral ? '' : teamCliFooter(record?.teamId, record?.memberName, record?.token, this.baseUrl);
      const pendingPrompt = record?.pendingPrompt;
      const prefix = pendingPrompt ? `${pendingPrompt}

` : '';
      const content = `${prefix}${message}${footer}`;
      let warning;
      if (delivery === 'guide') {
        try {
          await this.stop({ sessionId });
          warning = 'guide implemented as stop+send on app-server';
        } catch (error) {
          warning = `guide stop failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const baseline = wait ? new Set((await this.messages(sessionId)).map((item) => item?.info?.id ?? item?.id)) : undefined;
      await this.client.request('session/send', { sessionId, content });
      if (record) record.pendingPrompt = undefined;
      if (!wait) return { ok: true, warning, usage: undefined };
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const messages = await this.messages(sessionId);
        const candidates = messages.filter((item) => item?.info?.role === 'assistant' && !baseline.has(item?.info?.id ?? item?.id));
        const final = candidates.findLast((item) => ['stop', 'length', 'content-filter'].includes(item?.info?.finish));
        if (final) {
          const text = (final.parts ?? [])
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
            .trim();
          const tokens = final.info?.tokens ?? {};
          const inputTokens = Number(tokens.input ?? 0);
          const outputTokens = Number(tokens.output ?? 0);
          return {
            ok: true,
            response: text,
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: Number(tokens.total ?? (inputTokens + outputTokens)),
            },
            warning,
          };
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
      throw new Error(`protocol turn timed out after ${timeoutMs}ms`);
    } finally {
      const remaining = (this.activeSends.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.activeSends.set(sessionId, remaining);
      else this.activeSends.delete(sessionId);
    }
  }

  async messages(sessionId) {
    const result = await this.client.request('session/messages', { sessionId });
    if (Array.isArray(result)) return result;
    return Array.isArray(result?.messages) ? result.messages : [];
  }

  async subscribe({ sessionId, afterSeq = 0 }) {
    return this.client.request('session/subscribe', { sessionId, afterSeq });
  }

  async events({ sessionId, afterSeq = 0, timeoutMs }) {
    return this.client.request('session/events', { sessionId, afterSeq }, timeoutMs);
  }

  async turnCursor({ sessionId, timeoutMs }) {
    const result = await this.events({ sessionId, afterSeq: 0, timeoutMs });
    const events = Array.isArray(result) ? result : (Array.isArray(result?.events) ? result.events : []);
    return events.reduce((max, event) => {
      const seq = Number(event?.sequenceNumber ?? event?.seq ?? 0);
      return Number.isFinite(seq) && seq > max ? seq : max;
    }, 0);
  }

  async waitForSessionEvent({
    sessionId,
    afterSeq = 0,
    types = [],
    timeoutMs = 120000,
    intervalMs = 500,
  }) {
    const wanted = new Set(types);
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let cursor = Number(afterSeq) || 0;
    while (Date.now() < deadline) {
      const result = await this.events({ sessionId, afterSeq: cursor });
      const events = Array.isArray(result) ? result : (Array.isArray(result?.events) ? result.events : []);
      for (const event of events) {
        const seq = Number(event?.sequenceNumber ?? event?.seq ?? 0);
        if (Number.isFinite(seq) && seq > cursor) cursor = seq;
        const type = String(event?.type ?? event?.kind ?? '');
        if (wanted.has(type)) return { type, event, cursor };
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
    }
    throw new Error(`timed out waiting for session event: ${types.join(', ') || 'any'}`);
  }

  /**
   * Watch a background turn and surface terminal failures. Normal member sends
   * are intentionally non-blocking; without this watcher a provider failure
   * would remain invisible until the lease expired.
   * @param {{ sessionId: string, afterSeq?: number, intervalMs?: number, timeoutMs?: number, onFailed?: Function, onCompleted?: Function, onError?: Function }} input
   * @returns {{ cancel: Function }}
   */
  watchTurn({
    sessionId,
    afterSeq = 0,
    intervalMs = 1000,
    timeoutMs = 15 * 60 * 1000,
    onFailed,
    onCompleted,
    onError,
    onWarning,
  }) {
    let cancelled = false;
    let cursor = Number(afterSeq) || 0;
    let errors = 0;
    let warned = false;
    const deadline = Date.now() + timeoutMs;
    let timer;

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        onError?.(new Error(`turn watcher timed out after ${timeoutMs}ms`));
        return;
      }
      try {
        const result = await this.events({ sessionId, afterSeq: cursor });
        if (cancelled) return;
        const events = Array.isArray(result) ? result : (Array.isArray(result?.events) ? result.events : []);
        errors = 0;
        warned = false;
        for (const event of events) {
          if (cancelled) return;
          const seq = Number(event?.sequenceNumber ?? event?.seq ?? 0);
          if (Number.isFinite(seq) && seq > cursor) cursor = seq;
          const type = String(event?.type ?? event?.kind ?? '');
          if (type === 'turn.failed' || type === 'turn-failed') {
            const error = event?.payload?.error ?? event?.error ?? {};
            const message = [error.message, error.underlyingErrorMessage, error.detail]
              .filter((part) => typeof part === 'string' && part.trim())
              .join(' | ') || 'provider turn failed';
            onFailed?.({
              message,
              code: error.code,
              type: error.type,
              retryable: error.retryable,
              retryAfterMs: retryAfterMsFrom(error),
              event,
            });
            return;
          }
          if (type === 'turn.completed' || type === 'turn-completed') {
            const resultType = event?.payload?.resultType;
            if (resultType && resultType !== 'success') {
              onFailed?.({
                message: `provider turn ended with ${resultType}`,
                code: resultType,
                type: 'turn.completed',
                retryAfterMs: retryAfterMsFrom(event?.payload?.error ?? event?.error ?? {}),
                event,
              });
            } else {
              onCompleted?.(event);
            }
            return;
          }
        }
      } catch (error) {
        errors += 1;
        if (errors >= 3 && !warned) {
          warned = true;
          onWarning?.({
            error,
            count: errors,
            message: `session/events polling failed ${errors} times; retrying until the lease deadline`,
          });
        }
      }
      if (!cancelled) {
        const backoff = errors > 0
          ? Math.min(30000, Math.max(intervalMs, intervalMs * 2 ** Math.min(errors - 1, 5)))
          : intervalMs;
        timer = setTimeout(poll, backoff);
        timer.unref?.();
      }
    };

    timer = setTimeout(poll, 0);
    timer.unref?.();
    return {
      cancel() {
        cancelled = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  async stop({ sessionId }) {
    try {
      await this.client.request('session/stop', { sessionId });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A session that the app-server already forgot (daemon restart, crashed
      // worker) is stopped. Keeping the stale id would make `stop_failed` block
      // every later shadow start with no way to recover.
      if (/unknown (protocol )?session|no such session|session .*not found|session .*closed/i.test(message)) {
        this.sessions.delete(sessionId);
        return { ok: true, alreadyStopped: true };
      }
      throw error;
    }
  }

  async compact({ sessionId, instructions, wait = true, timeoutMs = 120000 }) {
    if (!this.sessions.has(sessionId)) return { ok: false, warning: 'unknown protocol session' };
    let startSeq = 0;
    try {
      startSeq = await this.turnCursor({ sessionId });
    } catch {
      startSeq = 0;
    }
    let result;
    try {
      result = await this.client.request('session/compact', {
        sessionId,
        ...(instructions ? { instructions } : {}),
      });
    } catch (error) {
      return { ok: false, warning: `compact failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!wait) return { ok: true, state: result?.compact?.state ?? 'accepted', result };
    try {
      const completion = await this.waitForSessionEvent({
        sessionId,
        afterSeq: startSeq,
        types: ['turn.completed', 'turn.failed', 'session_compacted', 'session_compact_failed', 'session_compact_cancelled'],
        timeoutMs,
      });
      const type = completion.type;
      if (type === 'turn.failed' || type === 'session_compact_failed' || type === 'session_compact_cancelled') {
        return { ok: false, warning: `compact ended with ${type}`, event: completion.event, result };
      }
      return { ok: true, state: type === 'turn.completed' || type === 'session_compacted' ? 'completed' : 'accepted', event: completion.event, result };
    } catch (error) {
      return { ok: false, warning: `compact wait failed: ${error instanceof Error ? error.message : String(error)}`, result };
    }
  }

  async resume({ sessionId, cwd }) {
    const workspacePath = cwd ?? this.cwd;
    const result = await this.client.request('session/resume', {
      sessionId,
      workspace: { workspacePath, workspaceKey: workspacePath },
    });
    const restored = this.closedSessions.get(sessionId) ?? this.sessions.get(sessionId) ?? {};
    this.closedSessions.delete(sessionId);
    this.sessions.set(sessionId, {
      ...restored,
      sessionId,
      cwd: workspacePath,
      pendingPrompt: undefined,
      ephemeral: false,
    });
    return { ok: true, sessionId: result?.session?.sessionId ?? sessionId, result };
  }

  async setModel({ sessionId, model, modelSelection, reasoning }) {
    const parsed = modelSelection !== undefined ? parseModelRef(modelSelection) : parseModelRef(model, reasoning);
    await this.client.request('session/setModel', {
      sessionId,
      model: parsed,
      persistAsWorkspaceLastUsed: false,
    });
    return { ok: true };
  }

  async setThoughtLevel({ sessionId, thoughtLevel }) {
    await this.client.request('session/setThoughtLevel', {
      sessionId,
      thoughtLevel,
      persistAsWorkspaceLastUsed: false,
    });
    return { ok: true };
  }

  async close({ sessionId }) {
    let result;
    try {
      await this.client.request('session/close', { sessionId });
      result = { ok: true, status: 'closed' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A session the app-server already forgot is closed, but a transport
      // failure is not proof of anything: keep the local record so verify can
      // reject the cleanup instead of silently freeing the contractor slot.
      if (/unknown (protocol )?session|no such session|session .*not found|session .*closed/i.test(message)) {
        result = { ok: true, status: 'closed', alreadyClosed: true, warning: `session already closed: ${message}` };
      } else {
        result = { ok: false, status: 'unknown', warning: `session/close not confirmed: ${message}` };
      }
    }
    if (result.ok !== true) return result;
    const record = this.sessions.get(sessionId) ?? { sessionId };
    this.closedSessions.set(sessionId, record);
    this.sessions.delete(sessionId);
    return result;
  }

  /**
   * Prove that a protocol session lost its server-side side effects. Close
   * must be confirmed locally, the app-server must no longer list the session,
   * and no send or request may still be in flight for it. Any query failure is
   * reported as unverified rather than fail-open.
   */
  async verifySessionTermination({ sessionId } = {}) {
    const failed = (warning) => ({ verified: false, sessionId, sideEffectsRevoked: false, warning });
    if (!sessionId || !this.closedSessions.has(sessionId) || this.sessions.has(sessionId)) {
      return failed('protocol session close is not confirmed');
    }
    if ((this.activeSends.get(sessionId) ?? 0) > 0) return failed('a protocol send is still in progress');
    if (typeof this.client.pendingForSession === 'function' && this.client.pendingForSession(sessionId) > 0) {
      return failed('protocol requests for this session are still in progress');
    }
    let listed;
    try {
      const result = await this.client.request('session/list', {});
      if (Array.isArray(result)) listed = result;
      else if (Array.isArray(result?.sessions)) listed = result.sessions;
      else return failed('session/list returned an unrecognized payload');
    } catch (error) {
      return failed(`session/list query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (listed.some((item) => protocolSessionIdOf(item) === sessionId)) {
      return failed('session is still listed by the app-server');
    }
    return { verified: true, sessionId, sideEffectsRevoked: true };
  }

  async shutdown() {
    this.closedSessions.clear();
    this.activeSends.clear();
    await this.client.close();
  }
}
