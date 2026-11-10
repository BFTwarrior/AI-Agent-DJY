import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_LOCALE,
  FALLBACK_TIME_ZONE,
  SUPPORTED_LOCALES,
  detectSystemLocale,
  detectSystemTimeZone,
  formatDateTime,
  isValidTimeZone,
  normalizeLocale,
  normalizeTimeZone,
  resolveLocale,
  resolveTimeZone,
} from '../src/i18n.mjs';

test('the supported locale set is fixed', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['zh-CN', 'ja-JP', 'ko-KR', 'en-US']);
  assert.equal(FALLBACK_LOCALE, 'en-US');
  assert.equal(FALLBACK_TIME_ZONE, 'UTC');
});

test('normalizeLocale accepts every documented spelling', () => {
  const accepted = new Map([
    ['zh', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['zh-cn', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-Hans-CN', 'zh-CN'],
    ['zh_CN.UTF-8', 'zh-CN'],
    ['zh_CN.UTF-8@euro', 'zh-CN'],
    ['ja', 'ja-JP'],
    ['ja-JP', 'ja-JP'],
    ['ja_JP.UTF-8', 'ja-JP'],
    ['ko', 'ko-KR'],
    ['ko_KR.UTF-8', 'ko-KR'],
    ['en', 'en-US'],
    ['en-US', 'en-US'],
    ['en_GB.UTF-8', 'en-US'],
    ['en-AU', 'en-US'],
    ['  zh_CN.UTF-8  ', 'zh-CN'],
    ['zh-Hans-HK', 'zh-CN'],
    ['zh-Hans-SG', 'zh-CN'],
  ]);
  for (const [input, expected] of accepted) assert.equal(normalizeLocale(input), expected, input);
});

test('normalizeLocale rejects unsupported or malformed values', () => {
  for (const input of ['', '   ', 'de-DE', 'fr', 'zh-TW', 'zh-HK', 'zh-Hant', 'ja-JP-u-ca-japanese', 'en-Latn-US', null, undefined, 42, {}]) {
    assert.equal(normalizeLocale(input), null, String(input));
  }
});

test('C and POSIX mean "no preference", not English', () => {
  // A C locale must fall through to the platform locale instead of forcing
  // en-US on a Chinese/Japanese/Korean desktop.
  assert.equal(normalizeLocale('C'), null);
  assert.equal(normalizeLocale('POSIX'), null);
  assert.equal(normalizeLocale('C.UTF-8'), null);
  assert.equal(detectSystemLocale({ env: { LANG: 'C.UTF-8' }, intl: fakeIntl({ locale: 'ja-JP' }) }), 'ja-JP');
  assert.equal(detectSystemLocale({ env: { LC_ALL: 'POSIX' }, intl: fakeIntl({ locale: 'ko-KR' }) }), 'ko-KR');
});

// A fake Intl must expose DateTimeFormat, because the detector reads the
// platform locale/zone from a formatter instance (the Intl namespace itself
// has no resolvedOptions()). This mirrors the real runtime shape, including
// rejecting an unknown timeZone.
const KNOWN_ZONES = new Set([
  'UTC', 'Europe/Berlin', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'Asia/Hong_Kong',
]);

function fakeIntl({ locale = 'en-US', timeZone = 'UTC', throwOnFormat = false } = {}) {
  return {
    DateTimeFormat: class {
      constructor(_locale, options = {}) {
        if (throwOnFormat) throw new Error('no intl');
        if (options.timeZone && !KNOWN_ZONES.has(options.timeZone)) {
          throw new RangeError(`invalid time zone: ${options.timeZone}`);
        }
        this.zone = options.timeZone ?? timeZone;
      }

      resolvedOptions() {
        return { locale, timeZone: this.zone };
      }

      format() {
        return '';
      }
    },
  };
}

test('environment priority is AGENT_TEAMS_LOCALE, ZCODE_LOCALE, LC_ALL, LC_MESSAGES, LANG', () => {
  const intl = fakeIntl({ locale: 'ko-KR' });
  assert.equal(detectSystemLocale({ env: { AGENT_TEAMS_LOCALE: 'zh-CN' }, intl }), 'zh-CN');
  assert.equal(detectSystemLocale({ env: { ZCODE_LOCALE: 'ja-JP' }, intl }), 'ja-JP');
  assert.equal(detectSystemLocale({ env: { LC_ALL: 'ko-KR', LANG: 'ja_JP.UTF-8' }, intl }), 'ko-KR');
  assert.equal(detectSystemLocale({ env: { LC_ALL: '', LC_MESSAGES: 'ja-JP', LANG: 'zh_CN.UTF-8' }, intl }), 'ja-JP');
  assert.equal(detectSystemLocale({ env: { LANG: 'zh_CN.UTF-8' }, intl }), 'zh-CN');
  // A higher-priority unsupported value is skipped instead of winning.
  assert.equal(detectSystemLocale({ env: { LC_ALL: 'C', LANG: 'ja_JP.UTF-8' }, intl }), 'ja-JP');
  assert.equal(detectSystemLocale({ env: { LC_ALL: 'fr_FR.UTF-8', LANG: 'ja_JP.UTF-8' }, intl }), 'ja-JP');
});

test('detectSystemLocale falls back to the platform locale, then en-US', () => {
  assert.equal(detectSystemLocale({ env: {}, intl: fakeIntl({ locale: 'ja-JP' }) }), 'ja-JP');
  assert.equal(detectSystemLocale({ env: {}, intl: fakeIntl({ locale: 'zh-CN' }) }), 'zh-CN');
  assert.equal(detectSystemLocale({ env: {}, intl: fakeIntl({ locale: 'de-DE' }) }), 'en-US');
  assert.equal(detectSystemLocale({ env: {}, intl: fakeIntl({ throwOnFormat: true }) }), 'en-US');
  // The real Intl namespace is the default: no env means the host platform
  // locale decides. Assert it equals the documented mapping of the platform
  // tag, and that an unsupported platform tag still lands on en-US.
  const platformTag = new Intl.DateTimeFormat().resolvedOptions().locale;
  const mapped = normalizeLocale(platformTag);
  assert.equal(detectSystemLocale({ env: {} }), mapped ?? 'en-US');
});

test('detectSystemTimeZone validates every source and falls back to UTC', () => {
  const intl = fakeIntl({ timeZone: 'Europe/Berlin' });
  assert.equal(detectSystemTimeZone({ env: { AGENT_TEAMS_TIMEZONE: 'Asia/Shanghai' }, intl }), 'Asia/Shanghai');
  assert.equal(detectSystemTimeZone({ env: { TZ: 'America/New_York' }, intl }), 'America/New_York');
  assert.equal(detectSystemTimeZone({ env: { TZ: ':Asia/Tokyo' }, intl }), 'Asia/Tokyo');
  assert.equal(detectSystemTimeZone({ env: { AGENT_TEAMS_TIMEZONE: 'Not/AZone', TZ: 'Asia/Tokyo' }, intl }), 'Asia/Tokyo');
  assert.equal(detectSystemTimeZone({ env: {}, intl }), 'Europe/Berlin');
  assert.equal(detectSystemTimeZone({ env: {}, intl: fakeIntl({ timeZone: 'Bogus/Zone' }) }), 'UTC');
  assert.equal(detectSystemTimeZone({ env: {}, intl: fakeIntl({ throwOnFormat: true }) }), 'UTC');
  // Real Intl default: the host zone wins over UTC.
  assert.equal(detectSystemTimeZone({ env: {} }), new Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('time-zone validation accepts IANA names and rejects malformed ones', () => {
  assert.equal(isValidTimeZone('Asia/Shanghai'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Etc/GMT+5'), true);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone('Asia/Shanghai '), true);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(null), false);
  assert.equal(normalizeTimeZone('asia/shanghai'), 'Asia/Shanghai');
  assert.equal(normalizeTimeZone('Bogus/Zone'), null);
});

test('resolveLocale keeps explicit values, detects auto, and warns on unsupported values', () => {
  const env = { LANG: 'ja_JP.UTF-8' };
  assert.deepEqual(resolveLocale('auto', { env }), { locale: 'ja-JP', source: 'detected', warning: null });
  assert.deepEqual(resolveLocale('', { env }), { locale: 'ja-JP', source: 'detected', warning: null });
  assert.deepEqual(resolveLocale(undefined, { env }), { locale: 'ja-JP', source: 'detected', warning: null });
  assert.deepEqual(resolveLocale('en-US', { env }), { locale: 'en-US', source: 'explicit', warning: null });
  assert.deepEqual(resolveLocale('zh_CN.UTF-8', { env }), { locale: 'zh-CN', source: 'explicit', warning: null });
  const fallback = resolveLocale('de-DE', { env });
  assert.equal(fallback.locale, 'ja-JP');
  assert.equal(fallback.source, 'fallback');
  assert.match(fallback.warning, /de-DE/);
});

test('resolveTimeZone keeps explicit values, detects auto, and warns on invalid zones', () => {
  const env = { TZ: 'Asia/Tokyo' };
  assert.deepEqual(resolveTimeZone('auto', { env }), { timeZone: 'Asia/Tokyo', source: 'detected', warning: null });
  assert.deepEqual(resolveTimeZone('Europe/Berlin', { env }), { timeZone: 'Europe/Berlin', source: 'explicit', warning: null });
  const fallback = resolveTimeZone('Not/AZone', { env });
  assert.equal(fallback.timeZone, 'Asia/Tokyo');
  assert.equal(fallback.source, 'fallback');
  assert.match(fallback.warning, /Not\/AZone/);
});

test('formatDateTime renders the same instant in the requested time zone', () => {
  const instant = Date.UTC(2026, 0, 15, 3, 4, 5);
  const utc = formatDateTime(instant, { locale: 'en-US', timeZone: 'UTC' });
  const shanghai = formatDateTime(instant, { locale: 'en-US', timeZone: 'Asia/Shanghai' });
  assert.match(utc, /2026/);
  assert.match(utc, /03:04:05/);
  assert.match(shanghai, /2026/);
  assert.match(shanghai, /11:04:05/);
  assert.notEqual(utc, shanghai);
  // ISO strings and Date objects are accepted too.
  assert.match(formatDateTime(new Date(instant), { locale: 'en-US', timeZone: 'UTC' }), /03:04:05/);
  assert.match(formatDateTime(new Date(instant).toISOString(), { locale: 'en-US', timeZone: 'UTC' }), /03:04:05/);
});

test('formatDateTime returns an empty string for unusable input and accepts Intl overrides', () => {
  assert.equal(formatDateTime(undefined, { timeZone: 'UTC' }), '');
  assert.equal(formatDateTime(null, { timeZone: 'UTC' }), '');
  assert.equal(formatDateTime('not-a-date', { timeZone: 'UTC' }), '');
  assert.equal(formatDateTime(new Date('invalid'), { timeZone: 'UTC' }), '');
  const short = formatDateTime(Date.UTC(2026, 0, 15, 3, 4, 5), { locale: 'en-US', timeZone: 'UTC', dateStyle: 'short' });
  assert.match(short, /1\/15\/26/);
  // Naming components replaces the default date+time set.
  const timeOnly = formatDateTime(Date.UTC(2026, 0, 15, 3, 4, 5), { locale: 'en-US', timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
  assert.match(timeOnly, /03:04/);
});
