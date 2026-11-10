import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { loadLocales } from '../scripts/build-i18n.mjs';

const runtimeCode = readFileSync(new URL('../assets/team-view-i18n.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../assets/team-panel.html', import.meta.url), 'utf8');
const view = readFileSync(new URL('../assets/team-view.html', import.meta.url), 'utf8');
const live = readFileSync(new URL('../assets/team-view-live.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../assets/team-view-app.js', import.meta.url), 'utf8');

function bootRuntime({ search = '', localization = null, htmlLang = '', navigatorLanguage = 'en-US', withDocument = true, attributes = new Map(), storage = new Map() } = {}) {
  if (htmlLang) attributes.set('lang', htmlLang);
  const document = withDocument ? {
    readyState: 'complete',
    documentElement: {
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
    },
    addEventListener: () => {},
    querySelectorAll: () => [],
    dispatchEvent: () => {},
  } : undefined;
  const window = {
    location: { search },
    navigator: { language: navigatorLanguage },
    __AGENT_TEAMS_UI__: localization ? { console: { localization } } : undefined,
    document,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
  };
  const context = {
    window,
    document,
    navigator: window.navigator,
    Intl,
    Date,
    WeakMap,
    URLSearchParams,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
  };
  vm.runInNewContext(runtimeCode, context);
  return window.AGT_I18N;
}

test('all four locales expose the same string keys and pattern placeholders', () => {
  const locales = loadLocales(resolve('.'));
  const reference = locales['zh-CN'];
  const referenceKeys = Object.keys(reference.strings).sort();
  const referencePatterns = reference.patterns.map((pattern) => pattern.source).sort();
  assert.ok(referenceKeys.length >= 400, `expected a broad dictionary, found ${referenceKeys.length}`);
  assert.ok(referencePatterns.length >= 60, `expected patterns, found ${referencePatterns.length}`);
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    const dictionary = locales[locale];
    assert.deepEqual(Object.keys(dictionary.strings).sort(), referenceKeys, `${locale} key set differs`);
    assert.deepEqual(dictionary.patterns.map((pattern) => pattern.source).sort(), referencePatterns, `${locale} pattern set differs`);
  }
  const placeholders = (value) => [...String(value).matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1])).sort((a, b) => a - b).join(',');
  for (const key of referenceKeys) {
    for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
      assert.equal(placeholders(locales[locale].strings[key]), placeholders(key), `${locale} placeholders differ for ${key}`);
    }
  }
  for (const pattern of reference.patterns) {
    for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
      const translated = locales[locale].patterns.find((item) => item.source === pattern.source);
      assert.equal(placeholders(translated.target), placeholders(pattern.source), `${locale} pattern placeholders differ for ${pattern.source}`);
    }
  }
});

test('representative strings are translated, while product terms stay verbatim', () => {
  const cases = [
    ['en-US', 'Overview'],
    ['ja-JP', '概要'],
    ['ko-KR', '개요'],
  ];
  for (const [locale, expected] of cases) {
    const i18n = bootRuntime({ search: `?lang=${locale}` });
    assert.equal(i18n.locale, locale);
    assert.equal(i18n.t('总览'), expected);
    assert.notEqual(i18n.t('总览'), '总览');
    assert.notEqual(i18n.t('等待依赖'), '等待依赖');
    assert.equal(i18n.t('队长'), 'captain');
    assert.match(i18n.t('ZCode 任务指挥台'), /ZCode/u);
    assert.match(i18n.t('Ai-Agent-Teams-Zcode · 团队运行控制台'), /Ai-Agent-Teams-Zcode/u);
  }
  const english = bootRuntime({ search: '?lang=en-US' });
  assert.equal(english.t('A队 {0} · B队 {1}', [4, 2]), 'A team 4 · B team 2');
  assert.equal(bootRuntime({ search: '?lang=ja-JP' }).t('A队 + B队'), 'Aチーム + Bチーム');
  assert.equal(bootRuntime({ search: '?lang=ko-KR' }).t('A队'), 'A팀');
  assert.equal(english.t('等待 16'), 'Waiting 16');
  assert.equal(english.t('切换到白色模式'), 'Switch to light mode');
  assert.equal(english.localizeText('等待 16'), 'Waiting 16');
  assert.equal(english.localizeText('已完成'), 'Completed');
});

test('locale priority honors preview query, console config, html lang, navigator then en-US', () => {
  assert.equal(bootRuntime({ search: '?lang=ja-JP', localization: { locale: 'en-US' }, htmlLang: 'en-US' }).locale, 'ja-JP');
  assert.equal(bootRuntime({ search: '?lang=zh-CN' }).locale, 'zh-CN');
  assert.equal(bootRuntime({ search: '?lang=fr-FR', htmlLang: 'ko-KR' }).locale, 'ko-KR', 'invalid preview locales fall through');
  assert.equal(bootRuntime({ localization: { locale: 'zh-CN' }, htmlLang: 'en-US' }).locale, 'zh-CN');
  assert.equal(bootRuntime({ htmlLang: 'ja-JP', navigatorLanguage: 'ko-KR' }).locale, 'ja-JP');
  assert.equal(bootRuntime({ navigatorLanguage: 'ko-KR' }).locale, 'ko-KR');
  assert.equal(bootRuntime({ navigatorLanguage: 'fr-FR' }).locale, 'en-US');
  const i18n = bootRuntime({ search: '?lang=en-US' });
  assert.equal(i18n.setLocale('ja-JP'), true);
  assert.equal(i18n.locale, 'ja-JP');
  assert.equal(i18n.t('总览'), '概要');
  assert.equal(i18n.setLocale('fr-FR'), false, 'invalid locale switches are rejected');
  assert.equal(i18n.locale, 'ja-JP');
});

test('locale selection persists and is lower priority than an explicit query', () => {
  const storage = new Map([['agent-teams-locale-v1', 'ko-KR']]);
  assert.equal(bootRuntime({ storage }).locale, 'ko-KR');
  const i18n = bootRuntime({ search: '?lang=en-US', storage });
  assert.equal(i18n.locale, 'en-US');
  assert.equal(i18n.setLocale('ja-JP'), true);
  assert.equal(storage.get('agent-teams-locale-v1'), 'ja-JP');
  assert.equal(bootRuntime({ storage }).locale, 'ja-JP');
});

test('the settings page exposes all four locales and the app wires the selector', () => {
  assert.match(view, /<select id="locale-select"[^>]*>/u);
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) assert.match(view, new RegExp(`value="${locale}"`, 'u'));
  assert.match(app, /localeSelect\?\.addEventListener\('change'/u);
  assert.match(app, /window\.AGT_I18N\?\.setLocale\(next\)/u);
  assert.match(app, /agent-teams:locale-changed/u);
});

test('time formatting uses the injected locale and time zone', () => {
  const instant = new Date(Date.UTC(2026, 0, 1, 15, 4, 5));
  const tokyo = bootRuntime({ search: '?lang=en-US', localization: { timeZone: 'Asia/Tokyo' } });
  assert.equal(tokyo.timeZone, 'Asia/Tokyo');
  assert.equal(tokyo.formatTime(instant, { hour: '2-digit', minute: '2-digit', hour12: false }), '00:04');
  const utc = bootRuntime({ search: '?lang=en-US', localization: { timeZone: 'UTC' } });
  assert.equal(utc.formatTime(instant, { hour: '2-digit', minute: '2-digit', hour12: false }), '15:04');
  const fallback = bootRuntime({ search: '?lang=en-US', localization: { timeZone: 'Not/AZone' } });
  assert.notEqual(fallback.timeZone, 'Not/AZone');
  assert.ok(fallback.timeZone, 'an invalid configured zone falls back to Intl or UTC');
});

test('the packaged panel embeds four locales and never fetches locale JSON', () => {
  for (const name of ['简体中文', 'English', '日本語', '한국어']) {
    assert.ok(panel.includes(`"name":"${name}"`), `packaged panel is missing ${name}`);
  }
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    assert.ok(panel.includes(`"${locale}"`), `packaged panel is missing ${locale}`);
  }
  assert.match(panel, /AGT_I18N/u);
  assert.equal(/\bfetch\s*\(/u.test(panel), false, 'the packaged panel must not fetch locale JSON');
  assert.equal(/\bXMLHttpRequest\b/u.test(panel), false);
});

test('the packaged panel embeds the current catalog, not a stale build', () => {
  const locales = loadLocales(resolve('.'));
  const dataBlock = (source) => {
    const start = source.indexOf('var DATA = ');
    assert.ok(start >= 0, 'runtime DATA block is present');
    const end = source.indexOf(';\n  var LOCALES', start);
    assert.ok(end > start, 'runtime DATA block is terminated');
    return source.slice(start, end);
  };
  const runtimeData = dataBlock(runtimeCode);
  assert.equal(dataBlock(panel), runtimeData, 'run node scripts/build-ui.mjs after editing locales/');
  const embedded = JSON.parse(runtimeData.slice('var DATA = '.length));
  assert.deepEqual(Object.keys(embedded).sort(), ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']);
  for (const [name, dict] of Object.entries(locales)) {
    assert.equal(Object.keys(embedded[name].strings).length, Object.keys(dict.strings).length, `${name} string count in the packaged panel`);
    assert.deepEqual(embedded[name].strings, dict.strings, `${name} strings in the packaged panel`);
    assert.deepEqual(embedded[name].patterns, dict.patterns, `${name} patterns in the packaged panel`);
  }
});

test('the panel document language follows the resolved locale', () => {
  // The panel sets `lang` from the resolver and never leaves the static
  // zh-CN value behind when another locale wins.
  assert.match(panel, /documentElement\.setAttribute\('lang', window\.AGT_I18N\.locale\)/u);
  assert.equal(/<html[^>]*lang="zh-CN"/u.test(panel), false, 'the packaged panel must not hard-code a zh-CN lang attribute');
  assert.match(view, /<html lang="zh-CN"/u, 'the static console keeps a documented default');
  const i18n = bootRuntime({ search: '?lang=ja-JP' });
  assert.equal(i18n.locale, 'ja-JP');
  assert.equal(i18n.setLocale('ko-KR'), true, 'a locale switch rewrites documentElement.lang');
});

test('the runtime writes documentElement.lang and keeps it on switch', () => {
  const attributes = new Map();
  const i18n = bootRuntime({ search: '?lang=ja-JP', attributes });
  assert.equal(attributes.get('lang'), 'ja-JP', 'boot publishes the resolved locale to the document');
  assert.equal(i18n.setLocale('ko-KR'), true);
  assert.equal(attributes.get('lang'), 'ko-KR', 'setLocale updates documentElement.lang');
  assert.equal(i18n.setLocale('fr-FR'), false);
  assert.equal(attributes.get('lang'), 'ko-KR', 'a rejected switch leaves the document language alone');
});

test('the team view loads the runtime offline and keeps local time formatting', () => {
  assert.equal(/\bfetch\s*\(/u.test(app), false, 'the app must stay read-only and network-free');
  assert.match(live, /BEGIN GENERATED I18N/u);
  assert.match(live, /window\.AGT_I18N|global\.AGT_I18N/u);
  assert.match(view, /AGENT_TEAMS_UI_BOOTSTRAP/u);
  assert.equal(app.includes("toLocaleTimeString('zh-CN'"), false, 'user-facing timestamps use the runtime locale');
  assert.match(app, /formatTime\(/u);
  assert.equal((app.match(/AGT_I18N/g) ?? []).length >= 1, true);
});
test('localize translates text and attributes, skips user data and can switch locales', () => {
  const i18n = bootRuntime({ search: '?lang=en-US', withDocument: false });
  const buttonAttributes = new Map([['title', '切换到黑色模式']]);
  const button = {
    nodeType: 1, tagName: 'BUTTON', isContentEditable: false, parentElement: null,
    hasAttribute: (name) => buttonAttributes.has(name),
    getAttribute: (name) => buttonAttributes.get(name) ?? null,
    setAttribute: (name, value) => buttonAttributes.set(name, value),
  };
  const normalParent = { nodeType: 1, tagName: 'SPAN', isContentEditable: false, parentElement: null, hasAttribute: () => false };
  const skippedParent = { nodeType: 1, tagName: 'SPAN', isContentEditable: false, parentElement: null, hasAttribute: (name) => name === 'data-i18n-skip' };
  const nodes = [
    { nodeValue: '总览', parentElement: normalParent },
    { nodeValue: '青岚', parentElement: skippedParent },
    { nodeValue: '已完成', parentElement: normalParent },
  ];
  const document = {
    createTreeWalker: () => {
      let index = 0;
      return { nextNode: () => nodes[index++] ?? null };
    },
  };
  const root = { ownerDocument: document, querySelectorAll: (selector) => (selector.includes('title') ? [button] : []) };
  assert.equal(i18n.localize(root), 3);
  assert.equal(nodes[0].nodeValue, 'Overview');
  assert.equal(nodes[1].nodeValue, '青岚', 'dynamic user data stays untouched');
  assert.equal(nodes[2].nodeValue, 'Completed');
  assert.equal(buttonAttributes.get('title'), 'Switch to dark mode');

  assert.equal(i18n.setLocale('ja-JP'), true);
  i18n.localize(root);
  assert.equal(nodes[0].nodeValue, '概要');
  assert.equal(nodes[1].nodeValue, '青岚');
  assert.equal(nodes[2].nodeValue, '完了');
  assert.equal(buttonAttributes.get('title'), 'ダークモードに切り替え');

  nodes[2].nodeValue = '进行中';
  i18n.localize(root);
  assert.equal(nodes[2].nodeValue, '進行中', 'new content becomes the next translation source');
});

// Execute the real task-list row builder from assets/team-view-app.js. It takes
// `tt` as a parameter, so the test can hand it the packaged runtime and prove
// that user data (subject/owner) is never routed through the dictionary.
function taskListRow() {
  const start = app.indexOf('      const taskListRowHtml = ');
  const end = app.indexOf('      const updateTaskMeta = ', start);
  assert.ok(start >= 0 && end > start, 'taskListRowHtml is a contiguous block');
  const context = {
    escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char])),
  };
  vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.api = taskListRowHtml;`, context);
  return context.api;
}

test('task titles and owners are user data: en-US leaves a Chinese title verbatim', () => {
  const i18n = bootRuntime({ search: '?lang=en-US', withDocument: false });
  const row = taskListRow();
  const subject = '等待 3 个响应';
  const owner = '蓝队';
  const html = row({
    task: { id: 't1', displayId: 'A-T1', subject, owner, status: 'active' },
    deps: 'A-T0',
    selected: true,
    tt: i18n.t,
  });
  // A dictionary round-trip would rewrite both; verbatim output is the proof.
  assert.notEqual(i18n.t(subject), subject, 'the translator really would rewrite this string');
  assert.notEqual(i18n.t(owner), owner, 'the translator really would rewrite the owner');
  assert.ok(html.includes(`>${subject}</b>`), `title must stay verbatim: ${html}`);
  assert.equal(html.includes(i18n.t(subject)), false, 'the translated title must not appear');
  assert.ok(html.includes(`Owner · ${owner}`), `the owner value stays and only the label is translated: ${html}`);
  assert.equal(html.includes('Owner · Blue team'), false);
  // Fixed labels are still translated, and the skip marker is preserved.
  assert.ok(html.includes('In progress'));
  assert.ok(html.includes('Upstream A-T0'));
  assert.equal((html.match(/data-i18n-skip/g) ?? []).length, 3);
  // No owner means the localized "Unassigned" sentinel, not the raw dash.
  const unowned = row({ task: { id: 't2', displayId: 'A-T2', subject: '标题', status: 'waiting' }, deps: '—', selected: false, tt: i18n.t });
  assert.ok(unowned.includes('Owner · Unassigned'), unowned);
  assert.ok(unowned.includes('>标题</b>'), unowned);
  // Markup in user data is escaped, not interpreted.
  const escaped = row({ task: { id: 't3', displayId: 'A-T3', subject: '<img src=x onerror=1>', owner: '"x"', status: 'done' }, deps: '—', tt: i18n.t });
  assert.ok(escaped.includes('&lt;img src=x onerror=1&gt;'));
  assert.ok(escaped.includes('&quot;x&quot;'));
});

test('static demo task display can localize stable ids without touching live task data', () => {
  const i18n = bootRuntime({ search: '?lang=en-US', withDocument: false });
  const row = taskListRow();
  const html = row({
    task: { id: 't2', displayId: 'A-T2', subject: 'A队 · 跨队输入汇总', owner: 'A队', status: 'active' },
    deps: 'A-T1',
    selected: false,
    tt: i18n.t,
    displaySubject: 'A team · Cross-team input summary',
    displayOwner: 'A team',
  });
  assert.ok(html.includes('A team · Cross-team input summary'));
  assert.ok(html.includes('Owner · A team'));
  assert.match(app, /const demoTaskCopy = \{/u);
  assert.match(app, /renderDemoTaskCards = \(\) =>/u);
  assert.match(app, /refreshDemoGraphLabels = \(\) =>/u);
  assert.match(app, /localizeDemoDetail = \(value\) =>/u);
  assert.match(app, /displaySubject: displayTaskSubject\(task\)/u);
  assert.match(app, /displayOwner: LIVE_MODEL \? task\.owner : demoTaskTeam\(task\.id\)/u);
  assert.match(app, /if \(!task \|\| LIVE_MODEL \|\| !demoTaskCopy\[task\.id\]\)/u);
  assert.equal(i18n.t('仓库、约束与验收基线'), 'Repository, constraints, and acceptance baseline');
  assert.equal(i18n.t('接收B队 B-T3b 基线包并冻结输入'), 'Receive the B team B-T3b baseline package and freeze inputs');
});
test('the DAG group label is translated even though #dag-canvas skips localization', () => {
  // The container carries data-i18n-skip, so the runtime never walks into it;
  // the SVG label must be translated at construction time instead.
  assert.match(app, /svg\.setAttribute\('aria-label', tt\('任务依赖图，按依赖深度从左到右排列'\)\)/u);
  const i18n = bootRuntime({ search: '?lang=en-US', withDocument: false });
  assert.equal(i18n.t('任务依赖图，按依赖深度从左到右排列'), 'Task dependency graph, arranged left to right by dependency depth');
  // Node groups keep the same contract.
  assert.match(app, /group\.setAttribute\('aria-label', tt\('\{0\} \{1\}，\{2\}'/u);
});

test('the locale resolver mirrors the core whitelist and rejects zh-TW', () => {
  const resolved = (search) => bootRuntime({ search: `?lang=${encodeURIComponent(search)}`, navigatorLanguage: 'en-US', htmlLang: 'en-US' }).locale;
  assert.equal(resolved('zh'), 'zh-CN');
  assert.equal(resolved('zh-CN'), 'zh-CN');
  assert.equal(resolved('zh-Hans'), 'zh-CN');
  assert.equal(resolved('zh-Hans-CN'), 'zh-CN');
  assert.equal(resolved('zh-Hans-HK'), 'zh-CN');
  assert.equal(resolved('zh_CN.UTF-8'), 'zh-CN');
  assert.equal(resolved('ja'), 'ja-JP');
  assert.equal(resolved('ko-KR'), 'ko-KR');
  assert.equal(resolved('en-GB'), 'en-US');
  // Traditional Chinese has no catalog; falling through beats silent Simplified.
  assert.equal(resolved('zh-TW'), 'en-US');
  assert.equal(resolved('zh-HK'), 'en-US');
  assert.equal(resolved('zh-Hant'), 'en-US');
  assert.equal(resolved('de-DE'), 'en-US');
  const navigatorTw = bootRuntime({ navigatorLanguage: 'zh-TW' });
  assert.equal(navigatorTw.locale, 'en-US', 'a zh-TW browser falls back to en-US');
  assert.equal(navigatorTw.t('总览'), 'Overview');
  const reverted = bootRuntime({ search: '?lang=zh-Hans-SG' });
  assert.equal(reverted.locale, 'zh-CN');
  assert.equal(reverted.setLocale('zh-TW'), false, 'setLocale rejects zh-TW');
  assert.equal(reverted.locale, 'zh-CN');
});

// --- value-level guards ----------------------------------------------------
// Key presence alone let "A队" regress to the old colour name while every test
// stayed green. These assertions compare the rendered value, not the key.

const COLOR_TEAM_NAMES = [
  '蓝队', '绿队', 'Blue team', 'Green team', 'ブルーチーム', 'グリーンチーム',
  '블루 팀', '그린 팀', '블루팀', '그린팀', 'Blue Team', 'Green Team',
];

const TEAM_LABEL_KEYS = ['A队', 'B队', '双队', '单队', 'A队 + B队', 'A队 · 代码工程师', 'A队 · 验证', 'A队 · 审核', 'B队 · 交付', 'B队 · 工程师', 'A队 · 工程师'];

function assertNoColorTeamName(value, label) {
  for (const banned of COLOR_TEAM_NAMES) {
    assert.equal(value.includes(banned), false, `${label} must not contain the colour name ${banned}: ${value}`);
  }
}

test('every team label renders as A/B in all four locales and never as a colour name', () => {
  const locales = loadLocales(resolve('.'));
  // Only the labels that name a specific team must carry the A/B marker; the
  // "two teams"/"single team" counts are localized separately.
  const TEAM_COUNT_KEYS = ['双队', '单队'];
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    const i18n = bootRuntime({ search: `?lang=${locale}`, withDocument: false });
    for (const key of TEAM_LABEL_KEYS.concat(TEAM_COUNT_KEYS)) {
      const rendered = i18n.t(key);
      assert.notEqual(rendered, '', `${locale}/${key} rendered empty`);
      assertNoColorTeamName(rendered, `${locale}/${key}`);
      if (TEAM_COUNT_KEYS.includes(key)) continue;
      assert.match(rendered, /(A|B)/u, `${locale}/${key} must still name a team: ${rendered}`);
    }
    // The retired colour keys still map to A/B so an old snapshot cannot leak.
    for (const legacy of ['蓝队', '绿队', '蓝队 + 绿队', '蓝队等待', '绿队等待', '蓝队当前状态', '蓝队暂无成员', '绿队暂无成员', '当前在岗 · 蓝队 4 · 绿队 2']) {
      assertNoColorTeamName(i18n.t(legacy), `${locale}/${legacy}`);
    }
    // Values in the catalog itself, not just the translator output.
    for (const key of TEAM_LABEL_KEYS.concat(TEAM_COUNT_KEYS)) assertNoColorTeamName(locales[locale].strings[key], `catalog ${locale}/${key}`);
  }
  const zh = loadLocales(resolve('.'))['zh-CN'];
  assert.equal(zh.strings['蓝队'], 'A队', 'the legacy colour alias maps to A队');
  assert.equal(zh.strings['绿队'], 'B队', 'the legacy colour alias maps to B队');
});

test('non-zh values are translated and never echo the Chinese source', () => {
  const locales = loadLocales(resolve('.'));
  // Japanese shares kanji with Chinese, so a handful of ja targets are the same
  // string as the source on purpose. Each one needs an explicit reason; anything
  // else that still equals the Chinese key is an untranslated entry.
  const IDENTICAL_WHITELIST = {
    'ja-JP': new Map([
      ['正常', 'Japanese writes normalcy with the same kanji'],
      ['停止中', 'Japanese writes stopping with the same kanji'],
      ['空', 'Japanese writes empty with the same kanji'],
      ['固定 · {0}', 'Japanese writes fixed with the same kanji'],
      ['日本語', 'language endonym'],
    ]),
    'en-US': new Map([['简体中文', 'language endonym'], ['日本語', 'language endonym']]),
    'ko-KR': new Map(),
  };
  const HAN = /[\u3400-\u9fff]/u;
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    const allowed = IDENTICAL_WHITELIST[locale];
    for (const [key, value] of Object.entries(locales[locale].strings)) {
      if (!HAN.test(key)) continue;
      if (allowed.has(key)) continue;
      assert.notEqual(value, key, `${locale}: ${JSON.stringify(key)} is untranslated`);
    }
  }
  // ko-KR once shipped "데이터解析 실패" with the Chinese 解析 inside, and en/ko
  // must not contain Han characters at all. The only exception is a language
  // endonym: a picker has to print 简体中文/日本語 in the language's own script.
  const HAN_ENDONYMS = new Set(['简体中文', '日本語', '한국어', 'English']);
  for (const locale of ['en-US', 'ko-KR']) {
    for (const [key, value] of Object.entries(locales[locale].strings)) {
      if (HAN_ENDONYMS.has(value)) continue;
      assert.equal(HAN.test(value), false, `${locale}: ${JSON.stringify(key)} contains Han characters: ${value}`);
    }
    for (const pattern of locales[locale].patterns) {
      assert.equal(HAN.test(pattern.target), false, `${locale}: pattern ${JSON.stringify(pattern.source)} contains Han characters: ${pattern.target}`);
    }
  }
  // The demo finding line keeps its old source key for compatibility, but neither
  // that key nor the neutral key may render a Chinese nickname.
  for (const key of ['青岚 A-01 · 2 个文件 · 低风险', 'A-01 · 2 个文件 · 低风险']) {
    for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
      const value = locales[locale].strings[key];
      assert.ok(value, `${locale}: ${key} missing`);
      assert.equal(value.includes('青岚'), false, `${locale}: ${key} renders a Chinese nickname: ${value}`);
    }
  }
});

test('the demo finding line and team footnotes translate at value level', () => {
  const cases = [
    ['en-US', 'A-01 · 2 files · low risk', 'A team 12 · B team 12'],
    ['ja-JP', 'A-01 · 2 ファイル · 低リスク', 'Aチーム 12 · Bチーム 12'],
    ['ko-KR', 'A-01 · 파일 2개 · 저위험', 'A팀 12 · B팀 12'],
  ];
  for (const [locale, finding, teams] of cases) {
    const i18n = bootRuntime({ search: `?lang=${locale}`, withDocument: false });
    assert.equal(i18n.t('青岚 A-01 · 2 个文件 · 低风险'), finding, `${locale} finding line`);
    assert.equal(i18n.t('A队 12 · B队 12'), teams, `${locale} team footnote`);
    assert.equal(i18n.t('流向').length > 0, true);
    for (const value of [finding, teams]) assertNoColorTeamName(value, `${locale} demo value`);
  }
  const ja = bootRuntime({ search: '?lang=ja-JP', withDocument: false });
  assert.equal(ja.t('流向'), 'フロー', 'ja 流向 must not stay the Chinese word');
  const ko = bootRuntime({ search: '?lang=ko-KR', withDocument: false });
  assert.equal(ko.t('数据解析失败：{0}', ['x']), '데이터 분석 실패: x');
  assert.equal(/[\u3400-\u9fff]/u.test(ko.t('数据解析失败：{0}', ['x'])), false);
});

test('demo member and task fixtures stay language neutral in the static HTML', () => {
  const HAN = /[\u3400-\u9fff]/u;
  const DEMO_NICKNAMES = ['青岚', '赤霄', '星野', '沧澜', '惊蛰', '长风', '墨白'];
  // Every fixture nickname is gone from the source document; a seat code is
  // readable in any locale and cannot be mistaken for a real member name.
  for (const name of DEMO_NICKNAMES) {
    assert.equal(view.includes(name), false, `static view still hard-codes the demo nickname ${name}`);
  }
  assert.equal((view.match(/>青<|>赤<|>星<|>沧<|>惊<|>长<|>墨<|>外</gu) ?? []).length, 0, 'demo avatars must use neutral initials');
  // Demo task titles are catalog keys, so the runtime can translate them.
  for (const title of ['跨队输入汇总', '接口契约冻结', '风险模型建立', '基线交付包', '影子联调', '项目基线对齐', '回归证据复核', '优惠券金额格式化']) {
    assert.ok(HAN.test(title));
    assert.match(view, new RegExp(title, 'u'), `${title} must stay a translatable source string`);
  }
  // The stable task ids stay verbatim so A-Tn/B-Tn never drift.
  for (const id of ['A-T2', 'A-T3a', 'A-T3b', 'B-T3b', 'B-T4', 'B-T5b', 'A-T1']) {
    assert.match(view, new RegExp(`data-i18n-skip>${id}<|data-i18n-skip>${id} <|>${id} <`, 'u'), `${id} must be kept verbatim`);
  }
  const en = bootRuntime({ search: '?lang=en-US', withDocument: false });
  for (const title of ['跨队输入汇总', '接口契约冻结', '基线交付包', '影子联调', '优惠券金额格式化']) {
    assert.notEqual(en.t(title), title, `en-US must translate the demo title ${title}`);
  }
});

test('live owner fallbacks and role/kind labels are translated', () => {
  const en = bootRuntime({ search: '?lang=en-US', withDocument: false });
  // The value the live model exposes for a removed/unassigned owner.
  assert.equal(en.t('已移除成员'), 'Removed member');
  assert.equal(en.t('未分配'), 'Unassigned');
  assert.equal(/[\u3400-\u9fff]/u.test(en.t('已移除成员')), false);
  assert.equal(/[\u3400-\u9fff]/u.test(en.t('未分配')), false);
  // roleLabel/kindLabel output goes through the same translator.
  for (const label of ['工程师', '审核员', '实现工程师', '验证员', '审计员', '交付审核', '工作', '集成']) {
    const rendered = en.t(label);
    assert.notEqual(rendered, label, `en-US: ${label} is not translated`);
    assert.equal(/[\u3400-\u9fff]/u.test(rendered), false, `en-US: ${label} renders Han characters: ${rendered}`);
  }
  // The live model must route both fallbacks through tr(), not raw literals.
  assert.match(live, /tr\('已移除成员'\)/u);
  assert.match(live, /tr\('未分配'\)/u);
  assert.match(live, /const role = task\.assigneeRole \? tr\(roleLabel\(task\.assigneeRole\)\)/u);
});

// Execute the real graph-title truncation from assets/team-view-app.js so the
// script-adaptive behaviour is proven, not just its source shape.
function graphTitleTruncation(nodeW = 124) {
  const start = app.indexOf('      // Node titles sit in a fixed-width box');
  const end = app.indexOf('      const stripTeamPrefix = (value) =>', start);
  assert.ok(start >= 0 && end > start, 'the truncation block is contiguous');
  const context = { nodeW };
  vm.runInNewContext(
    `${app.slice(start, end)}\nglobalThis.truncateTitle = truncateTitle;\nglobalThis.textWidth = textWidth;`,
    context,
  );
  return { truncateTitle: context.truncateTitle, textWidth: context.textWidth, budget: nodeW - 20 };
}

test('the graph title truncation adapts to the script instead of a fixed codepoint count', () => {
  // A fixed 6-codepoint slice rendered "Projec…" for en-US.
  assert.equal(app.includes('clean.slice(0, 6)'), false, 'the fixed 6-codepoint truncation must be gone');
  assert.match(app, /const truncateTitle = \(text\) =>/u);
  assert.match(app, /const isWideGlyph = \(char\) =>/u);
  assert.match(app, /const NODE_TITLE_BUDGET_PX = nodeW - 20;/u);
  // The prefix strip covers the localized team labels, not only the zh-CN one.
  assert.match(app, /const stripTeamPrefix = \(value\) =>/u);
  for (const prefix of ['A队', 'B队', 'A team', 'B team', 'Aチーム', 'Bチーム', 'A팀', 'B팀']) {
    assert.ok(app.includes(prefix), `stripTeamPrefix must know ${prefix}`);
  }

  const { truncateTitle, textWidth, budget } = graphTitleTruncation();
  // Latin text keeps a usable prefix: more than the old 6 codepoints.
  const latin = truncateTitle('Project baseline alignment');
  assert.match(latin, /^Project basel/u, `en-US lost its prefix: ${latin}`);
  assert.ok([...latin.replace('…', '')].length >= 10, `en-US prefix too short: ${latin}`);
  // CJK stays around 6 characters because each glyph is ~13px wide.
  const cjk = truncateTitle('超宽中日文字符串测试用');
  const cjkPrefix = [...cjk.replace('…', '')].length;
  assert.ok(cjkPrefix >= 4 && cjkPrefix <= 7, `CJK prefix out of range: ${cjk}`);
  // The ellipsis appears only when the title was actually shortened.
  assert.equal(truncateTitle('短'), '短');
  assert.equal(truncateTitle('implementation').endsWith('…'), false);
  // Never exceed the node budget, for any script.
  for (const sample of ['Project baseline alignment', 'AVeryLongCamelCaseIdentifierName', 'WWWWWWWWWWWWWWWW', '한국어 아주 긴 제목입니다', '超宽中日文字符串测试用']) {
    assert.ok(textWidth(truncateTitle(sample)) <= budget, `title overflows the node: ${sample}`);
  }
  // Localized demo prefixes are stripped before truncation.
  assert.match(app, /stripTeamPrefix\(subject\)/u);
});

test('demo merge titles translate at value level while live subjects stay verbatim', () => {
  const en = bootRuntime({ search: '?lang=en-US', withDocument: false });
  assert.equal(en.t('优惠券金额格式化'), 'Coupon amount formatting');
  assert.equal(en.t('订单列表空状态'), 'Order list empty state');
  assert.equal(en.t('支付回调幂等性回归'), 'Payment callback idempotency regression');
  const ja = bootRuntime({ search: '?lang=ja-JP', withDocument: false });
  assert.equal(ja.t('订单列表空状态'), '注文一覧の空状態');
  // The render path uses the split title for demo rows and the raw subject for
  // live rows; a live subject has no titleKey so it is never translated.
  assert.match(app, /const mergeTitle = \(item\) => \(item\?\.titleKey \? `\$\{item\.titleId\} \$\{tt\(item\.titleKey\)\}` : \(item\?\.title \?\? ''\)\);/u);
  assert.match(app, /setText\('#merge-hero-title', mergeTitle\(data\)\)/u);
  assert.match(app, /escapeHtml\(mergeTitle\(item\)\)/u);
});

// --- mutation checks -------------------------------------------------------
// These mutate an in-memory catalog and run the same validator the ship tests
// use, proving the guard fails on the regression instead of only passing on the
// good catalog. Without this a "put it back" edit could stay green.

const HAN_TEXT = /[\u3400-\u9fff]/u;

/** Validate one catalog the way the ship-time assertions do. */
function catalogViolations(catalog, locale) {
  const problems = [];
  // 双队/单队 name a team count, not one specific team, so they are checked for
  // colour names only while the A/B marker is required on the per-team labels.
  const countKeys = new Set(['双队', '单队']);
  for (const key of TEAM_LABEL_KEYS.concat([...countKeys])) {
    const value = catalog.strings[key];
    if (!value) { problems.push(`${locale}: missing ${key}`); continue; }
    for (const banned of COLOR_TEAM_NAMES) {
      if (value.includes(banned)) problems.push(`${locale}/${key} contains the colour name ${banned}: ${value}`);
    }
    if (countKeys.has(key)) continue;
    if (!/(A|B)/u.test(value)) problems.push(`${locale}/${key} does not name a team: ${value}`);
  }
  if (locale === 'en-US' || locale === 'ko-KR') {
    for (const [key, value] of Object.entries(catalog.strings)) {
      if (['简体中文', '日本語', '한국어', 'English'].includes(value)) continue;
      if (HAN_TEXT.test(value)) problems.push(`${locale}: ${key} contains Han: ${value}`);
    }
    for (const pattern of catalog.patterns) {
      if (HAN_TEXT.test(pattern.target)) problems.push(`${locale}: pattern ${pattern.source} contains Han: ${pattern.target}`);
    }
  }
  for (const key of ['青岚 A-01 · 2 个文件 · 低风险', 'A-01 · 2 个文件 · 低风险']) {
    const value = catalog.strings[key];
    if (value && value.includes('青岚')) problems.push(`${locale}: ${key} renders a Chinese nickname: ${value}`);
  }
  return problems;
}

const CATALOG_MUTATION_CASES = [
  {
    name: 'A队 reverted to the old colour name',
    locale: 'en-US',
    apply: (data) => { data.strings['A队'] = 'Blue team'; },
    expect: /contains the colour name Blue team/u,
  },
  {
    name: '双队 reverted to a colour pair',
    locale: 'zh-CN',
    apply: (data) => { data.strings['双队'] = '蓝队 + 绿队'; },
    expect: /contains the colour name 蓝队/u,
  },
  {
    name: 'B队 reverted to a Japanese colour name',
    locale: 'ja-JP',
    apply: (data) => { data.strings['B队'] = 'グリーンチーム'; },
    expect: /contains the colour name グリーンチーム/u,
  },
  {
    name: 'a ko label reverted to Chinese',
    locale: 'ko-KR',
    apply: (data) => { data.strings['总览'] = '总览'; },
    expect: /contains Han/u,
  },
  {
    name: 'the ko 解析 leak reintroduced',
    locale: 'ko-KR',
    apply: (data) => {
      const pattern = data.patterns.find((item) => item.source === '数据解析失败：{0}');
      pattern.target = '데이터解析 실패: {0}';
    },
    expect: /contains Han/u,
  },
  {
    name: 'the demo finding line restored to a nickname',
    locale: 'en-US',
    apply: (data) => { data.strings['A-01 · 2 个文件 · 低风险'] = '青岚 A-01 · 2 files · low risk'; },
    expect: /renders a Chinese nickname/u,
  },
  {
    name: 'a ko team label reverted to Korean colour words',
    locale: 'ko-KR',
    apply: (data) => { data.strings['A队'] = '블루 팀'; },
    expect: /contains the colour name 블루 팀/u,
  },
];

test('the catalog validator passes on the shipped catalogs and fails on each reviewed regression', () => {
  const locales = loadLocales(resolve('.'));
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    assert.deepEqual(catalogViolations(locales[locale], locale), [], `${locale} catalog must be clean`);
  }
  for (const item of CATALOG_MUTATION_CASES) {
    const copy = JSON.parse(JSON.stringify(locales[item.locale]));
    const before = JSON.stringify(copy);
    item.apply(copy);
    assert.notEqual(JSON.stringify(copy), before, `${item.name}: the mutation changed nothing`);
    const problems = catalogViolations(copy, item.locale);
    assert.ok(problems.length > 0, `${item.name}: the validator did not notice the regression`);
    assert.ok(
      problems.some((problem) => item.expect.test(problem)),
      `${item.name}: expected a ${item.expect} violation, got ${JSON.stringify(problems)}`,
    );
  }
});

test('live data stays verbatim while demo fixtures localize (mutation guard)', () => {
  const en = bootRuntime({ search: '?lang=en-US', withDocument: false });
  // A live subject that happens to match a demo vocabulary word is still user
  // data; only the demo path is keyed by id. Prove the two paths differ.
  const liveSubject = '跨队输入汇总';
  assert.notEqual(en.t(liveSubject), liveSubject, 'the dictionary would rewrite it');
  const row = taskListRow();
  const html = row({
    task: { id: 'live-1', displayId: 'A-T9', subject: liveSubject, owner: '青岚', status: 'active' },
    deps: '—',
    selected: false,
    tt: en.t,
  });
  assert.ok(html.includes(`>${liveSubject}</b>`), 'a live subject renders verbatim');
  assert.ok(html.includes('Owner · 青岚'), 'a live owner renders verbatim');
  assert.equal(html.includes('Cross-team input summary'), false, 'the demo translation must not leak into live data');
  assert.equal(html.includes('Owner · A team'), false);
});

// --- executed demo-path guards --------------------------------------------
// The previous guard for this area only asserted that `localizeDemoDetail`
// existed in the source. Replacing the whole helper with an identity function
// kept the suite green while every merged-state cell rendered Chinese in
// en-US/ja-JP/ko-KR. These tests execute the shipped code and compare values.

const HAN = /[\u3400-\u9fff]/u;

/** Extract a contiguous slice of assets/team-view-app.js between two anchors. */
function appSlice(startAnchor, endAnchor) {
  const start = app.indexOf(startAnchor);
  assert.ok(start >= 0, `missing start anchor: ${startAnchor}`);
  const end = app.indexOf(endAnchor, start);
  assert.ok(end > start, `missing end anchor after ${startAnchor}: ${endAnchor}`);
  return app.slice(start, end);
}

/**
 * Execute the real demo-detail helpers plus the demo fixtures. `taskDetails`
 * and `demoTaskCopy` live in the app's IIFE, so the slice is evaluated with the
 * packaged runtime bound to `tt` and `LIVE_MODEL = null` (the demo path).
 */
function demoDetailHarness(locale, runtime = null) {
  const i18n = runtime ?? bootRuntime({ search: `?lang=${locale}`, withDocument: false });
  const fixtures = appSlice('      const demoTaskCopy = {', '      const demoTaskTeam = ');
  const helpers = appSlice('      const demoTaskTeam = ', '      const applyTask = ');
  const context = {
    tt: (source, values) => i18n.t(source, values),
    LIVE_MODEL: null,
  };
  vm.runInNewContext(
    `${fixtures}\n${helpers}\nglobalThis.api = { localizeDemoDetail, taskDetails, demoTaskCopy };`,
    context,
  );
  return { i18n, ...context.api };
}

/**
 * Execute the real member fixtures and scope localizer. `applyMember` writes
 * through `root.querySelector`, so the harness records every #detail-scope
 * write and returns the rendered value.
 */
function memberScopeHarness(locale) {
  const i18n = bootRuntime({ search: `?lang=${locale}`, withDocument: false });
  // This slice already contains memberData and localizeDemoScope, which is
  // declared just above applyMember.
  const block = appSlice('      const memberData = LIVE_MODEL?.memberData ?? {', '      const applyMember = ');
  const written = new Map();
  const element = (selector) => ({
    dataset: {},
    get textContent() { return written.get(selector) ?? ''; },
    set textContent(value) { written.set(selector, String(value)); },
    className: '',
    value: '',
    setAttribute() {},
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const controls = appSlice('      const CONTROL_MEMBER_ROLES = ', '      const activeMemberCount = ');
  const context = {
    tt: (source, values) => i18n.t(source, values),
    tr: (source, values) => i18n.t(source, values),
    LIVE_MODEL: null,
    root: { querySelector: (selector) => (selector === '#detail-scope' ? element(selector) : null) },
  };
  vm.runInNewContext(
    `${block}\n${controls}\nglobalThis.api = { memberData, localizeDemoScope };`,
    context,
  );
  return { i18n, written, ...context.api };
}

test('every demo merged-state cell renders the target locale, not Chinese (en/ja/ko)', () => {
  // The 8 merged states named in the review, plus the two composite waits that
  // exercise the 等待 branch and the whole-phrase entries.
  const EXPECTED = {
    'en-US': {
      t3: 'Waiting A team A-T4a',
      t5: 'Waiting A team A-T5',
      t9: 'Waiting for B team B-T5b evidence',
      t12: 'Waiting for B team B-T8 audit',
      b6: 'Delivered',
      b7: 'Waiting for A team A-T3a contract',
      b11: 'Waiting B team B-T6 · A team A-T6b',
      b12: 'Waiting B team B-T7',
    },
    'ko-KR': {
      t3: '대기 중 A팀 A-T4a',
      t5: '대기 중 A팀 A-T5',
      t9: 'B팀 B-T5b 증거 대기',
      t12: 'B팀 B-T8 감사 대기',
      b6: '전달됨',
      b7: 'A팀 A-T3a 계약 대기',
      b11: '대기 중 B팀 B-T6 · A팀 A-T6b',
      b12: '대기 중 B팀 B-T7',
    },
  };
  const JA_EXPECTED = {
    t3: '待機中 Aチーム A-T4a',
    b6: '納品済み',
    b11: '待機中 Bチーム B-T6 · Aチーム A-T6b',
  };

  for (const locale of ['en-US', 'ko-KR']) {
    const { localizeDemoDetail, taskDetails } = demoDetailHarness(locale);
    for (const [id, expected] of Object.entries(EXPECTED[locale])) {
      const source = taskDetails[id].merge;
      assert.equal(typeof source, 'string', `${locale}/${id} has a merge cell`);
      const rendered = localizeDemoDetail(source);
      assert.equal(rendered, expected, `${locale}/${id} rendered ${JSON.stringify(rendered)} from ${JSON.stringify(source)}`);
      assert.equal(HAN.test(rendered), false, `${locale}/${id} still contains Han characters: ${rendered}`);
    }
  }
  // Japanese legitimately uses kanji; assert the value, not the codepoint range.
  const ja = demoDetailHarness('ja-JP');
  for (const [id, expected] of Object.entries(JA_EXPECTED)) {
    assert.equal(ja.localizeDemoDetail(ja.taskDetails[id].merge), expected, `ja-JP/${id}`);
  }
  assert.equal(ja.localizeDemoDetail(ja.taskDetails.b6.merge), '納品済み', 'b6 is 納品済み, not the Chinese 已递送');
  assert.notEqual(ja.localizeDemoDetail(ja.taskDetails.b6.merge), ja.taskDetails.b6.merge);

  // zh-CN keeps the source wording. The catalog's `等待 {0}` target is
  // `等待 {0}`, so a source cell written without a space (`等待A队 A-T4a`)
  // legitimately reads back with one; the value is still Chinese and the ids
  // are unchanged.
  const zh = demoDetailHarness('zh-CN');
  const normalizeSpace = (value) => String(value).replace(/^等待\s*/u, '等待 ');
  for (const id of ['t3', 't5', 't9', 't12', 'b6', 'b7', 'b11', 'b12']) {
    const rendered = zh.localizeDemoDetail(zh.taskDetails[id].merge);
    assert.equal(rendered, normalizeSpace(zh.taskDetails[id].merge), `zh-CN/${id} stays Chinese`);
    assert.equal(rendered.includes('A-T') || rendered.includes('B-T') || rendered === '已递送', true, `zh-CN/${id} keeps its identity`);
  }
});

test('the 等待 regex matches whitespace, so a wait cell never falls through', () => {
  // The shipped regex once read /^等待\\s*/u (literal backslash + "s"), which
  // never matched; every 等待 cell then returned its Chinese source. Assert the
  // literal source shape and the executed behaviour.
  assert.equal(app.includes('^等待\\\\s*'), false, 'the broken /^等待\\\\s*/u regex must not come back');
  assert.match(app, /const localizeDemoSegment = \(segment\) => \{/u);
  assert.match(app, /\^等待/u);

  const { localizeDemoDetail } = demoDetailHarness('en-US');
  // Mixed spacing and no spacing must both reach the 等待 pattern.
  assert.equal(localizeDemoDetail('等待A队 A-T4a'), 'Waiting A team A-T4a');
  assert.equal(localizeDemoDetail('等待 A队 A-T4a'), 'Waiting A team A-T4a');
  assert.equal(localizeDemoDetail('等待A队 A-T5'), 'Waiting A team A-T5');
  // A whole-string entry outranks the wait branch.
  assert.equal(localizeDemoDetail('等待输入冻结'), 'Waiting for input freeze');
  // Live mode returns the source untouched.
  const helpers = appSlice('      const localizeDemoDetail = (value) => {', '      const demoWait = ');
  const liveContext = { tt: (source) => source, LIVE_MODEL: {} };
  vm.runInNewContext(`${helpers}\nglobalThis.api = localizeDemoDetail;`, liveContext);
  assert.equal(liveContext.api('等待A队 A-T4a'), '等待A队 A-T4a', 'the live path stays verbatim');
});

test('all seven demo member scopes localize their fixed copy (en/ja/ko)', () => {
  const FORBIDDEN = ['验证', '只读', '实现', '修复', '审核', '需求', '文档', '归档', '交付'];
  const EXPECTED = {
    'en-US': {
      order: 'Implementation, fixes · src/v1.88-modular/**',
      build: 'Verification · tests/**',
      release: 'Docs, archiving · docs/**',
      review: 'Review, requirements · Read-only',
      refactor: 'Implementation · src/v1.88/**',
      betaDelivery: 'Delivery',
      betaEngineer: 'Implementation',
    },
    'ko-KR': {
      order: '구현, 수정 · src/v1.88-modular/**',
      build: '검증 · tests/**',
      release: '문서, 아카이브 · docs/**',
      review: '검토, 요구사항 · 읽기 전용',
      refactor: '구현 · src/v1.88/**',
      betaDelivery: '납품',
      betaEngineer: '구현',
    },
  };

  for (const locale of ['en-US', 'ko-KR']) {
    const { memberData, localizeDemoScope } = memberScopeHarness(locale);
    assert.equal(Object.keys(memberData).length, 7, `${locale} renders seven demo members`);
    for (const [id, expected] of Object.entries(EXPECTED[locale])) {
      const source = memberData[id].scope;
      const rendered = localizeDemoScope(source);
      assert.equal(rendered, expected, `${locale}/${id} scope rendered ${JSON.stringify(rendered)} from ${JSON.stringify(source)}`);
      // Real paths stay verbatim; only the fixed wording must disappear.
      for (const word of FORBIDDEN) {
        assert.equal(rendered.includes(word), false, `${locale}/${id} scope still contains ${word}: ${rendered}`);
      }
      for (const path of ['tests/**', 'docs/**', 'src/v1.88/**', 'src/v1.88-modular/**']) {
        if (source.includes(path)) assert.ok(rendered.includes(path), `${locale}/${id} lost the real path ${path}: ${rendered}`);
      }
    }
  }

  // ja-JP: the fixed 只读 qualification must be Japanese, not passed through.
  const ja = memberScopeHarness('ja-JP');
  assert.equal(ja.localizeDemoScope(ja.memberData.review.scope), 'レビュー、要件 · 読み取り専用');
  assert.equal(ja.localizeDemoScope(ja.memberData.build.scope), '検証 · tests/**');
  assert.equal(ja.localizeDemoScope(ja.memberData.release.scope), 'ドキュメント、アーカイブ · docs/**');
});

// Mutation guards for the executed assertions above. Each mutation reproduces
// one reviewed regression and must make the value-level check fail — a green
// result on the mutated input would mean the guard is dead.
test('the executed demo-path guards fail on each reviewed regression', () => {
  // Rebuild the runtime with a mutated catalog so a deleted key or pattern is
  // exercised by the real translator, not by a mocked one.
  function runtimeWithCatalog(catalog) {
    const source = runtimeCode.replace(/var DATA = [\s\S]*?;\n  var LOCALES/u, `var DATA = ${JSON.stringify({ 'en-US': catalog })};\n  var LOCALES`);
    assert.notEqual(source, runtimeCode, 'the runtime DATA block was replaced');
    const window = { location: { search: '?lang=en-US' }, navigator: { language: 'en-US' } };
    vm.runInNewContext(source, {
      window, document: undefined, navigator: window.navigator, Intl, Date, WeakMap, URLSearchParams,
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    });
    return window.AGT_I18N;
  }

  function scopeFrom(i18n) {
    const block = appSlice('      const memberData = LIVE_MODEL?.memberData ?? {', '      const applyMember = ');
    const context = {
      tt: (source, values) => i18n.t(source, values),
      tr: (source, values) => i18n.t(source, values),
      LIVE_MODEL: null,
    };
    vm.runInNewContext(`${block}\nglobalThis.api = { memberData, localizeDemoScope };`, context);
    return context.api;
  }

  // 1. The broken regex. Re-run the shipped helper body with `\\s` restored.
  {
    const i18n = bootRuntime({ search: '?lang=en-US', withDocument: false });
    const shipped = appSlice('      const localizeDemoWords = ', '      const demoWait = ');
    assert.match(shipped, /const wait = \/\^等待\\s\*\(\?=\\S\)\/u\.exec\(segment\);/u,
      'the shipped segment helper still carries a working whitespace regex');
    const broken = shipped.replace(/const wait = \/\^等待\\s\*\(\?=\\S\)\/u\.exec\(segment\);/u,
      'const wait = /^等待\\\\s*(?=\\\\S)/u.exec(segment);');
    assert.notEqual(broken, shipped, 'the mutation applied to the shipped helper');
    assert.equal(broken.includes('/^等待\\\\s*(?=\\\\S)/u.exec(segment)'), true,
      'the mutated slice carries the literal-backslash regex the review rejected');
    const context = { tt: (source, values) => i18n.t(source, values), LIVE_MODEL: null };
    vm.runInNewContext(`${broken}\nglobalThis.api = localizeDemoDetail;`, context);
    const observed = context.api('等待A队 A-T4a');
    assert.notEqual(observed, 'Waiting A team A-T4a', 'the broken regex must not produce the fully translated wait cell');
    assert.match(observed, /等待A队 A-T4a/u, 'the task identity survives, but the wait verb is not translated cleanly');
    assert.notEqual(observed, '等待 A队 A-T4a', 'the broken regex never reaches the dedicated 等待 {0} path');
  }

  // 2. 已递送 removed from the catalog.
  {
    const catalog = JSON.parse(JSON.stringify(loadLocales(resolve('.'))['en-US']));
    assert.ok(catalog.strings['已递送'], 'the shipped catalog carries 已递送');
    delete catalog.strings['已递送'];
    const i18n = runtimeWithCatalog(catalog);
    assert.equal(i18n.t('已递送'), '已递送', 'without the key the merge state stays Chinese');
    const { localizeDemoDetail, taskDetails } = demoDetailHarness('en-US', i18n);
    assert.equal(localizeDemoDetail(taskDetails.b6.merge), '已递送', 'the b6 guard would fail on this mutation');
  }

  // 3. The 验证 single key removed. The helper falls back to translating each
  //    ` · ` segment, so the pattern alone is not the guard: without the key no
  //    path can translate the qualification.
  {
    const catalog = JSON.parse(JSON.stringify(loadLocales(resolve('.'))['en-US']));
    assert.ok(catalog.strings['验证'], 'the shipped catalog carries the 验证 key');
    delete catalog.strings['验证'];
    const index = catalog.patterns.findIndex((pattern) => pattern.source === '验证 · {0}');
    if (index >= 0) catalog.patterns.splice(index, 1);
    const i18n = runtimeWithCatalog(catalog);
    assert.equal(i18n.t('验证'), '验证', 'without the key the qualification stays Chinese');
    const observed = scopeFrom(i18n).localizeDemoScope('验证 · tests/**');
    assert.equal(HAN.test(observed), true, 'this mutation reintroduces Han characters, so the scope guard fails');
  }

  // 4. The fixed review-scope cell removed: the generic pattern then passes 只读
  //    through as an untranslated argument, which is the reported P2-2 shape.
  {
    const catalog = JSON.parse(JSON.stringify(loadLocales(resolve('.'))['en-US']));
    assert.ok(catalog.strings['审核、需求 · 只读'], 'the shipped catalog carries the fixed review scope');
    delete catalog.strings['审核、需求 · 只读'];
    const i18n = runtimeWithCatalog(catalog);
    const observed = scopeFrom(i18n).localizeDemoScope('审核、需求 · 只读');
    assert.equal(observed, 'Review, requirements · 只读', 'the qualification rides through untranslated');
    assert.equal(HAN.test(observed), true, 'this mutation reintroduces Han characters, so the scope guard fails');
  }
});



test('no locale leaves a merged-state term half-translated', () => {
  // `快进失败` is a pure Chinese source string, so a target that keeps the
  // English "Fast-forward" is untranslated, not a faithful loanword. ko-KR had
  // already used a native term, which is what exposed the ja-JP inconsistency.
  const catalogs = loadLocales(resolve('.'));
  const mergedStateKeys = ['快进失败', '快进重试耗尽'];
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    for (const key of mergedStateKeys) {
      const value = catalogs[locale].strings[key];
      assert.ok(value, `${locale} is missing ${key}`);
      if (locale === 'ja-JP') {
        assert.ok(!/Fast-forward/i.test(value),
          `ja-JP ${key} must not keep the English term: ${value}`);
        assert.match(value, /ファストフォワード/, `ja-JP ${key} must use the kana term: ${value}`);
      } else if (locale === 'ko-KR') {
        assert.ok(!/[A-Za-z]/.test(value), `ko-KR ${key} must be fully localized: ${value}`);
      }
    }
  }
});
