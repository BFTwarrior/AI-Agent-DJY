import { runtimeError } from './support.mjs';

const NOTIFICATION_BUFFER_LIMIT = 100;
const MAX_PENDING_HOST_REQUESTS = 1000;
function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

function pendingKey(record, id) {
  return `${record.generation}:${idKey(id)}`;
}

function withListChangedCapability(result) {
  if (!result || typeof result !== 'object') return result;
  const capabilities = result.capabilities;
  if (!capabilities || typeof capabilities !== 'object') return result;
  const toolsCapability = capabilities.tools;
  if (!toolsCapability || typeof toolsCapability !== 'object') return result;
  return { ...result, capabilities: { ...capabilities, tools: { ...toolsCapability, listChanged: true } } };
}

// Sole owner of both request tables, handshake caches and notification counters.
// routing is a read-only lifecycle port, not a copy of runtime membership.
export class ShellProtocol {
  constructor({ routing, onNotification, onHostRequest, log, hostRequestTimeoutMs, healthTimeoutMs, packageVersion }) {
    this.routing = routing;
    this.onNotification = onNotification;
    this.onHostRequest = onHostRequest;
    this.log = log;
    this.hostRequestTimeoutMs = hostRequestTimeoutMs;
    this.healthTimeoutMs = healthTimeoutMs;
    this.packageVersion = packageVersion;
    this.pending = new Map();
    this.pendingRequestIds = new Map();
    this.hostRequests = new Map();
    this.hostRequestResponses = new Map();
    this.internalId = 0;
    this.cachedInitParams = undefined;
    this.cachedInitResult = undefined;
    this.cachedTools = undefined;
    this.droppedNotifications = 0;
    this.droppedHostNotifications = 0;
  }

  // Runtime records carry only a count for drain/status. Request membership
  // remains solely in this.pending, and this protocol owns count mutations.
  createRuntimeState() {
    return {
      pendingRequestCount: 0,
      notificationBuffer: [],
      droppedNotifications: 0,
      initResult: null,
      tools: null,
      declaresTools: false,
    };
  }

  clearBufferedNotifications(record) {
    record.notificationBuffer = [];
  }

  pendingCount(record) {
    return record.pendingRequestCount;
  }

  removePending(key, entry) {
    if (!this.pending.delete(key)) return false;
    entry.record.pendingRequestCount -= 1;
    const requestKey = idKey(entry.id);
    const count = this.pendingRequestIds.get(requestKey) ?? 0;
    if (count <= 1) this.pendingRequestIds.delete(requestKey);
    else this.pendingRequestIds.set(requestKey, count - 1);
    return true;
  }

  emitNotification(message, { allowClosing = false } = {}) {
    if (this.routing.isClosing() && !allowClosing) return;
    try {
      this.onNotification(message);
    } catch (error) {
      this.log(`notification sink failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  nextInternalId(prefix) {
    this.internalId += 1;
    return `shell:${prefix}:${this.internalId}`;
  }

  defaultInitParams() {
    return {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ai-agent-teams-shell', version: this.packageVersion },
    };
  }

  failPending(record, message) {
    for (const [key, entry] of [...this.pending]) {
      if (entry.record !== record) continue;
      this.removePending(key, entry);
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(runtimeError(entry.id, message));
    }
  }

  cancelHostRequest(entry, reason, { allowClosing = false } = {}) {
    this.emitNotification({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: entry.wireId, reason },
    }, { allowClosing });
  }

  failHostRequests(record, message) {
    for (const [, entry] of [...this.hostRequests]) {
      if (entry.record !== record) continue;
      this.removeHostRequest(entry);
      this.log(`dropped in-flight runtime->host request ${String(entry.id)}: ${message}`);
      this.cancelHostRequest(entry, message, { allowClosing: true });
    }
  }

  recordNotificationDrop(record, source) {
    record.droppedNotifications += 1;
    this.droppedNotifications += 1;
    // Log the first drop and then every hundredth to keep a chatty runtime from
    // flooding the log while still making the loss visible.
    if (record.droppedNotifications === 1 || record.droppedNotifications % 100 === 0) {
      this.log(`dropped ${source} notification from runtime generation ${record.generation} (${record.droppedNotifications} dropped so far)`);
    }
  }

  dropBufferedNotifications(record, reason) {
    const dropped = record.notificationBuffer.length;
    if (dropped === 0) return;
    record.notificationBuffer = [];
    record.droppedNotifications += dropped;
    this.droppedNotifications += dropped;
    this.log(`dropped ${dropped} buffered notification(s) from runtime generation ${record.generation}: ${reason}`);
  }

  sendRuntimeMessage(record, message) {
    if (!record || record.exited || record.stopping) return false;
    try {
      record.child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  handleRuntimeRequest(record, message) {
    if (!record || this.routing.isClosing() || record.exited || record.stopping) return;
    if (!['string', 'number'].includes(typeof message.id)
      || (typeof message.id === 'number' && !Number.isFinite(message.id))) {
      this.log(`runtime generation ${record.generation} sent a request with an invalid id; replying -32600`);
      this.sendRuntimeMessage(record, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'server-to-client requests must carry a string or number id' },
      });
      return;
    }
    if (record !== this.routing.current() && !this.routing.isRetiring(record)) {
      this.log(`runtime generation ${record.generation} sent ${message.method} before it became current; replying -32601`);
      this.sendRuntimeMessage(record, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'runtime is not current; server-to-client requests are not forwarded' },
      });
      return;
    }
    if (!this.onHostRequest) {
      this.log(`runtime generation ${record.generation} sent ${message.method} id=${String(message.id)} but no host request channel is configured; replying -32601`);
      this.sendRuntimeMessage(record, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'server-to-client requests are not supported by this shell host channel' },
      });
      return;
    }
    const key = pendingKey(record, message.id);
    if (this.hostRequests.has(key)) {
      this.log(`runtime generation ${record.generation} reused in-flight request id ${String(message.id)}; replying -32600`);
      this.sendRuntimeMessage(record, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32600, message: 'duplicate in-flight server-to-client request id' },
      });
      return;
    }
    if (this.hostRequests.size >= MAX_PENDING_HOST_REQUESTS) {
      this.sendRuntimeMessage(record, runtimeError(message.id, 'host request capacity is full'));
      return;
    }
    let wireId;
    do {
      wireId = this.nextInternalId('host');
    } while (this.pendingRequestIds.has(idKey(wireId)));
    const entry = {
      record, id: message.id, key, wireId, wireKey: idKey(wireId), message, timer: null,
    };
    this.hostRequests.set(key, entry);
    this.hostRequestResponses.set(entry.wireKey, entry);
    this.startHostRequestTimer(entry);
    this.activateHostRequest(entry);
  }

  startHostRequestTimer(entry) {
    if (!(this.hostRequestTimeoutMs > 0)) return;
    entry.deadline = Date.now() + this.hostRequestTimeoutMs;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.expireHostRequest(entry);
    }, this.hostRequestTimeoutMs);
    entry.timer.unref?.();
  }

  expireHostRequest(entry) {
    if (this.hostRequests.get(entry.key) !== entry) return;
    this.removeHostRequest(entry);
    const reason = `runtime->host request timed out after ${this.hostRequestTimeoutMs}ms`;
    this.log(`${reason}: ${String(entry.id)} (${entry.message.method})`);
    this.cancelHostRequest(entry, reason, { allowClosing: true });
    this.sendRuntimeMessage(entry.record, {
      jsonrpc: '2.0',
      id: entry.id,
      error: { code: -32603, message: `host did not answer within ${this.hostRequestTimeoutMs}ms` },
    });
  }

  activateHostRequest(entry) {
    if (!this.hostRequests.has(entry.key)) return;
    if (entry.record.exited || entry.record.stopping) {
      this.removeHostRequest(entry);
      return;
    }
    if (entry.deadline !== undefined && entry.deadline <= Date.now()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      this.expireHostRequest(entry);
      return;
    }
    try {
      const result = this.onHostRequest({ ...entry.message, id: entry.wireId });
      if (result && typeof result.then === 'function') {
        result.catch((error) => this.failHostRequestForward(entry, error));
      }
    } catch (error) {
      this.failHostRequestForward(entry, error);
    }
  }

  failHostRequestForward(entry, error) {
    if (this.hostRequests.get(entry.key) !== entry) return;
    this.removeHostRequest(entry);
    this.log(`forwarding runtime->host request failed: ${error instanceof Error ? error.message : String(error)}`);
    this.sendRuntimeMessage(entry.record, runtimeError(entry.id, 'failed to forward the request to the host'));
  }

  removeHostRequest(entry) {
    if (!this.hostRequests.delete(entry.key)) return false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.hostRequestResponses.delete(entry.wireKey);
    return true;
  }

  routeHostResponse(message) {
    const wireKey = idKey(message.id);
    const entry = this.hostRequestResponses.get(wireKey);
    if (!entry) {
      this.log(`ignored host response for unknown runtime request id=${String(message.id)}`);
      return;
    }
    this.removeHostRequest(entry);
    if (entry.record.exited || entry.record.stopping) {
      this.log(`dropped host response for runtime request id=${String(message.id)}: runtime is gone`);
    } else {
      this.sendRuntimeMessage(entry.record, { ...message, id: entry.id });
    }
  }

  handleRuntimeLine(record, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log(`ignored non-JSON runtime output: ${line.slice(0, 200)}`);
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        // A message with both `method` and `id` is a runtime -> host request,
        // not a response to one of our requests.
        this.handleRuntimeRequest(record, message);
        return;
      }
      // Retiring runtimes still serve in-flight requests; forward their
      // progress/log notifications instead of buffering them away. Cancellation
      // notifications are always resolved against this protocol's mapping so
      // stale generations cannot leak an original or guessed request ID.
      if (message.method === 'notifications/cancelled'
        || record === this.routing.current() || this.routing.isRetiring(record)) {
        this.forwardRuntimeNotification(record, message);
      } else if (record.notificationBuffer.length < NOTIFICATION_BUFFER_LIMIT) record.notificationBuffer.push(message);
      else this.recordNotificationDrop(record, 'buffered');
      return;
    }
    if (message.id === undefined) {
      this.log(`ignored runtime output without an id or method: ${line.slice(0, 200)}`);
      return;
    }
    const key = pendingKey(record, message.id);
    const entry = this.pending.get(key);
    if (!entry || entry.record !== record) {
      this.log(`dropped late runtime response id=${String(message.id)}`);
      return;
    }
    this.removePending(key, entry);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(message);
  }

  forwardRuntimeNotification(record, message) {
    if (message.method === 'notifications/cancelled') {
      const requestId = message.params?.requestId;
      if (requestId === undefined) {
        this.log('dropped runtime cancellation without a request id');
        return;
      }
      const entry = this.hostRequests.get(pendingKey(record, requestId));
      if (entry) {
        this.removeHostRequest(entry);
        return this.emitNotification({
          ...message,
          params: { ...message.params, requestId: entry.wireId },
        });
      }
      this.log(`dropped runtime cancellation for unknown host request id=${String(requestId)}`);
      return;
    }
    return this.emitNotification(message);
  }

  sendNotification(record, message) {
    return this.sendRuntimeMessage(record, message);
  }

  sendRequest(record, message, { timeoutMs } = {}) {
    return new Promise((resolvePromise) => {
      if (!record || record.exited || record.stopping) {
        resolvePromise(runtimeError(message.id, 'agent-teams runtime is not available'));
        return;
      }
      const key = pendingKey(record, message.id);
      if (this.pending.has(key)) {
        resolvePromise(runtimeError(message.id, 'duplicate in-flight request id'));
        return;
      }
      if (this.hostRequestResponses.has(idKey(message.id))) {
        resolvePromise(runtimeError(message.id, 'request id conflicts with an in-flight host request'));
        return;
      }
      const entry = { record, id: message.id, resolve: resolvePromise, timer: null };
      this.pending.set(key, entry);
      const requestKey = idKey(message.id);
      this.pendingRequestIds.set(requestKey, (this.pendingRequestIds.get(requestKey) ?? 0) + 1);
      record.pendingRequestCount += 1;
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.removePending(key, entry)) return;
          resolvePromise(runtimeError(message.id, `runtime did not answer within ${timeoutMs}ms`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      try {
        record.child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        if (entry.timer) clearTimeout(entry.timer);
        this.removePending(key, entry);
        resolvePromise(runtimeError(message.id, `failed to write to runtime: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  flushBufferedNotifications(record) {
    const buffered = record.notificationBuffer.splice(0);
    for (const message of buffered) this.emitNotification(message);
    if (record.droppedNotifications > 0) {
      this.log(`runtime generation ${record.generation} had dropped ${record.droppedNotifications} notification(s) before it was published`);
    }
  }

  forwardHostNotification(message) {
    // A cancellation belongs to the runtime that owns the request, which may be
    // a retiring runtime after a hot switch. A notification without a matching
    // in-flight request falls through to the current runtime.
    if (message.method === 'notifications/cancelled') {
      const requestId = message.params?.requestId;
      if (requestId !== undefined) {
        const owners = [...this.pending.values()].filter((entry) => idKey(entry.id) === idKey(requestId));
        if (owners.length > 0) {
          for (const entry of owners) this.sendNotification(entry.record, message);
          return;
        }
        const hostRequest = this.hostRequestResponses.get(idKey(requestId));
        if (hostRequest) {
          this.removeHostRequest(hostRequest);
          if (!hostRequest.record.exited && !hostRequest.record.stopping) {
            this.sendNotification(hostRequest.record, {
              ...message,
              params: { ...message.params, requestId: hostRequest.id },
            });
          }
          return;
        }
        this.droppedHostNotifications += 1;
        this.log(`dropped host cancellation for unknown request id=${String(requestId)} (${this.droppedHostNotifications} dropped so far)`);
        return;
      }
      this.droppedHostNotifications += 1;
      this.log(`dropped host cancellation without request id (${this.droppedHostNotifications} dropped so far)`);
      return;
    }
    // The host only sends `notifications/initialized` after it received the
    // initialize response, so a live runtime already exists here. Dropping a
    // notification while no runtime exists is safer than replaying it before
    // initialize, but the drop is counted and logged.
    if (this.routing.current() && !this.routing.current().exited) {
      this.sendNotification(this.routing.current(), message);
      return;
    }
    this.droppedHostNotifications += 1;
    this.log(`dropped host notification ${message.method}: no runtime is running (${this.droppedHostNotifications} dropped so far)`);
  }

  async warmRuntime(record) {
    const params = this.cachedInitParams ?? this.defaultInitParams();
    const init = await this.sendRequest(record, {
      jsonrpc: '2.0', id: this.nextInternalId('initialize'), method: 'initialize', params,
    }, { timeoutMs: this.healthTimeoutMs });
    if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
    this.sendNotification(record, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await this.sendRequest(record, {
      jsonrpc: '2.0', id: this.nextInternalId('tools'), method: 'tools/list',
    }, { timeoutMs: this.healthTimeoutMs });
    if (list.error) throw new Error(`tools/list failed: ${list.error.message}`);
    record.initResult = withListChangedCapability(init.result);
    record.tools = list.result?.tools ?? [];
    record.declaresTools = Boolean(init.result?.capabilities?.tools);
    if (!record.declaresTools) {
      this.log(`runtime ${record.version} does not declare capabilities.tools; tools/list_changed is not advertised for it`);
    }
    return { init, list };
  }

  acceptInitialize(message, response) {
    this.cachedInitParams = message.params ?? {};
    this.cachedInitResult = withListChangedCapability(response.result);
  }

  cacheTools(response) {
    if (response.result) this.cachedTools = response.result.tools ?? [];
  }

  publishRuntime(candidate) {
    if (candidate.tools) this.cachedTools = candidate.tools;
    if (this.cachedInitParams && candidate.initResult) this.cachedInitResult = candidate.initResult;
  }

  closeRequests() {
    for (const [key, entry] of [...this.pending]) {
      this.removePending(key, entry);
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(runtimeError(entry.id, 'agent-teams shell closed'));
    }
    for (const [, entry] of [...this.hostRequests]) {
      this.removeHostRequest(entry);
      this.cancelHostRequest(entry, 'agent-teams shell closed', { allowClosing: true });
    }
  }
}
