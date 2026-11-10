/**
 * Session adapter contract. The daemon talks to ZCode sessions through this
 * interface; tests use FakeSessionAdapter.
 */
export class SessionAdapter {
  /**
   * Whether this adapter can hot-switch an existing session's model. The
   * watcher treats an unsupported adapter as "nothing to apply" instead of a
   * failure, so a CLI/container deployment cannot spin in a retry loop.
   */
  get supportsModelSwitch() { return this._supportsModelSwitch ?? true; }
  set supportsModelSwitch(value) { this._supportsModelSwitch = Boolean(value); }
  async create(_input) { throw new Error('not implemented'); }
  async send(_input) { throw new Error('not implemented'); }
  async stop(_input) { throw new Error('not implemented'); }
  async setModel(_input) { throw new Error('not implemented'); }
  async compact(_input) { return { ok: false, warning: 'compact not supported' }; }
  async resume(_input) { return { ok: false, warning: 'resume not supported' }; }
  async close(_input) { return { ok: true }; }
  /**
   * Contract for contractor cleanup: return `{ verified, sessionId,
   * sideEffectsRevoked }`. The default refuses to claim proof so an adapter
   * that forgets to implement it keeps the contractor slot instead of
   * silently freeing it.
   */
  async verifySessionTermination({ sessionId } = {}) {
    return { verified: false, sessionId, sideEffectsRevoked: false, warning: 'termination verification is not implemented' };
  }
  async probe() { return { methods: [], warnings: ['no probe implemented'] }; }
}

/**
 * Deterministic adapter for tests and local dry runs.
 * `handler` receives every send and may update the store to simulate work.
 */
export class FakeSessionAdapter extends SessionAdapter {
  constructor({ handler } = {}) {
    super();
    this.kind = 'fake';
    this.supportsModelSwitch = true;
    this.handler = handler;
    this.calls = [];
    this.sessions = new Map();
    this.closedSessions = new Set();
    this.activeSends = new Map();
    this.counter = 0;
  }

  async create(input) {
    const sessionId = `sess_fake_${this.counter += 1}`;
    const record = { sessionId, ...input, status: 'idle' };
    this.sessions.set(sessionId, record);
    this.calls.push({ kind: 'create', sessionId, input });
    return { sessionId, response: 'created', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async send(input) {
    this.calls.push({ kind: 'send', input });
    const session = this.sessions.get(input.sessionId);
    if (!session) return { ok: false, warning: 'unknown session' };
    this.activeSends.set(input.sessionId, (this.activeSends.get(input.sessionId) ?? 0) + 1);
    try {
      const result = this.handler === undefined
        ? { response: 'ok', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
        : await this.handler({ ...input, session });
      return { ok: true, response: result?.response ?? 'ok', usage: result?.usage, warning: result?.warning };
    } finally {
      this.activeSends.set(input.sessionId, this.activeSends.get(input.sessionId) - 1);
    }
  }

  async stop(input) {
    this.calls.push({ kind: 'stop', input });
    const session = this.sessions.get(input.sessionId);
    if (session) session.status = 'stopped';
    return { ok: true };
  }

  async setModel(input) {
    this.calls.push({ kind: 'setModel', input });
    const session = this.sessions.get(input.sessionId);
    if (session) session.model = input.model;
    return { ok: true };
  }

  async compact(input) {
    this.calls.push({ kind: 'compact', input });
    return { ok: true, warning: 'fake compact' };
  }

  async resume(input) {
    this.calls.push({ kind: 'resume', input });
    const session = this.sessions.get(input.sessionId);
    if (!session) return { ok: false, warning: 'unknown session' };
    session.status = 'idle';
    return { ok: true, sessionId: input.sessionId };
  }

  async close(input) {
    if (this.sessions.delete(input.sessionId)) this.closedSessions.add(input.sessionId);
    return { ok: true };
  }

  async verifySessionTermination({ sessionId }) {
    const verified = this.closedSessions.has(sessionId) && !this.sessions.has(sessionId)
      && (this.activeSends.get(sessionId) ?? 0) === 0;
    return { verified, sessionId, sideEffectsRevoked: verified };
  }

  async probe() {
    return { version: 'fake', methods: ['session/create', 'session/send', 'session/stop', 'session/setModel', 'session/compact', 'session/resume', 'guide'], warnings: [] };
  }
}
