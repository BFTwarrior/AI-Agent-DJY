/**
 * Provider error classification shared by the scheduler and the CLI adapter.
 * Keep the patterns in one place so a capacity code added for one path cannot
 * drift from the other.
 */

const CAPACITY_CODE_PATTERN = /(?:^|[\s_.-])(?:429|rate[_\-.]?limit(?:ed|_exceeded|_error)?|too[_\-.]?many[_\-.]?requests|overloaded|resource[_\-.]?exhausted|quota(?:[_\-.]?exceeded)?|concurrency(?:[_\-.]?(?:limit|cap))?|capacity(?:[_\-.]?(?:limit|exceeded|wall))?|session[_\-.]?cap)(?:$|[\s_.-])/i;
const NON_CAPACITY_CODE_PATTERN = /invalid|unauthorized|forbidden|permission|not.?found|auth|context.?length|content.?filter|bad.?request|validation|syntax|enoent|eacces|emfile|enfile|enospc|e_invalid|e_auth|e_not_found|e_conflict|e_state|e_budget|insufficient.?quota|credit.?balance|spend.?limit|usage.?limit|billing|payment|hard.?quota|current.?quota/i;
const CAPACITY_TEXT_PATTERN = /(?:^|\D)429(?:\D|$)|rate[\s_.-]?limit|requests?[\s-]*per[\s-]*minute|\brpm\b|too many requests|quota|concurrency[\s-]*(?:limit|cap)|session[\s-]*(?:cap|limit)|max(?:imum)? sessions|capacity[\s-]*(?:limit|exceeded|wall)|resource[\s-]*exhausted|overloaded/i;
const NON_CAPACITY_TEXT_PATTERN = /too many open files|emfile|enfile|enospc|no space left|disk (?:full|space|capacity)|storage (?:capacity|limit)|memory capacity|filesystem|out of memory|heap out of memory|context length|insufficient[_ ]?quota|credit[_ ]?balance|spend[_ ]?limit|hard[_ ]?quota|billing[^\n]*(?:hard|limit|quota|exhausted)|payment required/i;

export const HARD_QUOTA_CODE_PATTERN = /insufficient[ _-]?quota|credit[ _-]?balance|spend[ _-]?limit|usage[ _-]?limit|hard[ _-]?quota|current[ _-]?quota|exceeded[ _-]?current[ _-]?quota|billing|payment|\b(?:2056|20097|131[6-9]|132[01])\b/i;
export const HARD_QUOTA_TEXT_PATTERN = /insufficient[ _-]?quota|credit[ _-]?balance|spend[ _-]?limit|usage[ _-]?limit|hard[ _-]?quota|current[ _-]?quota|exceeded[ _-]?current[ _-]?quota|billing[^\n]*(?:hard|limit|quota|exhausted)|payment required/i;
export const EXPLICIT_NUMERIC_CODE_PATTERN = /\b(?:code|error)[=: ]*(2056|20097|131[6-9]|132[01])\b/i;

/** camelCase provider codes become snake_case for the shared patterns. */
function normalizeProviderCode(value) {
  return String(value ?? '').trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2');
}

/**
 * @param {{ code?: unknown, type?: unknown, message?: unknown }} error
 * @returns {boolean}
 */
export function isHardQuotaError({ code, type, message } = {}) {
  const codeType = normalizeProviderCode(`${code ?? ''} ${type ?? ''}`);
  const text = String(message ?? '');
  return HARD_QUOTA_CODE_PATTERN.test(codeType)
    || HARD_QUOTA_TEXT_PATTERN.test(text)
    || EXPLICIT_NUMERIC_CODE_PATTERN.test(text);
}

/**
 * Decide whether a provider error is a capacity/rate-limit wall.
 * Structured code/type wins; keyword matching is only a fallback and is
 * suppressed when the structured code or message clearly describes a
 * non-capacity failure (for example a filesystem error containing "too many").
 *
 * @param {{ message?: string, code?: string, type?: string, retryable?: boolean, retryAfterMs?: number }} error
 * @returns {boolean}
 */
export function isCapacityError(error) {
  if (error?.retryable === false) return false;
  const text = String(error?.message ?? '');
  const codeType = normalizeProviderCode(`${error?.code ?? ''} ${error?.type ?? ''}`);
  if (isHardQuotaError({ code: error?.code, type: error?.type, message: text })) return false;
  if (CAPACITY_CODE_PATTERN.test(codeType)) return true;
  if (NON_CAPACITY_CODE_PATTERN.test(codeType)) return false;
  const hint = Number(error?.retryAfterMs);
  if (Number.isFinite(hint) && hint > 0) return true;
  if (NON_CAPACITY_TEXT_PATTERN.test(text)) return false;
  return CAPACITY_TEXT_PATTERN.test(text);
}
