/**
 * Locale and time-zone core. Pure helpers with injectable `env` and `intl`, so
 * every caller (config loader, installer, console projection, tests) resolves
 * the same concrete values without touching the process globals.
 *
 * The supported set is intentionally small: the control plane translates a
 * fixed catalog, not arbitrary content.
 */

export const SUPPORTED_LOCALES = ['zh-CN', 'ja-JP', 'ko-KR', 'en-US'];
export const FALLBACK_LOCALE = 'en-US';
export const FALLBACK_TIME_ZONE = 'UTC';

const LOCALE_ENV_KEYS = ['AGENT_TEAMS_LOCALE', 'ZCODE_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANG'];
const TIME_ZONE_ENV_KEYS = ['AGENT_TEAMS_TIMEZONE', 'TZ'];

/**
 * Strip a POSIX locale suffix (`.codeset`, `@modifier`) and normalize the
 * separator to `-`. BCP 47 tags never contain `.` or `@`, so this is safe for
 * both forms.
 * @param {unknown} value
 * @returns {string}
 */
function stripPosix(value) {
  return String(value).trim().split('@')[0].split('.')[0].replaceAll('_', '-');
}

/**
 * Canonicalize a single BCP 47 tag (language lowercase, script Titlecase,
 * region uppercase) without deciding whether it is supported.
 * @param {string} tag
 * @returns {string}
 */
function canonicalTag(tag) {
  const parts = tag.split('-').filter(Boolean);
  return parts.map((part, index) => {
    if (index === 0) return part.toLowerCase();
    if (part.length === 4) return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
    return part.toUpperCase();
  }).join('-');
}

/**
 * Map any accepted spelling onto one of `SUPPORTED_LOCALES`.
 *
 * Accepted: `zh`, `zh-CN`, `zh-Hans`, `zh_CN.UTF-8`; `ja`, `ja-JP`;
 * `ko`, `ko-KR`; `en`, `en-US`, `en_GB.UTF-8`, any `en-*` region;
 * `C` and `POSIX`.
 *
 * @param {unknown} value
 * @returns {string|null} canonical locale, or null when unsupported
 */
export function normalizeLocale(value) {
  if (typeof value !== 'string') return null;
  const cleaned = stripPosix(value);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  // `C`/`POSIX` mean "no locale preference", not English. Callers that see
  // this sentinel must keep looking (env chain, then the platform locale).
  if (lower === 'c' || lower === 'posix') return null;
  const tag = canonicalTag(cleaned);
  const [language] = tag.split('-');
  if (language === 'zh') {
    // Simplified Chinese is the only Chinese catalog. Any `zh-Hans-*` region
    // (zh-Hans-HK, zh-Hans-SG, ...) is still Simplified and maps to zh-CN;
    // `zh-TW`/`zh-HK`/`zh-Hant` stay unsupported instead of silently serving
    // Simplified text to a Traditional reader.
    if (tag === 'zh' || tag === 'zh-CN' || /^zh-Hans(?:-[A-Z]{2})?$/.test(tag)) return 'zh-CN';
    return null;
  }
  if (language === 'ja') return tag === 'ja' || tag === 'ja-JP' ? 'ja-JP' : null;
  if (language === 'ko') return tag === 'ko' || tag === 'ko-KR' ? 'ko-KR' : null;
  if (language === 'en') return tag === 'en' || /^en-[A-Z]{2}$/.test(tag) ? 'en-US' : null;
  return null;
}

function resolvedLocale(intl) {
  try {
    const formatter = new (formatterClass(intl))();
    const resolved = formatter.resolvedOptions().locale;
    return typeof resolved === 'string' ? normalizeLocale(resolved) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the runtime locale from the environment, then Intl, then `en-US`.
 * Order: AGENT_TEAMS_LOCALE > ZCODE_LOCALE > LC_ALL > LC_MESSAGES > LANG >
 * Intl resolved locale > en-US. Unsupported values are skipped, not fatal.
 *
 * @param {{ env?: Record<string, string|undefined>, intl?: any }} [options]
 * @returns {string}
 */
export function detectSystemLocale({ env = process.env, intl = Intl } = {}) {
  for (const key of LOCALE_ENV_KEYS) {
    const raw = env?.[key];
    if (typeof raw !== 'string') continue;
    const normalized = normalizeLocale(raw);
    if (normalized) return normalized;
  }
  return resolvedLocale(intl) ?? FALLBACK_LOCALE;
}

function formatterClass(intl) {
  return intl?.DateTimeFormat ?? Intl.DateTimeFormat;
}

/**
 * Canonicalize an IANA time zone through `Intl.DateTimeFormat`. Returns null
 * for empty, malformed or unknown zones.
 * @param {unknown} value
 * @param {{ intl?: any }} [options]
 * @returns {string|null}
 */
export function normalizeTimeZone(value, { intl = Intl } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.trim().replace(/^:/, '');
  if (!candidate) return null;
  try {
    const formatter = new (formatterClass(intl))('en-US', { timeZone: candidate });
    const resolved = formatter.resolvedOptions().timeZone;
    return typeof resolved === 'string' && resolved ? resolved : candidate;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @param {{ intl?: any }} [options]
 * @returns {boolean}
 */
export function isValidTimeZone(value, options = {}) {
  return normalizeTimeZone(value, options) !== null;
}

function resolvedTimeZone(intl) {
  try {
    const formatter = new (formatterClass(intl))();
    const resolved = formatter.resolvedOptions().timeZone;
    return normalizeTimeZone(resolved, { intl });
  } catch {
    return null;
  }
}

/**
 * Resolve the runtime time zone: AGENT_TEAMS_TIMEZONE > TZ > Intl resolved
 * timeZone > UTC. An invalid explicit value falls through to the next source.
 *
 * @param {{ env?: Record<string, string|undefined>, intl?: any }} [options]
 * @returns {string}
 */
export function detectSystemTimeZone({ env = process.env, intl = Intl } = {}) {
  for (const key of TIME_ZONE_ENV_KEYS) {
    const raw = env?.[key];
    if (typeof raw !== 'string') continue;
    const normalized = normalizeTimeZone(raw, { intl });
    if (normalized) return normalized;
  }
  return resolvedTimeZone(intl) ?? FALLBACK_TIME_ZONE;
}

function isAuto(preference) {
  if (preference === undefined || preference === null) return true;
  if (typeof preference !== 'string') return false;
  const value = preference.trim();
  return value === '' || value.toLowerCase() === 'auto';
}

/**
 * Resolve a configured locale preference.
 *
 * `auto`/empty -> detection. An explicit supported value is canonicalized and
 * kept. An explicit unsupported value falls back to detection and reports a
 * warning instead of failing at runtime.
 *
 * @param {unknown} preference
 * @param {{ env?: Record<string, string|undefined>, intl?: any }} [options]
 * @returns {{ locale: string, source: 'detected'|'explicit'|'fallback', warning: string|null }}
 */
export function resolveLocale(preference, options = {}) {
  const detected = detectSystemLocale(options);
  if (isAuto(preference)) return { locale: detected, source: 'detected', warning: null };
  const normalized = normalizeLocale(preference);
  if (normalized) return { locale: normalized, source: 'explicit', warning: null };
  return {
    locale: detected,
    source: 'fallback',
    warning: `unsupported locale "${String(preference)}"; falling back to ${detected}`,
  };
}

/**
 * Resolve a configured time-zone preference with the same rules as
 * {@link resolveLocale}.
 *
 * @param {unknown} preference
 * @param {{ env?: Record<string, string|undefined>, intl?: any }} [options]
 * @returns {{ timeZone: string, source: 'detected'|'explicit'|'fallback', warning: string|null }}
 */
export function resolveTimeZone(preference, options = {}) {
  const detected = detectSystemTimeZone(options);
  if (isAuto(preference)) return { timeZone: detected, source: 'detected', warning: null };
  const normalized = normalizeTimeZone(preference, options);
  if (normalized) return { timeZone: normalized, source: 'explicit', warning: null };
  return {
    timeZone: detected,
    source: 'fallback',
    warning: `unsupported time zone "${String(preference)}"; falling back to ${detected}`,
  };
}

function toDate(value) {
  const date = value instanceof Date
    ? value
    : (typeof value === 'number' || (typeof value === 'string' && value.trim()))
      ? new Date(value)
      : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * Format an instant for display. The locale controls ordering and separators;
 * the time zone controls the wall clock. Invalid input returns an empty string
 * so a bad row cannot crash a status projection.
 *
 * @param {Date|number|string} value epoch milliseconds, ISO string or Date
 * @param {{ locale?: string, timeZone?: string } & Intl.DateTimeFormatOptions} [options]
 * @returns {string}
 */
export function formatDateTime(value, { locale, timeZone, ...overrides } = {}) {
  const date = toDate(value);
  if (!date) return '';
  const resolvedLocale = resolveLocale(locale).locale;
  const resolvedTimeZone = resolveTimeZone(timeZone).timeZone;
  const componentKeys = ['year', 'month', 'day', 'weekday', 'hour', 'minute', 'second', 'era', 'timeZoneName'];
  const explicitComponents = componentKeys.some((key) => key in overrides);
  const defaultComponents = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  };
  // A caller that names its own components (or a style) replaces the default
  // date+time set instead of unknowingly keeping the unused fields.
  const base = explicitComponents || overrides.dateStyle || overrides.timeStyle ? {} : defaultComponents;
  try {
    const formatter = new Intl.DateTimeFormat(resolvedLocale, {
      timeZone: resolvedTimeZone,
      ...base,
      ...overrides,
    });
    return formatter.format(date);
  } catch {
    // Invalid or conflicting Intl options must not take down a projection.
    return '';
  }
}
