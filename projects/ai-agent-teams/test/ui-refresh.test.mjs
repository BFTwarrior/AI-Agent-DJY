import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../assets/team-view.html', import.meta.url), 'utf8');
const stream = readFileSync(new URL('../assets/team-view-stream.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../assets/team-view-app.js', import.meta.url), 'utf8');
const patrolApp = readFileSync(new URL('../assets/team-view-patrol.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/team-view.css', import.meta.url), 'utf8');
const source = `${html}\n${stream}`;

test('team view coalesces SSE refreshes instead of reloading per event', () => {
  // Regression: every store event used to schedule location.reload() 300ms
  // later, so a running team reloaded the page in a tight loop.
  assert.equal((source.match(/location\.reload\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(source, /setTimeout\(\(\) => location\.reload\(\), 300\)/);
  assert.match(source, /agent-teams-ui-last-reload/);
  assert.match(source, /agent-teams-ui-last-input/);
  assert.match(source, /idleFor < 15000/u);
  assert.match(source, /30000 - \(now - lastReloadAt\)/u);
  assert.match(source, /document\.hidden/u);
  // Throttle, not debounce: continuous SSE events cannot postpone the timer.
  assert.match(source, /if \(timer\) return;/u);
  assert.doesNotMatch(source, /clearTimeout\(timer\)/u);
});

test('team view keeps immediate patrol in the top bar only', () => {
  const patrol = html.match(/<section class="page" id="page-patrol">([\s\S]*?)<\/section>/u)?.[1] ?? '';
  const settings = html.match(/<section class="page" id="page-settings">([\s\S]*?)<\/section>/u)?.[1] ?? '';
  const topPatrol = html.match(/<button[^>]*id="top-patrol"[^>]*>/u)?.[0] ?? '';
  assert.match(topPatrol, /aria-label="立即巡检"/u);
  assert.doesNotMatch(topPatrol, /data-nav=/u);
  assert.doesNotMatch(patrol, /id="patrol-now"/u);
  assert.doesNotMatch(patrol, /创建巡检工/u);
  assert.doesNotMatch(patrol, /page-actions/u);
  assert.doesNotMatch(settings, /page-actions/u);
  assert.doesNotMatch(settings, /设置已保存/u);
  assert.doesNotMatch(app, /patrolNow|saveSettings/u);
  assert.doesNotMatch(app, /#top-patrol/u);
  assert.doesNotMatch(patrolApp, /admin|authorization|localStorage|sessionStorage/u);
  assert.match(patrolApp, /fetch\(`\/api\/v1\/teams\/\$\{encodeURIComponent\(team\.id\)\}\/patrol`/u);
  assert.match(patrolApp, /credentials:\s*'same-origin'/u);
  assert.match(patrolApp, /巡检已排队/u);
  assert.doesNotMatch(css, /#top-patrol[^{}]*\{[^}]*display:\s*none/u);
});

test('team view persists the full-access mode per console path', () => {
  assert.match(app, /agent-teams-run-mode-v1:\$\{location\.pathname\}/u);
  assert.match(app, /localStorage\.getItem\(runModeKey\) === 'full'/u);
  assert.match(app, /localStorage\.setItem\(runModeKey, full \? 'full' : 'standard'\)/u);
  assert.match(app, /setRunMode\(readRunMode\(\)\)/u);
});

// Execute the actual capacity controls against a small DOM adapter. The roster
// differs from the session limit so a denominator regression cannot pass.
const capacityView = (model = null, storage = new Map()) => {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        textContent: '', value: '', title: '', style: {}, classes, listeners: {},
        classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
        addEventListener(name, callback) { this.listeners[name] = callback; },
      });
    }
    return elements.get(selector);
  };
  const cards = Array.from({ length: 6 }, () => ({}));
  const notices = [];
  const context = {
    root: {
      querySelector: get,
      querySelectorAll(selector) {
        return selector.includes(':not(.contractor)') ? cards : [{}, {}];
      },
    },
    LIVE_MODEL: model, singleTeam: false,
    memberData: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [index, {}])),
    isColdMember: (member) => ['cold', 'unspawned', 'settled', 'removed', 'lost'].includes(member.residency),
    location: { pathname: '/ui' },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    notify: (message) => notices.push(message),
  };
  const start = app.indexOf('      const isColdMember =');
  const end = app.indexOf('      const demoMemberRows =', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(app.slice(start, end), context);
  return {
    get, cards, notices, storage,
    change(value) {
      const input = get('#max-worker-slots');
      input.value = String(value);
      input.listeners.change({ target: input });
    },
  };
};

test('capacity edits synchronize overview, settings and usage without inventing workers', () => {
  const view = capacityView();
  assert.equal(view.get('#overview-worker-current').textContent, '6 / 6');
  view.change(16);
  assert.equal(view.get('#overview-worker-current').textContent, '6 / 16');
  assert.equal(view.get('#overview-worker-bar').style.width, '38%');
  assert.equal(view.get('#settings-worker-capacity').textContent, '16');
  assert.match(view.get('#team-pill').textContent, /16 并发/u);
  assert.match(view.get('#overview-worker-badge').textContent, /并发上限/u);
  assert.match(view.get('#overview-worker-foot').textContent, /名册 7 人/u);
  assert.equal(view.cards.length, 6);
  const reloaded = capacityView(null, view.storage);
  assert.equal(reloaded.get('#overview-worker-current').textContent, '6 / 16');
  view.change(4);
  assert.equal(view.get('#overview-worker-current').textContent, '6 / 4');
  assert.equal(view.get('#overview-worker-bar').style.width, '100%');
  assert.match(view.get('#overview-worker-foot').textContent, /超出上限 2 人/u);
  assert.ok(view.get('#overview-worker-badge').classes.has('amber'));
  view.change(8);
  assert.equal(view.get('#overview-worker-current').textContent, '6 / 8');
  assert.equal(view.get('#overview-worker-bar').style.width, '75%');
  assert.ok(!view.get('#overview-worker-badge').classes.has('amber'));
  const count = view.notices.length;
  view.change('');
  assert.equal(view.get('#max-worker-slots').value, '8');
  assert.equal(view.notices.length, count);
});

test('live capacity stays snapshot-owned, preserves 64 and does not fabricate a missing limit', () => {
  const memberList = [
    { residency: 'warm', teamKey: 'alpha', hasSession: true },
    { residency: 'warm', teamKey: 'beta', hasSession: true },
    { residency: 'cold', teamKey: 'alpha' },
    { residency: 'warm', teamKey: 'alpha' },
  ];
  const view = capacityView({ workerCapacity: 64, memberList, contractorCapacity: 2 });
  assert.equal(view.get('#overview-worker-current').textContent, '2 / 64');
  assert.equal(view.get('#overview-worker-bar').style.width, '3%');
  view.change(16);
  assert.equal(view.get('#overview-worker-current').textContent, '2 / 64');
  assert.equal(view.get('#max-worker-slots').title, '实时快照只读');
  assert.equal(view.storage.size, 0);
  assert.equal(view.notices.length, 0);
  const missing = capacityView({ memberList, contractorCapacity: 2 });
  assert.equal(missing.get('#overview-worker-current').textContent, '2 / —');
  assert.equal(missing.get('#overview-worker-bar').style.width, '0%');
  assert.match(missing.get('#overview-worker-badge').textContent, /待快照/u);
  const idle = capacityView({ workerCapacity: 8, memberList: memberList.slice(2), contractorCapacity: 2 });
  assert.equal(idle.get('#overview-worker-current').textContent, '0 / 8');
  assert.equal(idle.get('#overview-worker-bar').style.width, '0%');
  const warmNoSession = capacityView({
    workerCapacity: 8,
    memberList: [{ residency: 'warm', teamKey: 'alpha' }],
    contractorCapacity: 2,
  });
  assert.equal(warmNoSession.get('#overview-worker-current').textContent, '0 / 8', 'a warm member without a session is not on duty');
  const engineers = Array.from({ length: 6 }, (_, index) => ({
    residency: 'warm', teamKey: index < 3 ? 'alpha' : 'beta', hasSession: true, role: '工程师',
  }));
  const leads = [
    { residency: 'warm', teamKey: 'alpha', hasSession: true, role: '组长', license: { roleKey: 'lead' } },
    { residency: 'warm', teamKey: 'beta', hasSession: true, role: '组长', license: { roleKey: 'lead' } },
  ];
  const withControl = capacityView({ workerCapacity: 6, memberList: [...engineers, ...leads], contractorCapacity: 2 });
  assert.equal(withControl.get('#overview-worker-current').textContent, '6 / 6', 'localized lead seats are not delivery workers');
  assert.ok(!withControl.get('#overview-worker-badge').classes.has('amber'), 'control seats must not fake an over-capacity warning');
  assert.doesNotMatch(withControl.get('#overview-worker-foot').textContent, /超出上限/u);
});

const memberCountsView = (model) => {
  const start = app.indexOf('      const isColdMember =');
  const end = app.indexOf('      const capacityKey =', start);
  assert.ok(start >= 0 && end > start, 'member counting helpers are a contiguous block');
  const context = { LIVE_MODEL: model };
  vm.runInNewContext(`${app.slice(start, end)}
    globalThis.api = { memberDutyCounts, memberDutyFoot, isControlMember };`, context);
  return context.api;
};

test('member duty footnotes keep control seats out of the no-session count', () => {
  const api = memberCountsView({ memberList: [] });
  const counts = api.memberDutyCounts([
    { role: '工程师', residency: 'warm', hasSession: true },
    { role: 'shadow', residency: 'warm', hasSession: true },
    { role: '工程师', residency: 'warm', hasSession: false },
    { role: '工程师', residency: 'unspawned', hasSession: false },
  ]);
  assert.deepEqual({ ...counts }, { active: 1, offDuty: 3, cold: 1, control: 1, noSession: 1 });
  assert.equal(api.memberDutyFoot(counts), '无会话 1 · 控制席 1 · 冷存/待创建 1');
  assert.equal(api.isControlMember({ role: '组长' }), true, 'the live lead label stays a control seat');
  assert.equal(api.isControlMember({ role: '工程师', license: { roleKey: 'lead' } }), true);
  assert.equal(api.isControlMember({ role: '工程师' }), false);
  const withoutControl = api.memberDutyCounts([
    { role: '工程师', residency: 'warm', hasSession: false },
  ]);
  assert.equal(api.memberDutyFoot(withoutControl), '无会话 1 · 冷存/待创建 0', 'zero control seats are omitted');
  const demo = memberCountsView(null).memberDutyCounts([
    { role: '工程师', residency: 'warm', hasSession: false },
    { role: '工程师', residency: 'cold', hasSession: false },
  ]);
  assert.deepEqual({ ...demo }, { active: 1, offDuty: 1, cold: 1, control: 0, noSession: 0 });
  assert.match(app, /querySelector\('\[data-member-cold\]'\)[\s\S]{0,400}String\(offDuty\)/u,
    'data-member-cold keeps counting every off-duty seat');
  assert.match(app, /当前状态 · \$\{dutyFoot\}/u, 'the residency card foot uses the split buckets');
  assert.match(app, /未在岗 \$\{offDuty\} 人（\$\{dutyFoot\}）/u, 'the page head uses the same split buckets');
});

const graphView = (storage = new Map()) => {
  const timers = new Map();
  const frames = [];
  const notices = [];
  const canvas = { clientWidth: 800, clientHeight: 500, scrollLeft: 0, scrollTop: 0 };
  const context = {
    location: { pathname: '/ui' },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    nodeW: 124, nodeH: 52, colGap: 16, rowGap: 16,
    positions: new Map([['a', { x: 0, y: 0 }]]), basePositions: new Map([['a', { x: 0, y: 0 }]]),
    zoom: 1, panX: 0, panY: 0, canvas, updateViewport() {}, notify: (message) => notices.push(message),
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => frames.push(fn),
  };
  const start = app.indexOf('      const graphStateKey =');
  const end = app.indexOf('      let dragging =', start);
  const scrollStart = app.indexOf('      let graphScrollRestorePending =');
  const scrollEnd = app.indexOf('      let panning =', scrollStart);
  assert.ok(start >= 0 && end > start && scrollEnd > scrollStart);
  vm.runInNewContext(app.slice(start, end) + app.slice(scrollStart, scrollEnd) + `
    globalThis.api = {
      saveGraphState, flushGraphState, restoreGraphScroll, captureGraphScroll, resetGraphViewport,
      state: () => ({ zoom, panX, panY, scrollLeft: graphScrollLeft, scrollTop: graphScrollTop }),
    };`, context);
  return { api: context.api, context, canvas, storage, notices, frame: () => frames.splice(0).forEach((fn) => fn()) };
};
const graphKey = 'agent-teams-task-graph-v1:/ui';
const savedGraph = (overrides = {}) => new Map([[graphKey, JSON.stringify({
  layout: '124x52:16x16', zoom: 2.2, panX: -220, panY: 40,
  scrollLeft: 120, scrollTop: 280, positions: { a: { x: 300, y: 400 } }, ...overrides,
})]]);

test('graph refresh resumes zoom, pan, scroll and positions, including a flush while hidden', () => {
  const view = graphView(savedGraph());
  assert.equal(view.api.state().zoom, 2.2);
  assert.equal(view.api.state().panX, -220);
  assert.equal(view.api.state().panY, 40);
  assert.equal(view.context.positions.get('a').x, 300);
  view.frame();
  assert.equal(view.canvas.scrollLeft, 120);
  assert.equal(view.canvas.scrollTop, 280);
  view.context.zoom = 1.8;
  view.context.panX = -130;
  view.context.panY = 50;
  view.canvas.scrollLeft = 310;
  view.canvas.scrollTop = 270;
  view.api.captureGraphScroll();
  view.canvas.clientWidth = 0;
  view.canvas.clientHeight = 0;
  view.canvas.scrollLeft = 0;
  view.canvas.scrollTop = 0;
  view.api.flushGraphState();
  const reloaded = graphView(view.storage);
  assert.equal(reloaded.api.state().zoom, 1.8);
  assert.equal(reloaded.api.state().panX, -130);
  reloaded.frame();
  assert.equal(reloaded.canvas.scrollLeft, 310);
  assert.equal(reloaded.canvas.scrollTop, 270);
});

test('hidden graph defers scroll restore and explicit reset persists a clean 1:1 view', () => {
  const view = graphView(savedGraph());
  view.canvas.clientWidth = 0;
  view.frame();
  assert.equal(view.canvas.scrollLeft, 0);
  assert.equal(view.api.state().scrollLeft, 120);
  view.canvas.clientWidth = 800;
  view.api.restoreGraphScroll();
  assert.equal(view.canvas.scrollLeft, 120);
  view.api.resetGraphViewport();
  view.api.saveGraphState(true);
  const reloaded = graphView(view.storage);
  reloaded.frame();
  assert.equal(reloaded.api.state().zoom, 1);
  assert.equal(reloaded.api.state().panX, 0);
  assert.equal(reloaded.api.state().panY, 0);
  assert.equal(reloaded.canvas.scrollLeft, 0);
  assert.equal(reloaded.canvas.scrollTop, 0);
});

test('graph ignores mismatched or corrupt viewport state without discarding valid task data', () => {
  for (const storage of [savedGraph({ layout: 'old-layout' }), savedGraph({ zoom: 99 }), new Map([[graphKey, '{broken']])]) {
    const view = graphView(storage);
    view.frame();
    assert.equal(view.api.state().zoom, 1);
    assert.equal(view.api.state().panX, 0);
    assert.equal(view.canvas.scrollLeft, 0);
  }
  const legacy = graphView(savedGraph({ scrollLeft: undefined, scrollTop: undefined }));
  assert.equal(legacy.api.state().zoom, 2.2);
  legacy.frame();
  assert.equal(legacy.canvas.scrollLeft, 0);
});

test('flow retains randomized launches and accelerates, cruises, then brakes on arrival', () => {
  const scheduled = [];
  const animations = [];
  const state = { enabled: true, timer: null, anim: null };
  const flow = {
    style: {}, getTotalLength: () => 320,
    animate(keyframes, options) { const animation = { cancel() {} }; animations.push({ keyframes, options, animation }); return animation; },
  };
  let random = 0.1;
  const math = Object.create(Math);
  math.random = () => random;
  const context = {
    Math: math, flowStates: new WeakMap([[flow, state]]),
    setTimeout(fn, delay) { scheduled.push({ fn, delay }); return scheduled.length; },
  };
  const start = app.indexOf('      const flowEasing =');
  const end = app.indexOf('      const updateFlowGeometry =', start);
  vm.runInNewContext(app.slice(start, end) + ';globalThis.launch = scheduleFlow;', context);
  context.launch(flow);
  assert.equal(scheduled[0].delay, 1200);
  scheduled[0].fn();
  assert.equal(animations.length, 1);
  assert.equal(animations[0].options.duration, 2000);
  const points = animations[0].options.easing.slice(7, -1).split(',').map((part) => Number.parseFloat(part.trim()));
  assert.equal(points.length, 11);
  assert.equal(points[0], 0);
  assert.equal(points[10], 1);
  const velocity = points.slice(1).map((value, index) => (value - points[index]) * 10);
  assert.ok(velocity[0] < velocity[1] && velocity[1] < velocity[2]);
  assert.ok(Math.abs(velocity[3] - velocity[6]) < 0.0001);
  assert.ok(velocity[7] > velocity[8] && velocity[8] > velocity[9]);
  assert.ok(velocity.every((value) => value > 0));
  random = 0.9;
  animations[0].animation.onfinish();
  assert.equal(scheduled[1].delay, 2800);
  state.enabled = false;
  scheduled[1].fn();
  assert.equal(animations.length, 1);
});


// Exercise the pre-app bootstrap with a dark OS and a saved light preference.
// The root canvas must already have themed CSS before this script can block on IO.
const boot = readFileSync(new URL('../assets/team-view-theme-boot.js', import.meta.url), 'utf8');
test('theme bootstrap honors a saved light preference before the app and styles load', () => {
  for (const [saved, systemDark, expected, blocked] of [
    ['light', true, 'light', false], ['dark', false, 'dark', false],
    [null, true, 'dark', false], ['invalid', false, 'light', false],
    [null, false, 'light', true],
  ]) {
    const element = { dataset: {} };
    const meta = { setAttribute(_name, value) { this.content = value; } };
    vm.runInNewContext(boot, {
      location: { pathname: '/ui' },
      localStorage: { getItem() { if (blocked) throw new Error('storage disabled'); return saved; } },
      window: { matchMedia() { return { matches: systemDark }; } },
      document: { documentElement: element, querySelector() { return meta; } },
    });
    assert.equal(element.dataset.theme, expected);
    assert.equal(meta.content, expected);
  }
  const canvas = html.indexOf('<style id="theme-first-paint">');
  assert.ok(canvas > 0 && canvas < html.indexOf('./team-view-theme-boot.js'));
  assert.match(html.slice(canvas, html.indexOf('</style>', canvas)), /color-scheme: light;[\s\S]*background: var\(--page-bg\)/u);
});


test('saved light surfaces paint before startup background transitions are enabled', () => {
  const frames = [];
  const attributes = new Set(['data-ui-booting']);
  const button = { setAttribute() {}, addEventListener() {}, querySelector() { return null; } };
  const element = { dataset: { theme: 'light' }, removeAttribute(name) { attributes.delete(name); } };
  vm.runInNewContext(readFileSync(new URL('../assets/team-view-theme.js', import.meta.url), 'utf8'), {
    document: { documentElement: element, querySelector(selector) {
      if (selector === '#agent-teams-ui') return {};
      if (selector === '#theme-toggle') return button;
      return null;
    } },
    location: { pathname: '/ui' },
    localStorage: { getItem() { return 'light'; } },
    window: { matchMedia() { return { matches: true }; } },
    requestAnimationFrame(callback) { frames.push(callback); },
  });
  assert.equal(attributes.has('data-ui-booting'), true);
  frames.shift()();
  assert.equal(attributes.has('data-ui-booting'), true, 'first saved-theme paint is still protected');
  frames.shift()();
  assert.equal(attributes.has('data-ui-booting'), false, 'hover and selection transitions resume after paint');
  assert.match(html, /<html[^>]+data-ui-booting/u);
  assert.match(html, /html\[data-ui-booting\]\[data-theme="light"\][\s\S]*transition: none !important/u);
});

const patrolView = (teamMeta, fetchImpl, { buttonPresent = true } = {}) => {
  const listeners = new Map();
  const requests = [];
  const reports = [];
  const button = {
    disabled: false,
    hidden: false,
    addEventListener(type, callback) { listeners.set(type, callback); },
  };
  const document = {
    querySelector(selector) { return selector === '#top-patrol' && buttonPresent ? button : null; },
    dispatchEvent(event) { reports.push(event.detail); },
  };
  class AdapterCustomEvent {
    constructor(type, options) { this.type = type; this.detail = options.detail; }
  }
  vm.runInNewContext(patrolApp, {
    document,
    window: { __AGENT_TEAMS_LIVE_MODEL__: { teamMeta } },
    fetch(url, options) {
      requests.push({ url, options });
      return fetchImpl(url, options);
    },
    CustomEvent: AdapterCustomEvent,
  });
  return { button, requests, reports, hasClickHandler: () => listeners.has('click'), click: () => listeners.get('click')() };
};

const patrolResponse = (payload, ok = true) => ({ ok, json: async () => payload });

test('top patrol posts once per active team and reports successful starts', async () => {
  const view = patrolView([
    { id: 'alpha' }, { id: 'team /beta' }, null, { id: '' }, { id: 12 },
  ], async () => patrolResponse({ ok: true, data: { ran: true } }));

  await view.click();

  assert.equal(view.requests.length, 2);
  assert.deepEqual(view.requests.map(({ url }) => url), [
    '/api/v1/teams/alpha/patrol',
    '/api/v1/teams/team%20%2Fbeta/patrol',
  ]);
  for (const { options } of view.requests) {
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
  }
  assert.deepEqual(view.reports.map(({ message }) => message), ['正在启动巡检', '队长已开始巡检']);
  assert.equal(view.button.disabled, false);
});

test('top patrol ignores overlapping clicks and reports a queued payload state', async () => {
  let resolveFetch;
  const view = patrolView([{ id: 'alpha' }], () => new Promise((resolve) => { resolveFetch = resolve; }));

  const pending = view.click();
  assert.equal(view.button.disabled, true);
  assert.equal(view.requests.length, 1);
  view.click();
  assert.equal(view.requests.length, 1);
  assert.deepEqual(view.reports.map(({ message }) => message), ['正在启动巡检']);

  resolveFetch(patrolResponse({ ok: true, data: { reason: 'captain-busy-queued' } }));
  await pending;

  assert.deepEqual(view.reports.map(({ message }) => message), ['正在启动巡检', '巡检已排队']);
  assert.equal(view.button.disabled, false);
});

test('top patrol reports partial success from response payloads and restores the button', async () => {
  const view = patrolView([{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }], async (url) => {
    if (url.endsWith('/alpha/patrol')) return patrolResponse({ ok: true, data: { ran: true } });
    if (url.endsWith('/beta/patrol')) return patrolResponse({ ok: true, data: { reason: 'patrol-timeout' } });
    return patrolResponse({ ok: false }, false);
  });

  await view.click();

  assert.equal(view.requests.length, 3);
  assert.deepEqual(view.reports.map(({ message }) => message), ['正在启动巡检', '已启动巡检：{0}/{1} 支队伍']);
  assert.deepEqual(Array.from(view.reports[1].values), [1, 3]);
  assert.equal(view.button.disabled, false);
});

test('top patrol reports total request failure and restores the button', async () => {
  const view = patrolView([{ id: 'alpha' }, { id: 'beta' }], async (url) => {
    if (url.endsWith('/alpha/patrol')) throw new Error('network unavailable');
    return patrolResponse({ ok: false }, false);
  });

  await view.click();

  assert.deepEqual(view.reports.map(({ message }) => message), ['正在启动巡检', '巡检启动失败']);
  assert.equal(view.button.disabled, false);
});

for (const [reason, message] of [
  ['patrol-in-flight', '巡检已在运行中'],
  ['disabled', '巡检已关闭'],
  ['no-active-work', '没有可巡检的活动任务'],
  ['patrol-cancel-failed', '巡检启动失败'],
]) {
  test(`top patrol reports ${reason} and permits a later click`, async () => {
    let response = { reason };
    const view = patrolView([{ id: 'alpha' }], async () => patrolResponse({ ok: true, data: response }));
    await view.click();
    assert.equal(view.reports.at(-1).message, message);
    assert.equal(view.button.disabled, false);
    response = { ran: true };
    await view.click();
    assert.equal(view.requests.length, 2);
    assert.equal(view.reports.at(-1).message, '队长已开始巡检');
    assert.equal(view.button.disabled, false);
  });
}

test('top patrol stays hidden and unwired without valid teams', () => {
  for (const teamMeta of [undefined, [], [null, { id: '' }, { id: 3 }]]) {
    const view = patrolView(teamMeta, () => { throw new Error('unexpected fetch'); });
    assert.equal(view.button.hidden, true);
    assert.equal(view.hasClickHandler(), false);
    assert.equal(view.requests.length, 0);
    assert.equal(view.reports.length, 0);
  }
});

test('top patrol tolerates a missing button without requests or handlers', () => {
  const view = patrolView([{ id: 'alpha' }], () => { throw new Error('unexpected fetch'); }, { buttonPresent: false });
  assert.equal(view.hasClickHandler(), false);
  assert.equal(view.requests.length, 0);
  assert.equal(view.reports.length, 0);
});
