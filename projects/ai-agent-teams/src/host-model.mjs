import {
  chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readNativeWorkerModel } from './service/model-policy.mjs';

/**
 * The host (captain) ZCode session publishes its model and reasoning level
 * through its daily JSONL log. Members follow those values unless the operator
 * pins a fixed model with `agent_teams_model set`.
 *
 * Only `session.model.updated` and `session.reasoning_effort.updated` carry the
 * host values. `model.request.started` was investigated on ZCode 0.17 and its
 * context has no model/thoughtLevel fields, so it is not a supported source.
 */
const HOST_MODEL_EVENT = 'session.model.updated';
const HOST_REASONING_EVENT = 'session.reasoning_effort.updated';
/** Workspace-relative state written by the SessionStart hook. */
const HOST_SESSION_DIR = '.ai-agent-teams';
const HOST_SESSION_FILE = 'host-session.json';
const HOST_SESSION_MODE = 0o600;
const DEFAULT_CHUNK_SIZE = 512 * 1024;
// Bytes before the stored offset are compared on every read. A truncate-and-
// regrow that ends up larger than the old size cannot be detected by size
// alone; a changed anchor means the file was rewritten and must be rescanned.
const ANCHOR_SIZE = 64;

/**
 * The log is named by local calendar day, while event timestamps are UTC.
 * @param {Date} date
 * @returns {string} YYYY-MM-DD in local time
 */
function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * @param {string} [home]
 * @returns {string}
 */
function zcodeLogDir(home = homedir()) {
  return join(home, '.zcode', 'cli', 'log');
}

/**
 * Today's log first, then yesterday's (a session can cross midnight).
 * Only existing files are returned so a fresh install does not throw.
 * @param {{ homeDir?: string, now?: Date }} [options]
 * @returns {string[]}
 */
export function hostLogPaths({ homeDir, now = new Date() } = {}) {
  const dir = zcodeLogDir(homeDir);
  const paths = [];
  for (let offset = 0; offset <= 1; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const file = join(dir, `zcode-${localDateKey(day)}.jsonl`);
    if (existsSync(file)) paths.push(file);
  }
  return paths;
}

/**
 * Path of the workspace state file the SessionStart hook writes.
 * @param {string} workspace
 * @returns {string}
 */
export function hostSessionPath(workspace) {
  return join(resolve(workspace), HOST_SESSION_DIR, HOST_SESSION_FILE);
}

/**
 * The daemon process does not inherit the host session id from ZCode: only
 * hook subprocesses receive `ZCODE_SESSION_ID`. The SessionStart hook therefore
 * persists the id next to the workspace so the daemon can read it every tick.
 * Writes are atomic (temp file + rename) and 0600 (best effort on Windows).
 * @param {string} workspace
 * @param {string} sessionId
 * @param {{ now?: number }} [options]
 * @returns {{ path: string, sessionId: string, updatedAt: number } | null}
 */
export function writeHostSessionFile(workspace, sessionId, { now = Date.now() } = {}) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!workspace || !id) return null;
  const path = hostSessionPath(workspace);
  const payload = `${JSON.stringify({ sessionId: id, updatedAt: now, source: 'session-start-hook' })}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, payload, { encoding: 'utf8', mode: HOST_SESSION_MODE });
  try {
    chmodSync(temp, HOST_SESSION_MODE);
  } catch {
    // Windows has no POSIX mode bits; the write already happened.
  }
  renameSync(temp, path);
  try {
    chmodSync(path, HOST_SESSION_MODE);
  } catch {
    // see above
  }
  return { path, sessionId: id, updatedAt: now };
}

/**
 * Read the host session id written by the SessionStart hook. A malformed or
 * missing file is not an error: the reader falls back to the environment.
 * @param {string} path
 * @returns {{ sessionId: string, updatedAt: number|null, source: string|null } | null}
 */
export function readHostSessionFile(path) {
  if (!path) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId.trim() : '';
  if (!sessionId) return null;
  const updatedAt = Number(parsed.updatedAt);
  return {
    sessionId,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    source: typeof parsed.source === 'string' ? parsed.source : null,
  };
}

/**
 * Extract a model/reasoning update for one session from a single log line.
 * Returns null for unrelated lines so callers can skip JSON.parse cheaply.
 * @param {string} line
 * @param {string} sessionId
 * @returns {{ field: 'model'|'reasoning', value: string, timestamp: string|null } | null}
 */
export function parseHostLogLine(line, sessionId) {
  if (typeof line !== 'string' || !sessionId || !line.includes(sessionId)) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry?.sessionId !== sessionId) return null;
  if (entry.event === HOST_MODEL_EVENT) {
    const model = entry.context?.model;
    if (typeof model !== 'string' || !model.trim()) return null;
    return { field: 'model', value: model.trim(), timestamp: entry.timestamp ?? null };
  }
  if (entry.event === HOST_REASONING_EVENT) {
    const thoughtLevel = entry.context?.thoughtLevel;
    if (typeof thoughtLevel !== 'string' || !thoughtLevel.trim()) return null;
    return { field: 'reasoning', value: thoughtLevel.trim(), timestamp: entry.timestamp ?? null };
  }
  return null;
}

/**
 * Iterate a file's complete lines from the end to the start in bounded chunks.
 * `visitor` returning false stops the scan; the newest match is visited first.
 * @param {string} path
 * @param {number} chunkSize
 * @param {(line: string) => boolean|void} visitor
 */
function forEachLineBackward(path, chunkSize, visitor) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return;
  }
  try {
    let position = fstatSync(fd).size;
    let partial = '';
    while (position > 0) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      readSync(fd, buffer, 0, length, position);
      // latin1 is a 1:1 byte mapping, so a chunk boundary that splits a
      // multi-byte UTF-8 character cannot corrupt a line; each complete line
      // is decoded back to UTF-8 before parsing.
      const lines = (buffer.toString('latin1') + partial).split('\n');
      partial = position > 0 ? (lines.shift() ?? '') : '';
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const bytes = lines[index].replace(/\r$/, '');
        if (!bytes.trim()) continue;
        const line = Buffer.from(bytes, 'latin1').toString('utf8');
        if (visitor(line) === false) return;
      }
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Byte offset just past the last complete (newline-terminated) line. A writer
 * may be mid-line when the first read or a rotation happens; setting the
 * offset to stat.size would skip that line forever once it is completed.
 * Returns 0 when the file has no newline at all.
 * @param {string} path
 * @param {number} chunkSize
 * @returns {number}
 */
function lastCompleteLineEnd(path, chunkSize = DEFAULT_CHUNK_SIZE) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return 0;
  }
  try {
    let position = fstatSync(fd).size;
    while (position > 0) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      readSync(fd, buffer, 0, length, position);
      const index = buffer.lastIndexOf(0x0a);
      if (index >= 0) return position + index + 1;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read up to `size` bytes ending at `end`, or null when the file is gone.
 * @param {string} path
 * @param {number} end
 * @param {number} size
 * @returns {Buffer|null}
 */
function readTail(path, end, size) {
  if (end <= 0) return null;
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const start = Math.max(0, end - size);
    const buffer = Buffer.allocUnsafe(end - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return read === buffer.length ? buffer : buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan one file backwards and fill in the newest model/reasoning values.
 * The scan visits newest lines first and stops at the first hit of each field,
 * so a direct assignment is always the newest value.
 * @param {string} path
 * @param {string} sessionId
 * @param {{ model: string|null, reasoning: string|null }} state
 * @param {number} chunkSize
 */
function scanNewestValues(path, sessionId, state, chunkSize) {
  forEachLineBackward(path, chunkSize, (line) => {
    const parsed = parseHostLogLine(line, sessionId);
    if (!parsed) return true;
    if (parsed.field === 'model') state.model = parsed.value;
    else state.reasoning = parsed.value;
    return !(state.model && state.reasoning);
  });
}

/**
 * Read the host session's model/reasoning with per-file offsets so the daemon
 * only parses appended bytes after the first read.
 *
 * The session id is resolved on every read: the workspace state file written by
 * the SessionStart hook wins, `ZCODE_SESSION_ID` (hook/daemon env) is the
 * fallback. A new session id discards cached values and offsets.
 */
export class HostModelReader {
  /**
   * @param {{ sessionId?: string|null, workspace?: string, hostSessionPath?: string, homeDir?: string, now?: () => Date, chunkSize?: number, defaultModel?: string|null, defaultReasoning?: string|null }} [options]
   */
  constructor({
    sessionId = process.env.ZCODE_SESSION_ID ?? null,
    workspace,
    hostSessionPath: sessionFile,
    homeDir,
    now = () => new Date(),
    chunkSize = DEFAULT_CHUNK_SIZE,
    defaultModel = null,
    defaultReasoning = null,
  } = {}) {
    this.envSessionId = sessionId || null;
    this.sessionFilePath = sessionFile ?? (workspace ? hostSessionPath(workspace) : null);
    this.homeDir = homeDir;
    this.now = now;
    this.chunkSize = chunkSize;
    this.defaultModel = defaultModel ?? null;
    this.defaultReasoning = defaultReasoning ?? null;
    this.sessionId = null;
    this.sessionSource = 'none';
    this.offsets = new Map();
    this.anchors = new Map();
    this.values = { model: null, reasoning: null };
  }

  /**
   * The state file is authoritative because the daemon cannot see the host
   * session env; `ZCODE_SESSION_ID` only covers hook-spawned processes and
   * tests that fetch directly.
   * @returns {{ sessionId: string|null, source: 'file'|'env'|'none' }}
   */
  resolveSession() {
    if (this.sessionFilePath) {
      const file = readHostSessionFile(this.sessionFilePath);
      if (file) return { sessionId: file.sessionId, source: 'file' };
    }
    if (this.envSessionId) return { sessionId: this.envSessionId, source: 'env' };
    return { sessionId: null, source: 'none' };
  }

  /**
   * @returns {{ model: string|null, reasoning: string|null, source: 'host'|'default'|'none', sessionId: string|null, sessionSource: 'file'|'env'|'none' }}
   */
  read() {
    const resolved = this.resolveSession();
    this.sessionSource = resolved.source;
    if (resolved.sessionId !== this.sessionId) {
      this.sessionId = resolved.sessionId;
      this.values = { model: null, reasoning: null };
      this.offsets.clear();
      this.anchors.clear();
    }
    if (!this.sessionId) return this.snapshot();
    const paths = hostLogPaths({ homeDir: this.homeDir, now: this.now() });
    for (const path of this.offsets.keys()) {
      if (!paths.includes(path)) {
        this.offsets.delete(path);
        this.anchors.delete(path);
      }
    }
    for (let index = 0; index < paths.length; index += 1) {
      // Older files may fill gaps but must never overwrite a newer value.
      this.scanFile(paths[index], index === 0);
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      model: this.values.model ?? this.defaultModel,
      reasoning: this.values.reasoning ?? this.defaultReasoning,
      source: this.values.model || this.values.reasoning ? 'host' : (this.defaultModel || this.defaultReasoning ? 'default' : 'none'),
      sessionId: this.sessionId,
      sessionSource: this.sessionSource,
    };
  }

  /**
   * @param {string} path
   * @param {boolean} allowOverride
   */
  scanFile(path, allowOverride) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    const known = this.offsets.get(path);
    const rewritten = !known || stat.size < known || !this.anchorMatches(path, known);
    if (rewritten) {
      // First read, truncation, or a rewrite that regrew past the old offset:
      // bounded backward scan plus anchor comparison detects all three.
      const found = { model: null, reasoning: null };
      scanNewestValues(path, this.sessionId, found, this.chunkSize);
      if (found.model && (allowOverride || !this.values.model)) this.values.model = found.model;
      if (found.reasoning && (allowOverride || !this.values.reasoning)) this.values.reasoning = found.reasoning;
      // Never advance past a partially written trailing line.
      const end = lastCompleteLineEnd(path, this.chunkSize);
      this.offsets.set(path, end);
      this.rememberAnchor(path, end);
      return;
    }
    if (stat.size === known) return;
    this.scanAppended(path, known, allowOverride);
    this.rememberAnchor(path, this.offsets.get(path) ?? known);
  }

  /**
   * Remember the last bytes before an offset so the next read can tell an
   * append (same prefix) from a rewrite (different prefix).
   * @param {string} path
   * @param {number} end
   */
  rememberAnchor(path, end) {
    const tail = readTail(path, end, ANCHOR_SIZE);
    if (tail && tail.length > 0) this.anchors.set(path, tail);
    else this.anchors.delete(path);
  }

  /**
   * @param {string} path
   * @param {number} end
   * @returns {boolean}
   */
  anchorMatches(path, end) {
    const anchor = this.anchors.get(path);
    if (!anchor) return false;
    const tail = readTail(path, end, anchor.length);
    return Boolean(tail) && tail.equals(anchor);
  }

  /**
   * Parse only appended bytes. Reading happens in fixed-size chunks so a large
   * catch-up after a long daemon outage never allocates the whole delta; bytes
   * after the last newline stay pending until the writer finishes the line.
   * @param {string} path
   * @param {number} known
   * @param {boolean} allowOverride
   */
  scanAppended(path, known, allowOverride) {
    let fd;
    try {
      fd = openSync(path, 'r');
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      let position = known;
      let pending = Buffer.alloc(0);
      while (position < size) {
        const length = Math.min(this.chunkSize, size - position);
        const buffer = Buffer.allocUnsafe(length);
        readSync(fd, buffer, 0, length, position);
        position += length;
        pending = pending.length > 0 ? Buffer.concat([pending, buffer]) : buffer;
        const lastNewline = pending.lastIndexOf(0x0a);
        if (lastNewline < 0) continue;
        const complete = pending.subarray(0, lastNewline).toString('utf8');
        pending = Buffer.from(pending.subarray(lastNewline + 1));
        for (const raw of complete.split('\n')) {
          const parsed = parseHostLogLine(raw.replace(/\r$/, ''), this.sessionId);
          if (!parsed) continue;
          if (parsed.field === 'model' && (allowOverride || !this.values.model)) {
            this.values.model = parsed.value;
          }
          if (parsed.field === 'reasoning' && (allowOverride || !this.values.reasoning)) {
            this.values.reasoning = parsed.value;
          }
        }
      }
      this.offsets.set(path, position - pending.length);
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * Polls the host model and hot-applies it to every active member session when
 * it changes. A fixed policy or a broken log only skips a cycle; it never
 * throws into the daemon's interval.
 */
export class ModelWatcher {
  /**
   * @param {{ service: any, intervalMs?: number, logger?: { warn?: Function, error?: Function }, now?: () => number, maxFailedTicks?: number }} input
   */
  constructor({
    service, intervalMs = 3000, logger = console, now = () => Date.now(), maxFailedTicks = 5,
  }) {
    this.service = service;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.now = now;
    this.maxFailedTicks = Math.max(1, maxFailedTicks);
    this.lastSignature = null;
    this.lastNativeSignature = 'inherit';
    this.nativeFailureSignatures = new Map();
    this.failedTicks = 0;
    this.retryAt = 0;
    this.timer = null;
    this.running = false;
  }

  /**
   * @returns {Promise<{ changed: boolean, applied: number, model?: string|null, reasoning?: string|null, skipped?: string, retry?: boolean, retryAt?: number, attempts?: number, abandoned?: boolean, error?: string }>}
   */
  async tick() {
    if (this.running) return { changed: false, applied: 0, skipped: 'busy' };
    this.running = true;
    let nativeFailureKey = 'read';
    try {
      if (!this.service) return { changed: false, applied: 0, skipped: 'no-service' };
      const native = readNativeWorkerModel(this.service);
      const nativeSignature = native?.signature ?? 'inherit';
      nativeFailureKey = nativeSignature;
      const nativeChanged = nativeSignature !== this.lastNativeSignature;
      const policyMode = this.service.modelPolicy?.mode ?? 'follow-host';
      const nativeRetry = Boolean(this.service.nativeAgentModel) && this.failedTicks > 0;
      if (policyMode !== 'follow-host' && !native && !nativeChanged && !nativeRetry) {
        this.resetFailures();
        return { changed: false, applied: 0, skipped: 'fixed' };
      }
      const host = policyMode === 'follow-host'
        ? this.service.currentHostModel()
        : { model: this.service.modelPolicy.model, reasoning: this.service.modelPolicy.reasoning };
      if (!host?.model && !native && !nativeChanged && !nativeRetry) {
        this.resetFailures();
        return { changed: false, applied: 0, skipped: 'no-model', sessionId: host?.sessionId ?? null };
      }
      // Native pins also change in fixed mode and without a host model.
      const nativeOnly = policyMode !== 'follow-host' || !host?.model;
      const signature = `${host?.model ?? ''}\u0000${host?.reasoning ?? ''}\u0000${this.service.modelPolicyEpoch ?? 0}`
        + (this.service.nativeAgentModel ? `\u0000${nativeSignature}` : '');
      if (signature === this.lastSignature && !nativeChanged && !nativeRetry) {
        return { changed: false, applied: 0, model: host.model, reasoning: host.reasoning };
      }
      if (nativeChanged) this.resetFailures();
      if (this.failedTicks > 0 && this.now() < this.retryAt) {
        return {
          changed: false,
          applied: 0,
          skipped: 'backoff',
          model: host.model,
          reasoning: host.reasoning,
          retryAt: this.retryAt,
        };
      }
      const { modelPolicyEpoch } = this.service;
      // Remember attempted pins too: an error reply can follow a remote switch.
      this.lastNativeSignature = nativeSignature;
      const result = await this.service.applyModelToActiveSessions({
        model: host.model,
        reasoning: host.reasoning,
        reason: 'follow-host',
        ...(Number.isInteger(modelPolicyEpoch) ? { expectedEpoch: modelPolicyEpoch } : {}),
        ...(this.service.nativeAgentModel ? {
          expectedNativeSignature: nativeSignature, expectedPolicyMode: policyMode, nativeOnly,
        } : {}),
      });
      if (result.skipped === 'superseded') {
        // A set/follow happened while this tick was queued; the new policy
        // already applied its own value, so this result must not be recorded.
        this.resetFailures();
        return { changed: false, applied: 0, skipped: 'superseded', model: host.model, reasoning: host.reasoning };
      }
      if (result.skipped === 'unsupported') {
        // CLI/container adapters cannot hot-switch; remembering the signature
        // prevents an attempt (and an event) on every tick.
        this.resetFailures();
        this.lastSignature = signature;
        this.lastNativeSignature = nativeSignature;
        return { changed: false, applied: 0, skipped: 'unsupported', model: host.model, reasoning: host.reasoning };
      }
      if (result.failed?.length > 0 && result.applied === 0) {
        // Every live session rejected the value. Retry next tick, then back
        // off; after maxFailedTicks give up on this signature so a permanent
        // adapter/model error cannot produce an event every 3 seconds.
        this.failedTicks += 1;
        if (this.failedTicks >= this.maxFailedTicks) {
          const attempts = this.failedTicks;
          try {
            this.service.noteModelFollowAbandoned?.({
              model: host.model,
              reasoning: host.reasoning,
              attempts,
              failed: result.failed,
            });
          } catch {
            // the watcher must never fail because an audit event failed
          }
          this.lastSignature = signature;
        this.lastNativeSignature = nativeSignature;
          this.resetFailures();
          try {
            this.logger?.warn?.(`model watcher gave up after ${attempts} attempts on ${signature.replace('\u0000', ' ')}`);
          } catch {
            // logging must never crash the watcher
          }
          return { changed: true, ...result, abandoned: true, attempts };
        }
        this.retryAt = this.now() + this.backoffMs(this.failedTicks);
        return {
          changed: true, ...result, retry: true, retryAt: this.retryAt, attempts: this.failedTicks,
        };
      }
      this.resetFailures();
      this.lastSignature = signature;
      this.lastNativeSignature = nativeSignature;
      return { changed: true, ...result };
    } catch (error) {
      const nativeCode = /^(E_NATIVE_|NATIVE_AGENT_)/u.test(String(error?.code ?? '')) ? error.code : null;
      if (nativeCode && this.service?.store) {
        const signature = `${nativeCode}:${nativeFailureKey}`;
        for (const team of this.service.store.listTeams()) {
          if (this.nativeFailureSignatures.get(team.id) === signature) continue;
          this.service.store.updateTeam(team.id, { needsCaptain: true });
          this.service.store.addEvent(team.id, 'model.follow_failed', {
            reason: 'native-model-selection', errorCode: nativeCode, error: nativeCode,
          });
          this.nativeFailureSignatures.set(team.id, signature);
        }
      }
      const message = nativeCode ?? (error instanceof Error ? error.message : String(error));
      try {
        this.logger?.warn?.(`model watcher failed: ${message}`);
      } catch {
        // logging must never crash the watcher
      }
      return { changed: false, applied: 0, error: message };
    } finally {
      this.running = false;
    }
  }

  /** First retry is immediate; later attempts back off exponentially (capped). */
  backoffMs(failures) {
    if (failures <= 1) return 0;
    return Math.min(this.intervalMs * (2 ** (failures - 2)), 60 * 1000);
  }

  resetFailures() {
    this.failedTicks = 0;
    this.retryAt = 0;
  }

  /** Run one tick immediately, then every intervalMs. */
  start() {
    if (this.timer) return this;
    this.tick().catch(() => {});
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
