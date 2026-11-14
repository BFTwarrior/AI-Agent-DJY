import { resolveConfig } from './config.mjs'
import { isModelRequest, isNetworkError, retryAfter, retryDecision } from './policy.mjs'
import { cancelReader, inspectResponse } from './probe.mjs'

function sleepChunk(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const done = () => { signal.removeEventListener('abort', aborted); resolve() }
    const timer = setTimeout(done, ms)
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
  })
}

export async function sleep(ms, signal) {
  let remaining = ms
  do {
    const chunk = Math.min(remaining, 2147483647)
    await sleepChunk(chunk, signal)
    remaining -= chunk
  } while (remaining > 0)
}

function copyBody(input, init, max) {
  // Streaming Request bodies cannot be safely cloned without an unbounded tee.
  const body = init?.body
  if (body === undefined && input instanceof Request && input.body) return undefined
  if (body == null) return { body }
  if (typeof body === 'string') return Buffer.byteLength(body) <= max ? { body } : undefined
  if (body instanceof URLSearchParams) { const value = body.toString(); return Buffer.byteLength(value) <= max ? { body: new URLSearchParams(value) } : undefined }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    return bytes.byteLength <= max ? { body: bytes.slice() } : undefined
  }
  return undefined
}

export function createRetryFetch(originalFetch, rawConfig = {}, options = {}) {
  const config = resolveConfig(rawConfig), now = options.now ?? Date.now, wait = options.sleep ?? sleep
  const unlimited = config.mode === 'unlimited'
  // always mode is bounded by attempt count, not by time, so it can honor a
  // longer provider Retry-After instead of giving up before the wait.
  const timeBounded = !unlimited && config.mode !== 'always'
  const providerDelayCap = unlimited ? Number.MAX_SAFE_INTEGER : config.mode === 'always' ? 3600000 : 300000
  const maxAttempts = unlimited ? Number.MAX_SAFE_INTEGER : config.mode === 'always' ? config.alwaysMaxRetries : config.maxRetries
  return async function retryFetch(input, init = {}) {
    if (!isModelRequest(input, init, config)) return originalFetch(input, init)
    const copied = copyBody(input, init, config.maxBodyBytes)
    const id = crypto.randomUUID()
    const emit = (state, extra = {}) => { try { options.onStatus?.({ requestId: id, state, at: now(), ...extra }) } catch {} }
    if (!copied) { emit('skipped', { reason: 'noncopyable_body' }); return originalFetch(input, init) }
    const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined)
    callerSignal?.throwIfAborted()
    const controller = new AbortController()
    const budgetTimer = timeBounded ? setTimeout(() => controller.abort(new DOMException('Retry budget exhausted', 'TimeoutError')), config.budgetMs) : undefined
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal, started = now()
    let attempt = 0, result, lastError
    try {
      while (unlimited || attempt <= maxAttempts) {
        signal.throwIfAborted(); attempt++
        emit('requesting', { attempt, maxAttempts: unlimited ? null : maxAttempts + 1, mode: config.mode, intervalMs: config.intervalMs })
        result = undefined; lastError = undefined
        let rawDecision
        try {
          // A managed retry cannot follow a redirect into an unapproved destination.
          const response = await originalFetch(input, { ...init, ...copied, signal, redirect: 'error' })
          result = await inspectResponse(response, config, signal)
          rawDecision = result
        } catch (error) {
          if (signal.aborted) throw signal.reason
          lastError = error; rawDecision = { retry: isNetworkError(error), reason: isNetworkError(error) ? 'network' : 'terminal_transport' }
        }
        const local = config.baseDelayMs === 0 ? 0 : Math.min(config.maxDelayMs, config.baseDelayMs * config.backoffFactor ** (attempt - 1))
        const providerDelay = result ? retryAfter(result.response.headers, now(), providerDelayCap) : undefined
        const delayMs = unlimited ? Math.max(options.getIntervalMs?.() ?? config.intervalMs, providerDelay ?? 0)
          : providerDelay ?? Math.round(local * (config.jitter ? 0.5 + (options.random ?? Math.random)() * 0.5 : 1))
        const decision = retryDecision(rawDecision, attempt, config)
        if (!decision.retry || (timeBounded && (attempt > maxAttempts || now() - started + delayMs >= config.budgetMs))) {
          emit(result?.response.ok && !decision.retry ? 'returned' : 'failed', { attempt, reason: decision.reason })
          if (lastError) throw lastError
          return result.response
        }
        if (result?.response.body) await cancelReader(result.response.body.getReader())
        emit('waiting', { attempt, delayMs, nextAttempt: attempt + 1, reason: decision.reason, retryAt: now() + delayMs })
        signal.throwIfAborted(); await wait(delayMs, signal)
      }
    } catch (error) {
      emit(callerSignal?.aborted ? 'cancelled' : 'failed', { attempt, reason: callerSignal?.aborted ? 'cancelled' : 'transport_or_budget' })
      throw error
    } finally { clearTimeout(budgetTimer) }
  }
}
