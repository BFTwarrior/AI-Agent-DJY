const terminalCodes = new Set(['1113', '1304', '1308', '1309', '1310', '1311', '1313', '401', '403'])
const transientCodes = new Set(['1120', '1230', '1234', '1302', '1303', '1305', '1312'])
const transientStatus = new Set([408, 429, 500, 502, 503, 504])
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'])

/**
 * Error shapes seen behind a successful status code: nested envelopes plus the
 * flat business form relays use, e.g. {"code":"1113","msg":"Insufficient balance"}.
 * A zero/200 code is a success marker, not an error.
 * @param {any} payload
 */
function isErrorPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  if (payload.error || payload.type === 'error' || payload.success === false) return true
  return /^(?!0+$|200$)\d{3,4}$/.test(String(payload.code ?? '')) && typeof (payload.msg ?? payload.message) === 'string'
}

export function classify(status, payload, headers = new Headers()) {
  const failure = status < 200 || status >= 300 || isErrorPayload(payload)
  const decide = (retry, reason) => ({ retry, reason, failure })
  if (status === 401) return decide(false, 'authentication')
  if (/^(?:false|0)$/i.test(headers.get('x-should-retry')?.trim() ?? '')) return decide(false, 'provider_disabled')
  const error = payload?.error ?? payload
  const message = [typeof error === 'string' ? error : undefined, error?.message, error?.msg, payload?.message, payload?.msg].filter(v => typeof v === 'string').join(' ')
  const codes = [error?.code, payload?.code, ...[...message.matchAll(/\[(\d{4})\]/g)].map(m => m[1])].filter(v => v !== undefined).map(String)
  const types = [error?.type, payload?.type].filter(v => typeof v === 'string')
  if (codes.some(code => terminalCodes.has(code)) || types.some(type => /^(?:authentication_error|invalid_request_error|permission_error|insufficient_quota|authorization_error|not_found_error)$/.test(type)) ||
    /insufficient balance|no resource package|unauthori[sz]ed|authentication|invalid.api.key|forbidden|permission.denied|subscription.expired/i.test(message)) {
    return decide(false, 'terminal_provider')
  }
  if (codes.some(code => transientCodes.has(code)) || /\b(?:user|model)\s+concurrency\s+limit\s+exceeded\b/i.test(message)) return decide(true, 'concurrency_or_transient')
  // Explicit structured business failures are authoritative, even in HTTP 429.
  if (codes.some(code => /^\d{4}$/.test(code))) return decide(false, 'unknown_business_code')
  return decide(transientStatus.has(status), `http_${status}`)
}

// A response that already reached the client, or one that outgrew the probe
// window, cannot be replayed without dropping content the caller has seen.
const nonReplayableReasons = new Set(['output_committed', 'probe_limit'])

/**
 * `always` mode: every failure is retryable, including terminal provider
 * errors, but only `alwaysMaxRetries` extra attempts are allowed. Other modes
 * keep the classify() result untouched.
 * @param {{retry: boolean, reason: string}} decision
 * @param {number} attempt attempts already made, starting at 1
 * @param {any} config
 */
export function retryDecision(decision, attempt, config) {
  if (config.mode !== 'always' || decision.failure === false || nonReplayableReasons.has(decision.reason)) return decision
  if (attempt > config.alwaysMaxRetries) return { ...decision, retry: false, exhausted: true }
  return decision.retry ? decision : { ...decision, retry: true, forced: true }
}

export function retryAfter(headers, now, maxMs = 300000) {
  const ms = headers.get('retry-after-ms')
  const value = headers.get('retry-after')
  let result
  if (ms !== null && /^\d+(?:\.\d+)?$/.test(ms.trim())) result = Number(ms)
  else if (value !== null) result = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(result) && result >= 0 && result <= maxMs ? Math.round(result) : undefined
}

export function isNetworkError(error) {
  return error?.name === 'TimeoutError' || networkCodes.has(error?.code) || networkCodes.has(error?.cause?.code)
}

export function isModelRequest(input, init, config) {
  try {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    return method === 'POST' && config.allowedOrigins.includes(u.origin) && !u.username && !u.password &&
      /\/(?:messages|chat\/completions|responses)\/?$/.test(u.pathname)
  } catch { return false }
}
