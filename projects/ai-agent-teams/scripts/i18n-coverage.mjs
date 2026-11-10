import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'acorn';
import { loadLocales } from './build-i18n.mjs';
import { ALLOW_RULES, isAllowlisted } from './i18n-allow.mjs';

const CJK = /[\u3400-\u9fff]/u;
const root = resolve('.');
const locales = loadLocales(root);
const sourceLocale = locales['zh-CN'];
const keys = new Set(Object.keys(sourceLocale.strings));
const patternSources = new Set(sourceLocale.patterns.map((pattern) => pattern.source));

// Demo fixtures, generated sample rows and non-UI literals are deliberately
// excluded from the translation dictionary. Rules live in scripts/i18n-allow.mjs
// (unit-tested); anything else the scan finds must be translated.
console.log(`i18n allow rules: ${ALLOW_RULES.length}`);

const allowlist = [];

function allowlisted(value) {
  return isAllowlisted(value, (hit) => allowlist.push(hit));
}

function normalize(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function patternRegex(source) {
  const parts = String(source).split(/(\{\d+\})/u);
  const placeholders = parts.filter((part) => /^\{\d+\}$/u.test(part)).length;
  let body = '';
  let seen = 0;
  for (const part of parts) {
    if (/^\{\d+\}$/u.test(part)) {
      seen += 1;
      body += seen === placeholders ? '([\\s\\S]+)' : '([\\s\\S]+?)';
    } else {
      body += part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp('^' + body + '$');
}

const patternRegexes = sourceLocale.patterns.map((pattern) => patternRegex(pattern.source));

function matchesPattern(value) {
  return patternRegexes.some((regex) => regex.test(value));
}

function lineRanges(text) {
  const ranges = [];
  let start = null;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.includes('i18n-allowlist-start')) start = index + 1;
    if (line.includes('i18n-allowlist-end') && start !== null) {
      ranges.push([start, index + 1]);
      start = null;
    }
  });
  return ranges;
}

function inRanges(line, ranges) {
  return ranges.some(([start, end]) => line >= start && line <= end);
}

/**
 * Text and attribute segments of an HTML fragment, ignoring anything inside a
 * `data-i18n-skip` element. Template-literal coverage uses this so a literal
 * user-data placeholder such as `<i data-i18n-skip>外</i>` is not reported as
 * an untranslated label after the broad demo rules were removed.
 */
function htmlSegments(text) {
  const segments = [];
  const stack = [];
  const skipped = () => stack.some((entry) => entry.skip);
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  let index = 0;
  while (index < text.length) {
    if (text[index] === '<') {
      const close = text.indexOf('>', index);
      if (close < 0) break;
      const tag = text.slice(index + 1, close).trim();
      index = close + 1;
      if (!tag || tag.startsWith('!') || tag.startsWith('?')) continue;
      if (tag.startsWith('/')) {
        const name = tag.slice(1).trim().toLowerCase();
        while (stack.length) {
          const entry = stack.pop();
          if (entry.name === name) break;
        }
        continue;
      }
      const selfClosing = tag.endsWith('/');
      const name = tag.replace(/\/$/u, '').split(/\s/)[0].toLowerCase();
      if (!skipped()) {
        for (const attr of ['title', 'aria-label', 'placeholder', 'alt', 'data-toast']) {
          const match = new RegExp(`\\b${attr}="([^"]*)"`, 'u').exec(tag);
          if (match) segments.push(normalize(match[1]));
        }
      }
      if (!selfClosing && !VOID.has(name)) {
        stack.push({ name, skip: skipped() || /\bdata-i18n-skip\b/u.test(tag) });
      }
      continue;
    }
    const next = text.indexOf('<', index);
    const end = next < 0 ? text.length : next;
    if (!skipped()) segments.push(normalize(text.slice(index, end)));
    index = end;
  }
  return segments.filter(Boolean);
}

function astWalk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) astWalk(item, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
    if (value && typeof value === 'object') astWalk(value, visit);
  }
}

function scanJavaScript(text, file, ranges) {
  const results = [];
  const moduleSource = file.endsWith('.mjs') || file.startsWith('ui-src/');
  const ast = parse(text, {
    ecmaVersion: 'latest',
    sourceType: moduleSource ? 'module' : 'script',
    locations: true,
    allowHashBang: true,
  });
  astWalk(ast, (node) => {
    const line = node.loc?.start?.line ?? 0;
    if (inRanges(line, ranges)) return;
    if (node.type === 'Literal' && typeof node.value === 'string') {
      if (node.regex) return;
      if (CJK.test(node.value)) results.push({ file, line, kind: 'literal', value: normalize(node.value) });
      return;
    }
    if (node.type === 'TemplateLiteral') {
      const chunks = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).filter((chunk) => CJK.test(chunk));
      let normalized = '';
      node.quasis.forEach((quasi, index) => {
        normalized += quasi.value.cooked ?? quasi.value.raw;
        if (index < node.expressions.length) normalized += `{${index}}`;
      });
      if (CJK.test(normalized)) {
        results.push({ file, line, kind: 'template', value: normalize(normalized), chunks: chunks.map((chunk) => normalize(chunk)) });
      }
    }
  });
  return results;
}

function scanHtml(text, file) {
  const results = [];
  const start = text.indexOf('<!-- BEGIN GENERATED I18N');
  const end = text.indexOf('<!-- END GENERATED I18N -->');
  if (start >= 0 && end > start) {
    text = `${text.slice(0, start)}\n${text.slice(end + '<!-- END GENERATED I18N -->'.length)}`;
  }
  const stack = [];
  const skip = () => stack.some((entry) => entry.skip);
  let index = 0;
  let line = 1;
  const pushText = (value, startLine) => {
    if (skip()) return;
    if (!CJK.test(value)) return;
    const normalized = normalize(value);
    if (normalized) results.push({ file, line: startLine, kind: 'text', value: normalized });
  };
  while (index < text.length) {
    if (text[index] === '<') {
      if (text.startsWith('<!--', index)) {
        const close = text.indexOf('-->', index + 4);
        const chunk = text.slice(index, close < 0 ? text.length : close + 3);
        line += (chunk.match(/\n/gu) ?? []).length;
        index = close < 0 ? text.length : close + 3;
        continue;
      }
      const close = text.indexOf('>', index);
      if (close < 0) break;
      let tag = text.slice(index + 1, close).trim();
      const tagLine = line;
      line += (text.slice(index, close + 1).match(/\n/gu) ?? []).length;
      index = close + 1;
      if (!tag || tag.startsWith('!') || tag.startsWith('?')) continue;
      if (tag.startsWith('/')) {
        const name = tag.slice(1).trim().toLowerCase();
        while (stack.length) {
          const entry = stack.pop();
          if (entry.name === name) break;
        }
        continue;
      }
      const selfClosing = tag.endsWith('/');
      const name = tag.replace(/\/$/u, '').split(/\s/)[0].toLowerCase();
      const attrs = tag.replace(/\/$/u, '');
      const attrsSkip = /\bdata-i18n-skip\b/u.test(attrs);
      if (!skip()) {
        for (const attr of ['title', 'aria-label', 'placeholder', 'alt', 'data-toast']) {
          const match = new RegExp(`\\b${attr}="([^"]*)"`, 'u').exec(attrs);
          if (match && CJK.test(match[1])) {
            results.push({ file, line: tagLine, kind: 'attr', value: normalize(match[1]) });
          }
        }
      }
      const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
      if (!selfClosing && !voidTags.has(name)) stack.push({ name, skip: skip() || attrsSkip });
      continue;
    }
    const nextTag = text.indexOf('<', index);
    const chunkEnd = nextTag < 0 ? text.length : nextTag;
    const chunk = text.slice(index, chunkEnd);
    if (chunk.trim()) pushText(chunk, line);
    line += (chunk.match(/\n/gu) ?? []).length;
    index = chunkEnd;
  }
  return results;
}

const sources = [
  { file: 'assets/team-view.html', kind: 'html' },
  { file: 'assets/team-view-app.js', kind: 'js' },
  { file: 'assets/team-view-live.js', kind: 'js' },
  { file: 'assets/team-view-theme.js', kind: 'js' },
  { file: 'ui-src/team-panel.js', kind: 'js' },
  { file: 'ui-src/panel-labels.js', kind: 'js' },
  { file: 'scripts/build-ui.mjs', kind: 'js' },
];

const entries = [];
for (const source of sources) {
  let text = readFileSync(join(root, source.file), 'utf8');
  if (source.kind === 'html') {
    entries.push(...scanHtml(text, source.file));
  } else {
    const start = text.indexOf('/* BEGIN GENERATED I18N');
    const end = text.indexOf('/* END GENERATED I18N */');
    if (start >= 0 && end > start) text = `${text.slice(0, start)}
${text.slice(end + '/* END GENERATED I18N */'.length)}`;
    entries.push(...scanJavaScript(text, source.file, lineRanges(text)));
  }
}

const uncovered = [];
const covered = [];
for (const entry of entries) {
  const value = normalize(entry.value);
  if (!value) continue;
  if (keys.has(value) || patternSources.has(value) || matchesPattern(value)) {
    covered.push(entry);
    continue;
  }
  if (entry.kind === 'template' && entry.chunks) {
    // Check the whole template in one pass when it is markup: `data-i18n-skip`
    // then applies to the real element, even when an interpolation splits the
    // opening tag from the skipped text.
    if (value.includes('<')) {
      const segments = htmlSegments(value);
      const segmentCovered = (segment) => !CJK.test(segment) || keys.has(segment) || patternSources.has(segment) || matchesPattern(segment) || allowlisted(segment);
      if (segments.every(segmentCovered)) {
        covered.push(entry);
        continue;
      }
    }
    const chunkCovered = (chunk) => {
      const text = normalize(chunk);
      if (!text) return true;
      if (keys.has(text) || patternSources.has(text) || matchesPattern(text) || allowlisted(text)) return true;
      if (!text.includes('<')) return false;
      const segments = htmlSegments(text);
      return segments.every((segment) => !CJK.test(segment) || keys.has(segment) || patternSources.has(segment) || matchesPattern(segment) || allowlisted(segment));
    };
    if (entry.chunks.every(chunkCovered)) {
      covered.push(entry);
      continue;
    }
  }
  if (allowlisted(value)) continue;
  uncovered.push(entry);
}

const panelPath = join(root, 'assets', 'team-panel.html');
let panel = '';
try {
  panel = readFileSync(panelPath, 'utf8');
} catch {
  uncovered.push({ file: 'assets/team-panel.html', line: 0, kind: 'build', value: 'missing packaged panel (run node scripts/build-ui.mjs)' });
}
if (panel) {
  for (const locale of Object.values(locales)) {
    if (!panel.includes(`"name":"${locale.name}"`) && !panel.includes(`"name": "${locale.name}"`)) {
      uncovered.push({ file: 'assets/team-panel.html', line: 0, kind: 'build', value: `missing locale ${locale.locale}` });
    }
  }
  if (/\bfetch\s*\(/u.test(panel)) {
    uncovered.push({ file: 'assets/team-panel.html', line: 0, kind: 'build', value: 'packaged panel must not fetch locale JSON' });
  }
}

if (uncovered.length > 0) {
  console.error(`I18N COVERAGE FAILED (${entries.length} extracted, ${covered.length} covered, ${uncovered.length} uncovered, ${allowlist.length} allowlisted)`);
  const unique = new Map();
  for (const entry of uncovered) {
    const key = `${entry.file}:${entry.value}`;
    if (!unique.has(key)) unique.set(key, entry);
  }
  for (const entry of unique.values()) console.error(`- ${entry.file}:${entry.line}: ${entry.value}`);
  process.exit(1);
}

console.log(`I18N COVERAGE OK (${entries.length} extracted, ${covered.length} covered, ${allowlist.length} allowlisted, ${keys.size} strings, ${patternSources.size} patterns)`);
