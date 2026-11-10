import { isDefaultExcludedPath, normalizeWorkspacePath } from './changes.mjs';

const KNOWN_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'txt', 'yaml', 'yml',
  'py', 'rs', 'go', 'java', 'html', 'htm', 'css', 'scss', 'sh', 'ps1', 'toml', 'xml', 'sql',
]);

/**
 * Raw path candidates named by a finding (before default exclusions).
 *
 * Review reports mix prose and paths ("更新 src/x.mjs:49,244 与 src/y.mjs:453",
 * "update STATUS.md,HANDOFF.md"). A path is always a printable-ASCII run, so CJK
 * prose and conjunctions terminate a candidate on their own; each ASCII run is
 * then split on list punctuation and every fragment is validated. This keeps
 * `STATUS.md,HANDOFF.md` from becoming one fake path and keeps `:49,244` from
 * swallowing a real file.
 */
const ASCII_RUN = /[\x21-\x7E]+/g;
const PATH_FRAGMENT_SEPARATOR = /[,;|()[\]{}<>"'`]+/;
const PATH_TOKEN = /^[A-Za-z0-9._/-]+$/;

/** Strip `:12`, `:12-34`, `:12,34` and `#L12` location suffixes. */
function stripLocationSuffix(value) {
  return value
    .replace(/#L?[0-9]+(?:-L?[0-9]+)?$/i, '')
    .replace(/(?::[0-9]+(?:-[0-9]+)?(?:,[0-9]+)*)+$/, '')
    .replace(/:+$/, '');
}

/** Normalize a scope entry; unlike a changed path it may keep its trailing `/`. */
function normalizeScopePath(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const directory = trimmed.endsWith('/');
  const base = normalizeWorkspacePath(directory ? trimmed.slice(0, -1) : trimmed);
  if (!base) return undefined;
  return directory ? `${base}/` : base;
}

/** True when a scope entry is usable (a directory keeps its trailing marker). */
function isUsableScopePath(path) {
  if (!path) return false;
  const probe = path.endsWith('/') ? path.slice(0, -1) : path;
  return !isDefaultExcludedPath(probe);
}

function looksLikeFilePath(token) {
  // A slash alone is not a path: Chinese prose such as "映射并转发/等待" also
  // contains one. Require ASCII, no glob/quote punctuation, and either a
  // directory marker or a known source extension.
  if (!token || /[^\x20-\x7E]/.test(token)) return false;
  if (!PATH_TOKEN.test(token)) return false;
  if (token.startsWith('/') || token.includes('//')) return false;
  if (token.endsWith('/')) return true;
  const base = token.split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 && KNOWN_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function scopePathFromFragment(fragment) {
  if (!fragment) return undefined;
  const token = stripLocationSuffix(fragment).replace(/\.+$/, '');
  if (!looksLikeFilePath(token)) return undefined;
  return normalizeScopePath(token);
}

/**
 * A declared `finding.file` is authoritative even when its extension is unknown,
 * but it is still a list: reviews write `STATUS.md,HANDOFF.md` and
 * `src/x.mjs:49,244`. Strip the location suffix, split on list punctuation and
 * validate every fragment, so a comma list yields every real path instead of one
 * fake path that swallows the rest.
 */
function declaredFindingPaths(finding) {
  if (typeof finding?.file !== 'string') return [];
  const paths = [];
  const declared = stripLocationSuffix(finding.file.trim());
  for (const fragment of declared.split(PATH_FRAGMENT_SEPARATOR)) {
    const token = stripLocationSuffix(fragment.trim()).replace(/\.+$/, '');
    if (!token || !PATH_TOKEN.test(token)) continue;
    // `src/x.mjs:49,244` can leave a bare line number once the whole-value
    // suffix does not cover it; a number is never a declared file.
    if (/^[0-9]+$/.test(token)) continue;
    const path = normalizeScopePath(token);
    if (path) paths.push(path);
  }
  return [...new Set(paths)];
}

export function rawFindingPaths(finding) {
  const candidates = [];
  for (const declared of declaredFindingPaths(finding)) candidates.push(declared);
  if (typeof finding?.path === 'string') {
    for (const declared of declaredFindingPaths({ file: finding.path })) candidates.push(declared);
  }
  for (const text of [finding?.problem, finding?.requiredFix]) {
    if (typeof text !== 'string' || !text.trim()) continue;
    for (const run of text.match(ASCII_RUN) ?? []) {
      for (const fragment of run.split(PATH_FRAGMENT_SEPARATOR)) {
        const path = scopePathFromFragment(fragment);
        if (path) candidates.push(path);
      }
    }
  }
  return [...new Set(candidates)];
}

/**
 * Derive a repair scope from findings plus the reason the scope was chosen.
 * Findings win; otherwise the source task's inScope is used and a warning is
 * returned; otherwise the scope is empty and the caller must not invent one.
 * @param {Array<any>} findings
 * @param {string[]} [fallback]
 * @returns {{ scope: string[], source: 'findings'|'source'|'empty', warnings: string[] }}
 */
export function repairScopeReport(findings = [], fallback = []) {
  const derived = [];
  for (const finding of findings) {
    for (const path of rawFindingPaths(finding)) {
      if (!isUsableScopePath(path) || derived.includes(path)) continue;
      derived.push(path);
    }
  }
  if (derived.length > 0) return { scope: derived, source: 'findings', warnings: [] };

  const fromSource = [...new Set((fallback ?? [])
    .map((path) => normalizeScopePath(path))
    .filter((path) => path && isUsableScopePath(path)))];
  if (fromSource.length > 0) {
    return {
      scope: fromSource,
      source: 'source',
      warnings: [`findings name no workspace path; repair scope fell back to the source task inScope (${fromSource.join(', ')})`],
    };
  }
  return {
    scope: [],
    source: 'empty',
    warnings: ['findings name no workspace path and the source task declares no inScope'],
  };
}

/**
 * Derive a repair scope from findings: the observed file plus workspace-relative
 * paths named in problem/requiredFix, minus default-excluded paths.
 * @param {Array<any>} findings
 * @param {string[]} [fallback]
 * @returns {string[]}
 */
export function deriveRepairScope(findings = [], fallback = []) {
  return repairScopeReport(findings, fallback).scope;
}

/**
 * True when every finding cites at least one path and all cited paths are default-excluded.
 * @param {Array<any>} findings
 * @returns {boolean}
 */
export function allFindingsExcluded(findings = []) {
  if (findings.length === 0) return false;
  return findings.every((finding) => {
    const paths = rawFindingPaths(finding);
    return paths.length > 0 && paths.every((path) => !isUsableScopePath(path));
  });
}

export { looksLikeFilePath };
