import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { isStandalone } from '../ui-src/panel-host.js';
import { phaseLabel, taskStatusLabel, teamLabel } from '../ui-src/panel-labels.js';
import { loadLocales } from '../scripts/build-i18n.mjs';

const panel = readFileSync(new URL('../assets/team-panel.html', import.meta.url), 'utf8');
const scripts = [...panel.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]);
const dictionaries = loadLocales(fileURLToPath(new URL('..', import.meta.url)));

/** A minimal translator backed by the real catalog for one locale. */
function translator(locale) {
  const dict = dictionaries[locale];
  const interpolate = (text, values) => String(text).replace(/\{(\d+)\}/gu, (token, index) => (
    values && Number(index) < values.length ? String(values[Number(index)]) : token
  ));
  const patterns = dict.patterns.map((pattern) => {
    const parts = String(pattern.source).split(/(\{\d+\})/u);
    const placeholders = parts.filter((part) => /^\{\d+\}$/u.test(part)).length;
    let seen = 0;
    const body = parts.map((part) => {
      if (/^\{\d+\}$/u.test(part)) {
        seen += 1;
        return seen === placeholders ? '([\\s\\S]+)' : '([\\s\\S]+?)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    }).join('');
    return { regex: new RegExp(`^${body}$`), target: pattern.target };
  });
  return (source, values) => {
    const key = String(source);
    if (dict.strings[key] !== undefined) return interpolate(dict.strings[key], values);
    for (const pattern of patterns) {
      const match = pattern.regex.exec(key);
      if (match) return interpolate(pattern.target, match.slice(1));
    }
    return interpolate(key, values);
  };
}

test('isStandalone detects a browser tab and a hosted iframe', () => {
  const tab = {};
  tab.parent = tab;
  assert.equal(isStandalone(tab), true);
  assert.equal(isStandalone({ parent: { postMessage() {} } }), false);
  assert.equal(isStandalone({}), true, 'a window without a parent has no host');
  assert.equal(isStandalone(null), true);
  assert.equal(isStandalone(undefined), true);
});

test('the retired budget_paused control still gets a label, not "running"', () => {
  const t = translator('en-US');
  assert.equal(phaseLabel('running', 'budget_paused', t), 'Budget paused');
  assert.equal(phaseLabel('running', 'halted', t), 'Stopped');
  assert.equal(phaseLabel('running', 'escalated', t), 'Escalated');
  assert.equal(phaseLabel('running', 'active', t), 'Running');
  assert.equal(phaseLabel('running', 'unknown-control', t), 'Running');
  // Every catalog has the label, so no locale falls back to Chinese.
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    assert.ok(dictionaries[locale].strings['预算暂停'], `${locale} is missing 预算暂停`);
    assert.equal(phaseLabel('running', 'budget_paused', translator(locale)), dictionaries[locale].strings['预算暂停']);
  }
  assert.equal(taskStatusLabel('in_progress', translator('en-US')), 'In progress');
  assert.equal(taskStatusLabel('done', translator('ko-KR')), dictionaries['ko-KR'].strings['已完成']);
  assert.equal(teamLabel('Alpha', 'alpha', translator('ja-JP')), dictionaries['ja-JP'].strings['A队']);
  assert.equal(teamLabel('Beta', 'beta', translator('en-US')), dictionaries['en-US'].strings['B队']);
  assert.equal(teamLabel('小队', 'custom', translator('en-US')), '小队', 'a custom team name stays verbatim');
});

test('a standalone panel explains itself and never calls app.connect', async () => {
  const result = await bootPanel({ standalone: true, locale: 'en-US', label: 'standalone en-US' });
  assert.equal(result.status, 'Open this panel from ZCode; a standalone browser cannot reach the host.');
  assert.equal(result.disabled, true, 'refresh is disabled without a host');
  assert.equal(result.posts.length, 0, 'app.connect must not run in a browser tab');
  assert.equal(result.lang, 'en-US');

  const japanese = await bootPanel({ standalone: true, locale: 'ja-JP', label: 'standalone ja-JP' });
  assert.equal(japanese.status, dictionaries['ja-JP'].strings['请在 ZCode 中打开此面板；独立浏览器无法连接宿主。']);
  assert.notEqual(japanese.status, dictionaries['zh-CN'].strings['请在 ZCode 中打开此面板；独立浏览器无法连接宿主。']);
  assert.match(japanese.status, /[\u3040-\u30ff]/u, 'the notice is rendered in Japanese, not the Chinese source');
  assert.equal(japanese.posts.length, 0);

  const hosted = await bootPanel({ standalone: false, locale: 'en-US', label: 'hosted' });
  assert.equal(hosted.disabled, false);
  assert.equal(hosted.posts.length, 1, 'a hosted panel opens the MCP channel');
  assert.equal(hosted.posts[0]?.method, 'ui/initialize');
});

/**
 * Run the packaged panel exactly as a browser would: the embedded catalog
 * runtime, the lang bootstrap and the bundled panel script, against a small
 * DOM adapter. Resolves after a macrotask so app.connect has a chance to post.
 */
function bootPanel({ standalone, locale }) {
  const elements = new Map();
  const element = (id) => ({
    id, textContent: '', innerHTML: '', disabled: false, title: '', className: '',
    dataset: {}, style: {}, listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: { add() {}, toggle() {} },
  });
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const document = {
    documentElement: {
      dataset: {},
      attributes: new Map(),
      setAttribute(name, value) { this.attributes.set(name, value); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
    },
    readyState: 'complete',
    getElementById: byId,
    querySelectorAll: () => [],
    addEventListener() {},
    dispatchEvent() {},
  };
  const posts = [];
  const window = {
    document,
    location: { search: `?lang=${locale}` },
    navigator: { language: 'en-US' },
    addEventListener() {},
    postMessage(...args) { posts.push(args); },
  };
  window.parent = standalone ? window : { postMessage(...args) { posts.push(args); } };
  const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  // Timers are inert: the panel only needs them for polling and request
  // timeouts, and a live interval would keep the test process open.
  const context = {
    window, document, navigator: window.navigator, location: window.location, console: quiet,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, queueMicrotask,
    URL, URLSearchParams,
    MessageChannel: class {
      constructor() {
        this.port1 = { onmessage: null };
        this.port2 = { onmessage: null, postMessage() {} };
      }
    },
    MessageEvent: class {
      constructor(type, init) { this.type = type; this.data = init?.data; }
    },
    CustomEvent: class {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
    Event: class {
      constructor(type) { this.type = type; }
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const script of scripts) vm.runInContext(script, context);
  // Let the async boot path reach its first `await` before reading the DOM.
  return new Promise((resolve) => {
    setImmediate(() => setImmediate(() => resolve({
      status: byId('status').textContent,
      disabled: byId('refresh').disabled,
      lang: document.documentElement.attributes.get('lang'),
      posts: posts.map(([message]) => message),
    })));
  });
}
