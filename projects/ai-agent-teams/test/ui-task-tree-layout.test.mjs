import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLocales } from '../scripts/build-i18n.mjs';

// Regression lock for the task-tree header layout.
//
// The graph panel used to be a wrapping flex row (`.panel-head` from the base
// sheet plus `flex-wrap: wrap` from both theme sheets). With four locales and a
// ~400px-wide subtitle, the action block (flow switch + line legend + badge +
// icon buttons) wrapped onto a second or third line, and every extra line was
// taken straight out of the graph. The layout now keeps one row, shrinks the
// subtitle with an ellipsis, and drops the legend by container width.

const html = readFileSync(new URL('../assets/team-view.html', import.meta.url), 'utf8');
const sheets = {
  base: readFileSync(new URL('../assets/team-view.css', import.meta.url), 'utf8'),
  light: readFileSync(new URL('../assets/team-view.light.css', import.meta.url), 'utf8'),
  dark: readFileSync(new URL('../assets/team-view.dark.css', import.meta.url), 'utf8'),
};

// Acceptance viewports. Panel widths are what the task column actually receives
// (window minus sidebar, content padding and the 340px overview panel); they were
// measured in Chromium at each viewport with the overview panel expanded.
const ACCEPTANCE = [
  { viewport: '1280x720', width: 1280, height: 720, panelWidth: 613, headerHeight: 56, footerHeight: 45, graphHeight: 344, legend: 'hidden' },
  { viewport: '1920x1080', width: 1920, height: 1080, panelWidth: 1253, headerHeight: 57, footerHeight: 45, graphHeight: 703, legend: 'hidden' },
  { viewport: '2560x1440', width: 2560, height: 1440, panelWidth: 1893, headerHeight: 59, footerHeight: 45, graphHeight: 1061, legend: 'shown' },
  { viewport: '3840x2160', width: 3840, height: 2160, panelWidth: 3173, headerHeight: 59, footerHeight: 45, graphHeight: 1780, legend: 'shown' },
];
const LOCALES = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'];

// --- tiny CSS reader: enough cascade to prove which declaration wins ---------

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function declarations(body) {
  const result = {};
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (property && value) result[property] = value;
  }
  return result;
}

function parseBlock(source, context, out) {
  const text = stripComments(source);
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor);
    if (open < 0) break;
    const close = findMatchingBrace(text, open);
    if (close < 0) break;
    const prelude = text.slice(cursor, open).trim();
    const body = text.slice(open + 1, close);
    if (prelude.startsWith('@')) {
      parseBlock(body, context.concat(prelude), out);
    } else if (prelude) {
      out.push({
        selectors: prelude.split(',').map((selector) => selector.replace(/\s+/g, ' ').trim()),
        declarations: declarations(body),
        context,
      });
    }
    cursor = close + 1;
  }
  return out;
}

function parseSheet(source) {
  return parseBlock(source, [], []);
}

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/gu) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/gu) ?? []).length;
  const types = (selector.match(/(?:^|[\s>+~])([a-zA-Z][\w-]*)/gu) ?? []).length;
  return [ids, classes, types];
}

function outranks(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

// The winning declaration for `property` among rules whose selector list holds a
// selector that applies to the same element as `target` (same id/class tail).
//
// `withinMedia` filters by context, because this parser flattens `@media` blocks
// into the same rule list. Without it a declaration moved inside a media query
// still "wins", which let `min-height: 50px` be relocated to a `max-width: 560px`
// block while the assertion that it applies everywhere still passed.
//   undefined      -> any context (historical behaviour)
//   false          -> only unconditional rules
//   string|RegExp  -> only rules whose context contains that media condition
function winner(rules, target, property, withinMedia) {
  let best = null;
  const contextAllows = (rule) => {
    if (withinMedia === undefined) return true;
    const contexts = rule.context ?? [];
    const conditional = contexts.filter((entry) => /@(media|container|supports)/.test(entry));
    if (withinMedia === false) return conditional.length === 0;
    return conditional.some((entry) => (withinMedia instanceof RegExp
      ? withinMedia.test(entry)
      : entry.includes(withinMedia)));
  };
  rules.forEach((rule, index) => {
    if (!contextAllows(rule)) return;
    for (const selector of rule.selectors) {
      if (!selector.endsWith(target)) continue;
      if (!(property in rule.declarations)) continue;
      const score = specificity(selector);
      if (!best || outranks(score, best.score) || (score.join() === best.score.join() && index >= best.index)) {
        best = { value: rule.declarations[property], score, index, selector, context: rule.context };
      }
    }
  });
  return best;
}

function rulesFor(rules, needle) {
  return rules.filter((rule) => rule.selectors.some((selector) => selector.includes(needle)));
}

const sheetsParsed = Object.fromEntries(Object.entries(sheets).map(([name, source]) => [name, parseSheet(source)]));
const allRules = Object.values(sheetsParsed).flat();

// --- structure --------------------------------------------------------------

test('task tree header holds one title block and one action block', () => {
  const header = html.match(/<div class="panel-head"><div class="panel-head-title">([\s\S]*?)<\/div><div class="panel-actions">([\s\S]*?)<\/div><\/div>/u);
  assert.ok(header, 'task tree header must be .panel-head > .panel-head-title + .panel-actions');
  const [whole, title, actions] = header;
  assert.match(title, /^<h2>任务树<\/h2><span class="muted">[^<]+<\/span>$/u);
  assert.doesNotMatch(actions, /<h2>/u, 'the title must never sit inside the action block');
  assert.match(actions, /id="edge-flow-toggle"/u);
  assert.match(actions, /class="line-legend"/u);
  assert.match(actions, /id="task-panel-badge"/u);
  assert.ok(whole.includes('panel-head-title'));
  // A single copy of each control: the restructure must not duplicate markup.
  assert.equal((html.match(/id="edge-flow-toggle"/gu) ?? []).length, 1);
  assert.equal((html.match(/id="task-panel-badge"/gu) ?? []).length, 1);
});

test('no script depends on the previous flat header shape', () => {
  for (const file of ['team-view-app.js', 'team-view-live.js', 'team-view-stream.js']) {
    const source = readFileSync(new URL(`../assets/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /panel-head > \.muted/u, `${file} still queries the old subtitle position`);
    assert.doesNotMatch(source, /closest\('\.panel-head'\)\s*\.\s*querySelector\('h2'\)/u, `${file} assumes the old header shape`);
  }
});

// --- one row, no overlap ----------------------------------------------------

test('the task tree header can never wrap onto a second row', () => {
  const target = '#agent-teams-ui #task-tree-view > .panel-head';
  const wrap = winner(allRules, target, 'flex-wrap');
  assert.ok(wrap, 'the task tree header needs an explicit flex-wrap');
  assert.equal(wrap.value, 'nowrap');
  // Both theme sheets keep `.panel-head { flex-wrap: wrap }` for the other
  // panels; the task-tree rule must out-specify it or the header wraps again.
  for (const theme of ['light', 'dark']) {
    const generic = winner(sheetsParsed[theme], '.panel-head', 'flex-wrap');
    assert.ok(generic, `${theme} sheet lost its generic header rule`);
    assert.equal(generic.value, 'wrap');
    assert.ok(outranks(wrap.score, generic.score),
      `task tree header (${wrap.selector}) must out-specify ${generic.selector}`);
  }
});

test('the title block shrinks and the action block does not', () => {
  const titleTarget = '#agent-teams-ui #task-tree-view > .panel-head > .panel-head-title';
  const titleFlex = winner(allRules, titleTarget, 'flex');
  assert.equal(titleFlex?.value, '1 1 auto');
  assert.equal(winner(allRules, `${titleTarget} > .muted`, 'min-width')?.value, '0');
  assert.equal(winner(allRules, `${titleTarget} > .muted`, 'overflow')?.value, 'hidden');
  assert.equal(winner(allRules, `${titleTarget} > .muted`, 'text-overflow')?.value, 'ellipsis');
  assert.equal(winner(allRules, `${titleTarget} > .muted`, 'white-space')?.value, 'nowrap');
  // Both theme sheets must style the relocated subtitle, or dark/light typography
  // silently falls back to the 9.5px generic `.panel-head .muted` size.
  for (const theme of ['light', 'dark']) {
    assert.ok(rulesFor(sheetsParsed[theme], '.panel-head-title > .muted').length > 0,
      `${theme} sheet does not style the relocated subtitle`);
  }
  const actionsTarget = '#agent-teams-ui #task-tree-view > .panel-head > .panel-actions';
  assert.equal(winner(allRules, actionsTarget, 'flex')?.value, '0 1 auto');
  assert.equal(winner(allRules, actionsTarget, 'flex-wrap')?.value, 'nowrap');
  assert.equal(winner(allRules, `${actionsTarget} > *`, 'flex')?.value, '0 0 auto');
  // Only the legend may shrink inside the action block: that is the safety net
  // for browsers without container queries, where the drop rules never run.
  const legendInHeader = '#agent-teams-ui #task-tree-view > .panel-head .line-legend';
  assert.equal(winner(allRules, legendInHeader, 'flex')?.value, '0 1 auto');
  assert.equal(winner(allRules, legendInHeader, 'min-width')?.value, '0');
});

test('the page toolbar and graph footer cannot steal a row from the graph', () => {
  assert.equal(winner(allRules, '#agent-teams-ui #page-tasks > .task-toolbar', 'flex-wrap')?.value, 'nowrap');
  const legendTarget = '#agent-teams-ui #task-dependency-legend';
  assert.equal(winner(allRules, legendTarget, 'min-width')?.value, '0');
  assert.equal(winner(allRules, legendTarget, 'text-overflow')?.value, 'ellipsis');
  assert.equal(winner(allRules, '#agent-teams-ui #task-tree-view > .graph-foot > .legend', 'flex')?.value, '0 0 auto');
  assert.equal(winner(allRules, '#agent-teams-ui #task-tree-view > .graph-foot > span:last-child', 'text-overflow')?.value, 'ellipsis');
});

// --- container-query degradation -------------------------------------------

const containerRule = (maxWidth) => allRules.find((rule) => rule.context.some((context) => context.startsWith('@container'))
  && rule.context.some((context) => context.includes(`max-width: ${maxWidth}px`)));

test('the graph panel is a size container so the header reacts to its own width', () => {
  const container = winner(allRules, '#agent-teams-ui #task-tree-view', 'container');
  assert.match(container?.value ?? '', /^task-tree \/ inline-size$/u);
  const hideLegend = containerRule(1500);
  assert.ok(hideLegend, 'the legend needs a container-width drop point');
  assert.equal(hideLegend.selectors.length, 1);
  assert.match(hideLegend.selectors[0], /#task-tree-view > \.panel-head \.line-legend$/u);
  assert.equal(hideLegend.declarations.display, 'none');
});

test('the legend is dropped before the flow label and never by a viewport query', () => {
  const flowCut = containerRule(420);
  assert.ok(flowCut, 'the flow label needs a narrower drop point than the legend');
  assert.match(flowCut.selectors[0], /\.flow-switch > span:last-child$/u);
  assert.equal(flowCut.declarations.display, 'none');
  // The legend must not be hidden by a viewport media query any more: the graph
  // column is ~400px narrower than the window, so viewport width cannot know
  // whether the actions fit.
  const viewportHides = allRules.filter((rule) => rule.context.some((context) => context.startsWith('@media'))
    && rule.selectors.some((selector) => selector.includes('line-legend'))
    && rule.declarations.display === 'none');
  assert.deepEqual(viewportHides.map((rule) => rule.context.join(' ')), []);
});

test('the legend drop point matches the measured panel widths', () => {
  const cut = Number(/max-width:\s*(\d+)px/u.exec(containerRule(1500).context.join(' '))[1]);
  for (const row of ACCEPTANCE) {
    const expected = row.panelWidth > cut ? 'shown' : 'hidden';
    assert.equal(expected, row.legend, `${row.viewport}: legend should be ${row.legend} at panel width ${row.panelWidth}`);
  }
});

// --- long copy is what the layout has to survive -----------------------------

test('four acceptance viewports keep locale controls and A/B labels inside bounded cards', () => {
  const locales = loadLocales(resolve('.'));
  assert.match(html, /<select id="locale-select"[^>]*>/u);
  assert.equal((html.match(/<option value="(?:zh-CN|en-US|ja-JP|ko-KR)">/gu) ?? []).length, 4);
  const fixedHeaderBudget = 420;
  for (const row of ACCEPTANCE) {
    assert.ok(row.panelWidth > fixedHeaderBudget, `${row.viewport}: panel width must leave room for title and actions`);
    assert.ok(row.graphHeight > row.headerHeight + row.footerHeight, `${row.viewport}: graph must not overlap header/footer`);
    for (const locale of LOCALES) {
      assert.ok(locales[locale].strings['A队'], `${row.viewport}/${locale}: missing A-team label`);
      assert.ok(locales[locale].strings['B队'], `${row.viewport}/${locale}: missing B-team label`);
      assert.ok(locales[locale].strings['跨队输入汇总'], `${row.viewport}/${locale}: missing demo summary`);
    }
  }
});

test('the header is verified against the longest locale copy', () => {
  const locales = loadLocales(resolve('.'));
  const subtitleKey = '点击任务块查看详情 · 拖动节点 · 线自动跟随';
  const subtitle = Object.fromEntries(LOCALES.map((locale) => [locale, locales[locale].strings[subtitleKey]]));
  assert.match(html, new RegExp(`<span class="muted">${subtitleKey}</span>`, 'u'),
    'the source subtitle must stay the zh-CN dictionary key so the runtime can translate it');
  for (const locale of LOCALES) assert.ok(subtitle[locale], `${locale} lost the subtitle translation`);
  const longest = Math.max(...LOCALES.map((locale) => subtitle[locale].length));
  assert.ok(longest >= 60, `the subtitle fixture is not a long-copy case (longest ${longest} chars)`);
  // The same long-copy check for the toolbar legend and the header legend.
  for (const key of ['实线：已完成 / 进行中队内依赖', '虚线：跨队交付或队内等待']) {
    assert.match(html, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    const widest = Math.max(...LOCALES.map((locale) => locales[locale].strings[key]?.length ?? 0));
    assert.ok(widest >= 30, `${key} is not a long-copy case (widest ${widest} chars)`);
  }
});

// --- the graph keeps its space ---------------------------------------------

test('header plus footer chrome stays inside the measured budget', () => {
  for (const row of ACCEPTANCE) {
    const chrome = row.headerHeight + row.footerHeight;
    assert.ok(chrome <= 110, `${row.viewport}: header+footer chrome is ${chrome}px`);
    assert.ok(row.graphHeight >= row.height * 0.4,
      `${row.viewport}: graph only gets ${row.graphHeight}px of ${row.height}px`);
  }
});

test('team title cards shrink long localized labels instead of overlapping badges', () => {
  const title = '#agent-teams-ui .team-title';
  const titleText = `${title} > div:nth-child(2)`;
  assert.equal(winner(allRules, title, 'min-width')?.value, '0');
  assert.equal(winner(allRules, titleText, 'min-width')?.value, '0');
  assert.equal(winner(allRules, titleText, 'flex')?.value, '1 1 auto');
  assert.equal(winner(allRules, `${titleText} > b`, 'overflow')?.value, 'hidden');
  assert.equal(winner(allRules, `${titleText} > b`, 'text-overflow')?.value, 'ellipsis');
  assert.equal(winner(allRules, `${titleText} > span`, 'overflow')?.value, 'hidden');
  assert.equal(winner(allRules, `${titleText} > span`, 'text-overflow')?.value, 'ellipsis');
  assert.match(html, /A队/u);
  assert.match(html, /B队/u);
});

test('no rule reintroduces a wrapping header for the task tree', () => {
  const offenders = allRules.filter((rule) => rule.declarations['flex-wrap'] === 'wrap'
    && rule.selectors.some((selector) => selector.includes('task-tree-view') && selector.includes('panel-head')));
  assert.deepEqual(offenders.map((rule) => rule.selectors.join(', ')), []);
  // And nothing overrides the header back to a fixed height that could clip it.
  const fixedHeights = rulesFor(allRules, '#task-tree-view > .panel-head')
    .filter((rule) => 'height' in rule.declarations && /^\d/.test(rule.declarations.height));
  assert.deepEqual(fixedHeights.map((rule) => rule.selectors.join(', ')), []);
});

test('legacy browsers without container queries still cannot overflow the panel', () => {
  // `nowrap` removes the wrap-based escape hatch, so without @container support
  // the only thing keeping the action row inside the panel is a shrinkable,
  // clipped legend. Both halves of that pairing must stay in place.
  const actionsTarget = '#agent-teams-ui #task-tree-view > .panel-head > .panel-actions';
  assert.equal(winner(allRules, actionsTarget, 'flex')?.value, '0 1 auto');
  const legend = '#agent-teams-ui #task-tree-view > .panel-head .line-legend';
  assert.equal(winner(allRules, legend, 'min-width')?.value, '0');
  assert.equal(winner(allRules, legend, 'overflow')?.value, 'hidden');
  const spans = winner(allRules, `${legend} > span`, 'text-overflow');
  assert.equal(spans?.value, 'ellipsis');
  const fallback = allRules.filter((rule) => rule.context.some((context) => context.includes('@supports not (container-type: inline-size)')));
  assert.ok(fallback.length > 0, 'the no-container-query fallback must exist');
  assert.ok(fallback.some((rule) => rule.selectors.some((selector) => selector.includes('line-legend'))
    && rule.declarations.display === 'none'), 'the fallback must drop the legend');
});

test('the stat-card label and badge wrap instead of overflowing into the next card', () => {
  // At 1280x720 the four stat cards are only ~190px wide inside, while the
  // en-US/ja-JP/ko-KR badge alone needs ~150px. Keeping both halves on one line
  // was only possible by cutting the label, which once left `현재 멤버` as
  // `현재 ` -- the noun itself gone. The label row therefore wraps, and the
  // badge drops to its own row instead of the label losing words.
  const label = '#agent-teams-ui .stat-label';
  assert.equal(winner(allRules, label, 'min-width', false)?.value, '0');
  assert.equal(winner(allRules, label, 'flex-wrap', false)?.value, 'wrap',
    'the stat label row must wrap so a long badge cannot squeeze the label');
  // A fixed row height is what keeps wrapped and unwrapped cards on one number
  // baseline; without it the wrapped cards pushed their `.stat-value` down by
  // 34px at 1280x720 in en-US/ja-JP/ko-KR.
  assert.equal(winner(allRules, label, 'min-height', false)?.value, '50px',
    'the label row must reserve a constant height so wrapped cards keep the value baseline');

  // Every text child of the label may shrink, not only the first one: the
  // member-residency card ships two label spans and swaps which is visible per
  // theme, so a `:first-child` rule protected the hidden span and left the
  // visible one able to overflow the card.
  const labelSpans = allRules.filter((rule) => rule.selectors.some((selector) => selector.includes('.stat-label > span:not(.badge):not(.icon)')));
  assert.ok(labelSpans.length > 0, 'all non-badge label spans must be protected, not just :first-child');
  for (const declaration of ['min-width', 'text-overflow', 'white-space']) {
    const value = winner(allRules, '#agent-teams-ui .stat-label > span:not(.badge):not(.icon)', declaration, false)?.value;
    assert.ok(value, `label spans must declare ${declaration}`);
  }
  assert.equal(winner(allRules, '#agent-teams-ui .stat-label > span:not(.badge):not(.icon)', 'text-overflow', false)?.value, 'ellipsis');

  // `.badge` is `display: inline-flex`, where `text-overflow` is inert. Assert
  // the two properties that actually keep it inside the card, and guard against
  // a future edit re-adding a dead `text-overflow` declaration that would look
  // like truncation protection without providing any.
  const badge = `${label} > .badge`;
  assert.equal(winner(allRules, badge, 'min-width', false)?.value, '0');
  assert.equal(winner(allRules, badge, 'max-width', false)?.value, '100%');
  const flex = winner(allRules, badge, 'flex', false);
  assert.match(flex?.value ?? '', /^0 1 auto$|^0 1 /, 'the badge may shrink but must not grow past its text');
  assert.ok(!winner(allRules, badge, 'text-overflow', false),
    'text-overflow on a flex pill is inert; rely on wrapping instead');

  // `row-gap` alone would be dead here: a later `gap` shorthand resets it. The
  // rule must express the row gap through `gap` so it actually applies -- and it
  // must name both values, because collapsing it to `gap: 8px` removes the row
  // spacing entirely and the wrapped card's two rows end up touching. Asserting
  // only "no row-gap" let that regression through.
  assert.ok(!winner(allRules, label, 'row-gap', false),
    'a bare row-gap is overridden by the gap shorthand; set the row gap inside gap');
  assert.match(winner(allRules, label, 'gap', false)?.value ?? '', /^\d+px \d+px$/,
    'gap must state row and column spacing separately so the wrapped row keeps its row gap');

  // The number sits directly under the fixed-height label row. Bottom-aligning
  // it with `margin-top:auto` failed because the footnotes differ in line count
  // between cards, which moved the numbers apart by 21px; the foot absorbs the
  // leftover height instead.
  const stat = '#agent-teams-ui .stat';
  assert.equal(winner(allRules, stat, 'flex-direction', false)?.value, 'column',
    'stat cards must be column flex containers for baseline alignment');
  assert.equal(winner(allRules, '#agent-teams-ui .stat-value', 'margin-top', false)?.value, '0',
    'the stat value must not float to the card bottom; the foot absorbs extra height');
  assert.match(winner(allRules, '#agent-teams-ui .stat-foot', 'flex', false)?.value ?? '', /^1 /,
    'the foot must absorb the leftover height so the number stays put');

  // Below 560px the pill wraps its text. The theme stylesheets already raise
  // `.badge` to `min-height: 24px`, so a `min-height` here would be overridden --
  // asserting it is absent keeps dead declarations out of the narrow-width rule.
  const narrowBadge = winner(allRules, badge, 'min-height', '@media (max-width: 560px)');
  assert.ok(narrowBadge === null || !/20px/.test(narrowBadge.value),
    'the 560px badge rule must not restate a min-height the theme already sets');
});

test('the two-column stat breakpoint covers the whole width range where four columns clip', () => {
  // Four stat columns only fit above ~1240px. Between the theme stylesheets'
  // 1080px two-column rule and that point the cards are ~230px wide inside,
  // which is narrower than a long English badge, so the badge was cut mid-glyph
  // with no ellipsis. 1152px -- a 1440px screen at 125% Windows scaling -- was
  // inside that gap. The breakpoint must therefore reach 1240, and it must
  // cover `#page-dual .stats` too because that selector sets four columns of
  // its own with higher specificity.
  const css = readFileSync(new URL('../assets/team-view.css', import.meta.url), 'utf8');
  const breakpoints = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
  const statBreakpoint = breakpoints.filter((w) => w >= 1200 && w <= 1300);
  assert.ok(statBreakpoint.length > 0,
    `the stat grid breakpoint must sit near the measured 1240px handover, found: ${breakpoints.join(', ')}`);
  // Slice from the breakpoint to the next media query so a selector in a
  // neighbouring block cannot satisfy these assertions.
  const start = css.indexOf(`@media (max-width: ${statBreakpoint[0]}px)`);
  const afterStart = css.indexOf('@media (max-width:', start + 1);
  const body = css.slice(start, afterStart === -1 ? css.length : afterStart);
  // Parse the declarations of this block alone. Matching the selector name is
  // not enough: reverting the value to four columns kept the selector in place
  // and the test still passed, which left the original defect free to return.
  const statRule = /#agent-teams-ui \.stats,\s*\n\s*#agent-teams-ui #page-dual \.stats \{([^}]*)\}/.exec(body);
  assert.ok(statRule, 'the breakpoint must cover both the generic and the dual-team stat grid');
  assert.match(statRule[1], /grid-template-columns:\s*1fr 1fr\s*;/,
    'the breakpoint must actually set two equal columns, not just name the selector');
  assert.ok(!/repeat\(4/.test(statRule[1]),
    'four columns below the handover is the defect this breakpoint exists to prevent');
  assert.ok(!/@media \(max-width: 980px\)/.test(css),
    'the obsolete 980px stat breakpoint was dead code and must not come back');
});
