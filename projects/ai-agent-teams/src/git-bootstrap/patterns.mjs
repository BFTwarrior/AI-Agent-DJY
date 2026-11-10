// Include/exclude pattern compilation.
//
// A pattern is compiled once into a regular expression so a large tree is not
// re-parsed per file. The semantics are deliberately narrower than gitignore:
// - negation is refused instead of ignored, because a silently dropped `!rule`
//   would include files the caller meant to exclude;
// - absolute patterns are refused, because a baseline must stay inside the
//   workspace it belongs to;
// - a pattern without a slash matches any single path segment, so `docs` means
//   the whole `docs` tree at any depth and `*.md` means a Markdown file at any
//   depth. A pattern with a slash is anchored at the workspace root.

import { isAbsolute } from 'node:path';

import { GitBootstrapError } from './errors.mjs';
import { escapeRegExp } from './fs-primitives.mjs';

export function compilePatterns(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', `${label} must be an array of strings`);
  }
  if (value.some((item) => typeof item !== 'string')) {
    throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', `${label} must contain only strings`);
  }
  return value
    .filter((item) => item.trim() !== '')
    .map((item) => compilePattern(item, label));
}

export function compilePattern(pattern, label) {
  const normalized = pattern.trim().replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (normalized === '') {
    throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', `${label} contains an empty pattern`);
  }
  if (normalized.startsWith('!')) {
    throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', `${label} does not support negated patterns: ${pattern}`);
  }
  if (isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) {
    throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', `${label} patterns must be relative: ${pattern}`);
  }
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }
  return {
    pattern: normalized,
    hasSlash: normalized.includes('/'),
    regex: new RegExp(`^${source}$`, 'u'),
  };
}

export function matchesAnyPattern(rel, patterns) {
  return patterns.some((pattern) => {
    if (pattern.hasSlash) return pattern.regex.test(rel);
    // A slash-free pattern matches one path segment, so `docs` includes the
    // whole docs tree and `*.md` matches a Markdown file at any depth.
    return rel.split('/').some((segment) => pattern.regex.test(segment));
  });
}

/**
 * True when `includes` names the file itself rather than a directory or glob
 * that happens to contain it.
 *
 * This distinction decides whether a secret file is a warning or a hard
 * refusal: `include: ['src']` may legitimately cover a `.env` (it is excluded
 * and reported), while `include: ['.env']` is the caller asking for the secret.
 */
export function namesExactly(patterns, rel) {
  return patterns.some((pattern) => !/[*?]/u.test(pattern.pattern) && pattern.pattern === rel);
}
