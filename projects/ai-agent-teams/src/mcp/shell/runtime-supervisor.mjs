import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { RuntimeTargets } from './runtime-target.mjs';
import { ShellProtocol } from './protocol.mjs';
import { PointerWatcher } from './pointer-watcher.mjs';
import { sleep, errorResponse } from './support.mjs';

const MAX_RUNTIME_LINE_BYTES = 8 * 1024 * 1024;
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Sole owner of runtime identity, membership, crash policy and lifecycle queues.
// The protocol sees membership through read-only callbacks and never publishes a runtime.
export class RuntimeSupervisor {
  constructor(lifecycle, channel, watch) {
    this.pluginRoot = lifecycle.pluginRoot;
    this.pointerPath = lifecycle.pointerPath;
    this.drainTimeoutMs = lifecycle.drainTimeoutMs;
    this.killGraceMs = lifecycle.killGraceMs;
    this.restartDelayMs = lifecycle.restartDelayMs;
    this.maxRestartDelayMs = lifecycle.maxRestartDelayMs;
    this.stableAfterMs = lifecycle.stableAfterMs;
    this.maxConsecutiveCrashes = lifecycle.maxConsecutiveCrashes;
    this.workspaceOption = lifecycle.workspaceOption;
    this.runtimeEnv = lifecycle.runtimeEnv;
    const { log, packageVersion } = channel;
    this.log = log;
    this.current = null;
    this.retiring = new Set();
    this.runtimes = new Set();
    this.crashCounts = new Map();
    this.generation = 0;
    this.lastSwitchError = null;
    this.lastRuntimeError = null;
    this.lastWorkspace = null;
    this.switchChain = Promise.resolve();
    this.switchRunning = 0;
    this.spawnPromise = null;
    this.restartTimer = null;
    this.restartAttempts = 0;
    this.restartStopped = false;
    this.forceFallback = false;
    this.closing = false;
    this.closePromise = null;
    this.targets = new RuntimeTargets({ pluginRoot: this.pluginRoot, pointerPath: this.pointerPath, packageVersion, log });
    this.protocol = new ShellProtocol({
      ...channel,
      routing: {
        current: () => this.current,
        isRetiring: (record) => this.retiring.has(record),
        isClosing: () => this.closing,
      },
    });
    this.watcher = new PointerWatcher({
      pointerPath: this.pointerPath,
      watchEnabled: watch.watchEnabled,
      watchIntervalMs: watch.watchIntervalMs,
      readPointerDocument: () => this.targets.readPointerDocument(),
      reload: () => this.reload(),
      isClosing: () => this.closing,
      hasSwitchError: () => this.lastSwitchError,
      log,
    });
  }

  resolveWorkspacePath() {
    const chosen = typeof this.workspaceOption === 'function' ? this.workspaceOption() : this.workspaceOption;
    const value = chosen ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const workspace = resolve(value);
    this.lastWorkspace = workspace;
    return workspace;
  }

  markStable(record) {
    if (!record || record.exited || record.stabilityCleared) return;
    record.stabilityCleared = true;
    this.crashCounts.delete(record.key);
    // A runtime that survived long enough (or answered a host request) proves
    // the deployment is healthy again; allow a later restart to retry the
    // pointer target instead of staying pinned to the fallback forever.
    this.forceFallback = false;
    this.restartStopped = false;
  }

  scheduleStability(record) {
    if (!(this.stableAfterMs > 0)) return;
    if (record.stableTimer) clearTimeout(record.stableTimer);
    record.stableTimer = setTimeout(() => {
      record.stableTimer = null;
      this.markStable(record);
    }, this.stableAfterMs);
    record.stableTimer.unref?.();
  }

  registerCrash(record, reason) {
    const count = (this.crashCounts.get(record.key) ?? 0) + 1;
    this.crashCounts.set(record.key, count);
    this.log(`runtime ${record.version} exited unexpectedly ${count} time(s) in a row (${reason})`);
    if (count < this.maxConsecutiveCrashes) return;
    if (record.target.source === 'pointer' && !this.forceFallback) {
      this.forceFallback = true;
      this.lastSwitchError = {
        at: Date.now(),
        message: `runtime ${record.version} crashed ${count} time(s) in a row; falling back to the packaged runtime`,
        version: record.version,
        entry: record.entry,
      };
      this.log(this.lastSwitchError.message);
      return;
    }
    this.restartStopped = true;
    this.lastRuntimeError = `agent-teams runtime stopped after ${count} consecutive crashes (${reason})`;
    this.log(`${this.lastRuntimeError}; automatic restarts are stopped until the runtime is reloaded`);
  }

  finishRecord(record) {
    if (record.exited) return;
    record.exited = true;
    if (record.stableTimer) {
      clearTimeout(record.stableTimer);
      record.stableTimer = null;
    }
    const info = record.exitInfo ?? {};
    const reason = info.error
      ? info.error
      : `code=${info.code ?? 'unknown'}, signal=${info.signal ?? 'none'}`;
    const message = record.stopping
      ? 'agent-teams runtime stopped'
      : `agent-teams runtime exited unexpectedly (${reason})`;
    this.protocol.failPending(record, message);
    this.protocol.failHostRequests(record, message);
    this.protocol.dropBufferedNotifications(record, message);
    record.resolveStop?.();
    this.runtimes.delete(record);
    if (!this.closing && record === this.current) {
      this.current = null;
      if (!record.stopping) this.registerCrash(record, reason);
      // registerCrash updated this target's consecutive-crash count; use it so
      // a crash loop backs off (base, 2x, 4x, ...) until it stabilises.
      const crashAttempt = record.stopping ? 0 : Math.max(0, (this.crashCounts.get(record.key) ?? 1) - 1);
      this.scheduleRestart(message, crashAttempt);
    }
    this.log(record.stopping
      ? `runtime ${record.version} generation ${record.generation} stopped`
      : `runtime ${record.version} generation ${record.generation} exited (${reason})`);
  }

  forceKill(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // The child may have exited between the check and the signal.
    }
    // Windows: node's SIGKILL only terminates the direct child; taskkill /T
    // also reaps helpers the runtime spawned.
    if (process.platform === 'win32' && child.pid) {
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => {});
        killer.unref?.();
      } catch {
        // taskkill is unavailable; the direct kill above already ran.
      }
    }
  }

  async stopRuntime(record, { graceMs = 0 } = {}) {
    if (!record) return;
    if (record.exited) {
      record.resolveStop?.();
      this.runtimes.delete(record);
      return;
    }
    record.stopping = true;
    try {
      record.child.stdin.end();
    } catch {
      // stdin may already be closed.
    }
    if (graceMs > 0) {
      const exited = await Promise.race([
        record.stopPromise.then(() => true),
        sleep(graceMs).then(() => false),
      ]);
      if (exited) {
        this.runtimes.delete(record);
        return;
      }
    }
    this.forceKill(record.child);
    await Promise.race([record.stopPromise, sleep(Math.max(this.killGraceMs, 1000))]);
    if (!record.exited && isAlive(record.child.pid)) {
      this.log(`runtime generation ${record.generation} did not exit after kill`);
    }
    if (record.exited) this.runtimes.delete(record);
  }

  spawnRuntime(target) {
    if (this.closing) throw new Error('agent-teams shell is closing');
    const workspace = this.resolveWorkspacePath();
    const child = spawn(process.execPath, [target.entry], {
      cwd: workspace,
      env: { ...process.env, ...this.runtimeEnv, CLAUDE_PROJECT_DIR: workspace },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const record = this.createRuntimeRecord(child, target, workspace);
    this.attachRuntimeStreams(record);
    this.runtimes.add(record);
    this.log(`spawned runtime ${record.version} (generation ${record.generation}) from ${target.entry} in ${workspace}`);
    return record;
  }

  createRuntimeRecord(child, target, workspace) {
    const record = {
      generation: (this.generation += 1),
      child,
      target,
      version: target.version,
      entry: target.entry,
      key: target.key,
      workspace,
      exited: false,
      exitInfo: null,
      stopping: false,
      ...this.protocol.createRuntimeState(),
      stabilityCleared: false,
      stableTimer: null,
      resolveStop: null,
      stopPromise: null,
    };
    record.stopPromise = new Promise((resolvePromise) => {
      record.resolveStop = resolvePromise;
    });
    return record;
  }

  attachRuntimeStreams(record) {
    const { child } = record;
    child.stdin.on('error', () => {});
    let lineChunks = [];
    let lineBytes = 0;
    let droppingLine = false;
    let pendingCR = false;
    const resetLine = () => {
      lineChunks = [];
      lineBytes = 0;
      pendingCR = false;
    };
    const appendLineBytes = (bytes) => {
      if (bytes.length === 0) return true;
      if (lineBytes + bytes.length > MAX_RUNTIME_LINE_BYTES) {
        this.log(`runtime generation ${record.generation} produced an oversized stdout line (${lineBytes + bytes.length} bytes); dropping it`);
        resetLine();
        droppingLine = true;
        return false;
      }
      lineChunks.push(bytes);
      lineBytes += bytes.length;
      return true;
    };
    const finishLine = () => {
      const line = Buffer.concat(lineChunks, lineBytes).toString('utf8').trim();
      resetLine();
      if (line) this.protocol.handleRuntimeLine(record, line);
    };
    child.stdout.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        if (droppingLine) {
          const newline = bytes.indexOf(0x0a, offset);
          if (newline === -1) return;
          droppingLine = false;
          resetLine();
          offset = newline + 1;
          continue;
        }
        if (pendingCR) {
          if (bytes[offset] === 0x0a) {
            finishLine();
            offset += 1;
            continue;
          }
          if (!appendLineBytes(Buffer.from([0x0d]))) continue;
          pendingCR = false;
        }
        const newline = bytes.indexOf(0x0a, offset);
        const carriageReturn = bytes.indexOf(0x0d, offset);
        const boundary = newline === -1 ? carriageReturn
          : carriageReturn === -1 ? newline : Math.min(newline, carriageReturn);
        if (boundary === -1) {
          appendLineBytes(bytes.subarray(offset));
          return;
        }
        if (!appendLineBytes(bytes.subarray(offset, boundary))) {
          offset = boundary;
          continue;
        }
        offset = boundary + 1;
        if (bytes[boundary] === 0x0a) {
          finishLine();
        } else {
          pendingCR = true;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      try {
        process.stderr.write(chunk);
      } catch {
        // Best-effort log forwarding.
      }
    });
    child.on('error', (error) => {
      record.exitInfo = record.exitInfo ?? { error: error.message };
      this.finishRecord(record);
    });
    child.on('exit', (code, signal) => {
      record.exitInfo = record.exitInfo ?? { code, signal };
      this.finishRecord(record);
    });
  }

  async startRuntime(target) {
    const record = this.spawnRuntime(target);
    try {
      await this.protocol.warmRuntime(record);
      return record;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await this.stopRuntime(record, { graceMs: 0 });
      throw new Error(`runtime ${target.version} warm-up failed: ${text}`);
    }
  }

  scheduleRestart(reason, crashAttempt = 0) {
    if (this.closing || this.restartTimer || this.restartStopped) return;
    // Consecutive crashes of the same target drive the backoff too.
    // restartAttempts only counts failed restarts and resets after every
    // successful spawn, so on its own it would keep a crash loop at the base
    // delay; crashCounts survives until the runtime proves stable again.
    const attempts = Math.max(this.restartAttempts, crashAttempt);
    const delay = Math.min(this.restartDelayMs * (2 ** attempts), this.maxRestartDelayMs);
    this.log(`restarting runtime in ${delay}ms after ${reason}`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void (async () => {
        if (this.closing || (this.current && !this.current.exited)) return;
        try {
          const record = await this.ensureRuntime();
          if (record.exited) throw new Error('runtime exited during restart');
          this.restartAttempts = 0;
        } catch (error) {
          this.restartAttempts += 1;
          this.log(`runtime restart failed: ${error instanceof Error ? error.message : String(error)}`);
          this.scheduleRestart('previous restart failure');
        }
      })();
    }, delay);
    this.restartTimer.unref?.();
  }

  async ensureRuntime() {
    if (this.current && !this.current.exited) return this.current;
    if (this.closing) throw new Error('agent-teams shell is closing');
    if (this.restartStopped) {
      throw new Error(this.lastRuntimeError ?? 'agent-teams runtime is not running and automatic restarts are stopped');
    }
    if (this.spawnPromise) return this.spawnPromise;
    this.spawnPromise = this.startColdRuntime();
    try {
      return await this.spawnPromise;
    } finally {
      this.spawnPromise = null;
    }
  }

  async startColdRuntime() {
    const target = await this.selectColdTarget();
    const record = await this.startWithFallback(target);
    if (this.closing) {
      await this.stopRuntime(record, { graceMs: 0 });
      throw new Error('agent-teams shell is closing');
    }
    if (this.current && !this.current.exited) {
      // Another spawn won the race (for example a switch finished while the
      // pointer was being read); reuse it and drop this duplicate.
      await this.stopRuntime(record, { graceMs: 0 });
      return this.current;
    }
    this.current = record;
    this.lastRuntimeError = null;
    this.restartAttempts = 0;
    this.scheduleStability(record);
    if (this.protocol.cachedInitParams) {
      // The host handshake already happened before an earlier switch or
      // crash, so runtime notifications can go out immediately.
      this.protocol.flushBufferedNotifications(record);
    }
    return record;
  }

  async selectColdTarget() {
    let target;
    try {
      target = await this.targets.resolveRuntimeTarget();
    } catch (error) {
      // An unusable pointer must not brick the MCP server: fall back to the
      // packaged runtime and keep the error visible.
      target = this.targets.fallbackTarget();
      const message = error instanceof Error ? error.message : String(error);
      this.lastSwitchError = { at: Date.now(), message, fallback: target.entry };
      this.log(`runtime pointer is unusable (${message}); using the packaged runtime ${target.entry}`);
    }
    if (this.forceFallback && target.source !== 'fallback') {
      this.log(`using the packaged runtime after ${this.crashCounts.get(target.key) ?? this.maxConsecutiveCrashes} consecutive crash(es)`);
      target = this.targets.fallbackTarget();
    }
    return target;
  }

  async startWithFallback(target) {
    let record;
    try {
      record = await this.startRuntime(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastSwitchError = { at: Date.now(), message, version: target.version, entry: target.entry };
      if (target.source === 'fallback') {
        this.lastRuntimeError = `packaged runtime failed to start: ${message}`;
        throw new Error(this.lastRuntimeError);
      }
      const fallback = this.targets.fallbackTarget();
      this.log(`pointer runtime ${target.version} failed its cold-start warm-up (${message}); falling back to ${fallback.entry}`);
      try {
        record = await this.startRuntime(fallback);
      } catch (fallbackError) {
        this.lastRuntimeError = `packaged runtime failed to start after ${target.version} warm-up failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
        throw new Error(this.lastRuntimeError);
      }
    }
    return record;
  }

  recordSwitchFailure(previous, target, error) {
    const text = error instanceof Error ? error.message : String(error);
    this.lastSwitchError = {
      at: Date.now(),
      message: text,
      ...(target ? { version: target.version, entry: target.entry } : {}),
    };
    this.log(`runtime switch to ${target?.version ?? 'pointer fallback'} failed, keeping ${previous?.version ?? 'the current runtime'}: ${text}`);
    return { switched: false, error: text, version: previous?.version ?? null };
  }

  async performReload(force) {
    if (this.closing) return { switched: false, reason: 'closing' };
    let target;
    try {
      target = await this.targets.resolveRuntimeTarget();
    } catch (error) {
      const previous = this.current && !this.current.exited ? this.current : null;
      return this.recordSwitchFailure(previous, null, error);
    }
    const previous = this.current && !this.current.exited ? this.current : null;
    if (!force && previous && previous.key === target.key) {
      return { switched: false, reason: 'unchanged', version: previous.version };
    }
    let candidate;
    try {
      candidate = this.spawnRuntime(target);
    } catch (error) {
      return this.recordSwitchFailure(previous, target, error);
    }
    const initParamsSnapshot = this.protocol.cachedInitParams;
    try {
      await this.protocol.warmRuntime(candidate);
      // `initialize` is serialized with the switch chain, so this should not
      // change mid-switch. Re-warm anyway: publishing a runtime warmed with
      // stale client parameters would break the host handshake contract.
      if (this.protocol.cachedInitParams !== initParamsSnapshot) await this.protocol.warmRuntime(candidate);
    } catch (error) {
      this.protocol.dropBufferedNotifications(candidate, 'candidate runtime failed its health check');
      await this.stopRuntime(candidate, { graceMs: 0 });
      return this.recordSwitchFailure(previous, target, error);
    }
    if (this.closing) {
      this.protocol.dropBufferedNotifications(candidate, 'shell closed during the switch');
      await this.stopRuntime(candidate, { graceMs: 0 });
      return { switched: false, reason: 'closing' };
    }
    if (candidate.exited) {
      this.protocol.dropBufferedNotifications(candidate, 'candidate runtime exited during the switch');
      await this.stopRuntime(candidate, { graceMs: 0 });
      return this.recordSwitchFailure(previous, target, new Error('candidate runtime exited during the switch'));
    }
    return this.publishCandidate(previous, candidate);
  }

  publishCandidate(previous, candidate) {
    const displaced = this.current && this.current !== previous && !this.current.exited ? this.current : null;
    this.current = candidate;
    this.protocol.publishRuntime(candidate);
    if (displaced) {
      this.protocol.dropBufferedNotifications(displaced, 'runtime was displaced by a parallel spawn');
      this.retiring.add(displaced);
      void this.drainAndStop(displaced);
    }
    if (previous) {
      this.protocol.dropBufferedNotifications(previous, 'runtime was replaced by a hot update');
      this.retiring.add(previous);
      void this.drainAndStop(previous);
    }
    this.protocol.flushBufferedNotifications(candidate);
    const previousVersion = previous?.version ?? null;
    this.lastSwitchError = null;
    this.lastRuntimeError = null;
    this.crashCounts.clear();
    this.forceFallback = false;
    this.restartStopped = false;
    // A displaced runtime (spawn race) may already have served host requests,
    // so the host needs the same tool-list refresh signal.
    if (previous || displaced) {
      if (candidate.declaresTools) {
        this.protocol.emitNotification({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      } else {
        this.log(`runtime ${candidate.version} has no tools capability; skipped notifications/tools/list_changed`);
      }
    }
    this.log(`runtime switched ${previousVersion ?? 'none'} -> ${candidate.version} (generation ${candidate.generation})`);
    return {
      switched: true,
      version: candidate.version,
      previousVersion,
      generation: candidate.generation,
    };
  }

  enqueue(task) {
    this.switchRunning += 1;
    const running = this.switchChain.then(task);
    this.switchChain = running.then(() => undefined, () => undefined);
    return running.finally(() => {
      this.switchRunning -= 1;
    });
  }

  reload({ force = false } = {}) {
    return this.enqueue(() => this.performReload(force));
  }

  async drainAndStop(record) {
    const deadline = Date.now() + this.drainTimeoutMs;
    while (this.protocol.pendingCount(record) > 0 && !record.exited && Date.now() < deadline) {
      await sleep(10);
    }
    if (this.protocol.pendingCount(record) > 0) {
      // Settle the requests before killing the child: once the child is gone
      // the caller must still receive a deterministic JSON-RPC error. The
      // message says "drain timeout" so the host can tell it apart from a
      // crash.
      this.log(`runtime generation ${record.generation} still has ${this.protocol.pendingCount(record)} in-flight request(s) after ${this.drainTimeoutMs}ms; failing them with a drain timeout`);
      this.protocol.failPending(record, `agent-teams runtime drain timeout after ${this.drainTimeoutMs}ms`);
    }
    await this.stopRuntime(record, { graceMs: this.protocol.pendingCount(record) === 0 ? this.killGraceMs : 0 });
    if (this.protocol.pendingCount(record) > 0) {
      this.protocol.failPending(record, 'drain timeout');
    }
    this.protocol.clearBufferedNotifications(record);
    if (!record.exited) {
      this.log(`warning: runtime generation ${record.generation} (pid ${record.child.pid ?? 'unknown'}) is still alive after the drain timeout and kill; removing it from tracking`);
      this.runtimes.delete(record);
    }
    this.retiring.delete(record);
  }

  noteHostRequestServed(record, response) {
    if (record && response && !response.error) this.markStable(record);
  }

  async forwardInitialize(message) {
    const record = await this.ensureRuntime();
    const response = await this.protocol.sendRequest(record, message);
    if (!response.error) {
      this.protocol.acceptInitialize(message, response);
      this.noteHostRequestServed(record, response);
      // The cold-start warm-up ran before the host handshake; hold its
      // notifications until the host has actually initialized.
      if (record === this.current) this.protocol.flushBufferedNotifications(record);
      return { ...response, result: this.protocol.cachedInitResult };
    }
    return response;
  }

  async dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
    }
    const method = message.method;
    if (typeof method !== 'string' || !method) {
      // A message without a method is a response. Only runtime -> host
      // requests we forwarded have a matching id.
      if (message.id !== undefined) this.protocol.routeHostResponse(message);
      return null;
    }
    if (message.id === undefined) {
      if (method.startsWith('notifications/')) this.protocol.forwardHostNotification(message);
      return null;
    }
    if (this.closing) return errorResponse(message, 'agent-teams shell is closing');
    if (method === 'initialize') {
      // Serialize the host handshake with hot switches: publishing a runtime
      // while an initialize is in flight would return a response from the old
      // generation and then immediately replace it.
      return this.enqueue(() => this.forwardInitialize(message));
    }
    const record = await this.ensureRuntime();
    if (method === 'tools/list') {
      const response = await this.protocol.sendRequest(record, message);
      this.protocol.cacheTools(response);
      this.noteHostRequestServed(record, response);
      return response;
    }
    const response = await this.protocol.sendRequest(record, message);
    this.noteHostRequestServed(record, response);
    return response;
  }

  async handleMessage(message) {
    try {
      return await this.dispatch(message);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.log(`request failed: ${text}`);
      return errorResponse(message, text);
    }
  }

  async whenIdle() {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      if (this.switchRunning === 0 && this.retiring.size === 0 && !this.spawnPromise && !this.watcher.pointerDebounce) return;
      await Promise.race([
        Promise.allSettled([
          this.switchChain,
          ...[...this.retiring].map((record) => record.stopPromise),
        ]),
        sleep(20),
      ]);
    }
    throw new Error('agent-teams shell did not become idle');
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closing = true;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.watcher.stopWatching();
      const records = [...this.runtimes];
      this.current = null;
      this.retiring.clear();
      await Promise.all(records.map((record) => this.stopRuntime(record, { graceMs: this.killGraceMs })));
      this.protocol.closeRequests();
    })();
    return this.closePromise;
  }

  status() {
    return {
      pluginRoot: this.pluginRoot,
      pointerPath: this.pointerPath,
      workspace: this.lastWorkspace,
      watching: this.watcher.watching,
      current: this.current
        ? {
          generation: this.current.generation,
          version: this.current.version,
          entry: this.current.entry,
          originalEntry: this.current.target.originalEntry ?? this.current.target.entry,
          source: this.current.target.source,
          declaresTools: this.current.declaresTools,
          pending: this.protocol.pendingCount(this.current),
          droppedNotifications: this.current.droppedNotifications,
          pid: this.current.child.pid ?? null,
          exited: this.current.exited,
        }
        : null,
      retiring: [...this.retiring].map((record) => ({
        generation: record.generation,
        version: record.version,
        pending: this.protocol.pendingCount(record),
        pid: record.child.pid ?? null,
      })),
      tools: this.protocol.cachedTools ? this.protocol.cachedTools.map((tool) => tool.name) : null,
      cachedInitResult: this.protocol.cachedInitResult ?? null,
      lastSwitchError: this.lastSwitchError,
      lastRuntimeError: this.lastRuntimeError,
      forceFallback: this.forceFallback,
      restartStopped: this.restartStopped,
      crashCounts: Object.fromEntries(this.crashCounts),
      droppedNotifications: this.protocol.droppedNotifications,
      droppedHostNotifications: this.protocol.droppedHostNotifications,
      hostRequests: this.protocol.hostRequests.size,
    };
  }
}
