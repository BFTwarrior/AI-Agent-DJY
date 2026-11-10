import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathMatchesScope } from './gates.mjs';

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string|undefined} absolute path, or undefined if it escapes the root
 */
function safeResolve(root, rel) {
  const absoluteRoot = realpathSync(resolve(root));
  const absolute = resolve(absoluteRoot, rel);
  const relToRoot = relative(absoluteRoot, absolute);
  if (relToRoot === '' || relToRoot.startsWith('..') || isAbsolute(relToRoot)) return undefined;
  try {
    const real = realpathSync(absolute);
    const relReal = relative(absoluteRoot, real);
    if (relReal === '' || relReal.startsWith('..') || isAbsolute(relReal)) return undefined;
    return real;
  } catch {
    return absolute;
  }
}

/**
 * Digest one workspace-relative file.
 * @param {string} root
 * @param {string} rel
 * @returns {import('./types.mjs').ArtifactDigest}
 */
export function digestFile(root, rel) {
  const path = String(rel).replaceAll(sep, '/');
  const absolute = safeResolve(root, path);
  if (!absolute) {
    return { path, present: false, unreadable: true, reason: 'path escapes the workspace' };
  }
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) {
      return { path, present: true, unreadable: true, reason: 'not a regular file', size: stat.size, mtimeMs: stat.mtimeMs };
    }
    const bytes = readFileSync(absolute);
    return {
      path,
      present: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      mtimeMs: stat.mtimeMs,
      unreadable: false,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { path, present: false };
    return {
      path,
      present: false,
      unreadable: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * @param {string} root
 * @param {string[]} paths
 * @returns {import('./types.mjs').ArtifactDigest[]}
 */
export function digestPaths(root, paths = []) {
  return [...new Set(paths)].map((path) => digestFile(root, path));
}

/**
 * Compare two digest sets. Returns the paths that were added, removed, or changed.
 * @param {import('./types.mjs').ArtifactDigest[]} [before]
 * @param {import('./types.mjs').ArtifactDigest[]} [after]
 * @returns {string[]}
 */
export function detectDrift(before = [], after = []) {
  const beforeMap = new Map(before.map((item) => [item.path, item]));
  const afterMap = new Map(after.map((item) => [item.path, item]));
  const paths = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const drift = [];
  for (const path of paths) {
    const a = beforeMap.get(path);
    const b = afterMap.get(path);
    if (!a || !b) {
      drift.push(path);
      continue;
    }
    if (a.present !== b.present || a.unreadable !== b.unreadable || a.sha256 !== b.sha256) {
      drift.push(path);
    }
  }
  return drift;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.agent-teams', '.agent-teams-worktrees', '.ai-agent-teams', '.zcode-agent-teams']);
const FILE_CAP = 2000;

/**
 * List workspace-relative files, skipping vendor/state directories.
 * @param {string} root
 * @param {{ maxFiles?: number }} [options]
 * @returns {{ files: string[], truncated: boolean }}
 */
export function listWorkspaceFiles(root, options = {}) {
  const maxFiles = options.maxFiles ?? FILE_CAP;
  const files = [];
  let truncated = false;
  const walk = (dir, prefix) => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) {
        files.push(rel);
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
      }
    }
  };
  walk(root, '');
  return { files, truncated };
}

/**
 * Snapshot the files matching a set of scope patterns.
 * @param {string} root
 * @param {string[]} [patterns]
 * @returns {{ at: number, artifacts: Array<any>, gaps: Array<{pattern:string,reason:string}> }}
 */
export function snapshotScope(root, patterns = []) {
  const { files, truncated } = listWorkspaceFiles(root);
  const selected = patterns.length === 0
    ? files
    : files.filter((file) => patterns.some((pattern) => pathMatchesScope(file, pattern)));
  const gaps = truncated
    ? [{ pattern: patterns.join(',') || '*', reason: 'file cap 2000 reached' }]
    : [];
  return { at: Date.now(), artifacts: selected.map((file) => digestFile(root, file)), gaps };
}
