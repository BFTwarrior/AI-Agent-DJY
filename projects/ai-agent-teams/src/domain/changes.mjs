import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(args, cwd) {
  const result = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

/**
 * Parse `git status --porcelain` into workspace-relative paths.
 * Handles renames ("old -> new") and quoted paths.
 * @param {string} output
 * @returns {string[]}
 */
export function parsePorcelain(output) {
  const paths = new Set();
  for (const line of String(output ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let path = line.slice(3).trim();
    if (path.includes(' -> ')) path = path.split(' -> ').pop().trim();
    path = path.replace(/^"(.*)"$/, '$1');
    if (path) paths.add(path.split(String.fromCharCode(92)).join('/'));
  }
  return [...paths].sort();
}

/**
 * Derive the real changed paths from git, not from the member's self-report.
 * Includes uncommitted changes and commits since `baseRef`.
 * @param {{ worktree: string, baseRef?: string }} input
 * @returns {Promise<string[]>}
 */
export async function deriveChangedPaths({ worktree, baseRef }) {
  const paths = new Set();
  // core.quotePath=false keeps non-ASCII paths readable. Git otherwise emits
  // them as C-style octal escapes ("\346\226\207..."), which look like illegal
  // absolute paths to the scope gate.
  const status = await git(['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall'], worktree);
  for (const path of parsePorcelain(status)) paths.add(path);
  if (baseRef) {
    const diff = await git(['-c', 'core.quotePath=false', 'diff', '--name-only', `${baseRef}...HEAD`], worktree);
    for (const path of diff.split(/\r?\n/)) {
      const normalized = path.trim().split(String.fromCharCode(92)).join('/');
      if (normalized) paths.add(normalized);
    }
  }
  return [...paths].sort();
}

const BACKSLASH = String.fromCharCode(92);
const CASE_INSENSITIVE = process.platform === 'win32';
const fold = (value) => (CASE_INSENSITIVE ? value.toLowerCase() : value);
const DEFAULT_EXCLUDED_TOP = new Set(['.git', '.dsh', '.zcode', 'node_modules', 'secrets']);
const EXCLUDED_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx']);

/** @param {unknown} value */
export function normalizeWorkspacePath(value) {
  if (typeof value !== 'string') return undefined;
  if (value.includes(BACKSLASH)) return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return undefined;
  const parts = raw.split('/');
  if (parts.some((part) => part === '' || part === '..')) return undefined;
  const normalized = parts.filter((part) => part !== '.').join('/');
  if (!normalized || normalized.startsWith('..')) return undefined;
  return normalized;
}

/** @param {unknown} value */
export function isDefaultExcludedPath(value) {
  const path = normalizeWorkspacePath(value);
  if (!path) return true;
  const segments = path.split('/').map(fold);
  if (segments.some((segment) => DEFAULT_EXCLUDED_TOP.has(segment))) return true;
  const base = segments[segments.length - 1];
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base.startsWith('id_rsa')) return true;
  const dot = base.lastIndexOf('.');
  if (dot >= 0 && EXCLUDED_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())) return true;
  return false;
}

/**
 * Match a glob pattern split into segments against a path split into segments.
 * Supports `**` (zero or more segments), `*` (one segment), and `pre*suf`.
 * @param {string[]} patternSegments
 * @param {string[]} pathSegments
 * @returns {boolean}
 */
function matchGlobSegments(patternSegments, pathSegments) {
  const matchSegment = (head, first) => {
    if (head === '*') return true;
    if (!head.includes('*')) return head === first;
    // Match every literal part without compiling attacker-controlled globs
    // into a potentially exponential regular expression.
    let patternIndex = 0;
    let pathIndex = 0;
    let starIndex = -1;
    let starPathIndex = 0;
    while (pathIndex < first.length) {
      if (head[patternIndex] === '*') {
        starIndex = patternIndex++;
        starPathIndex = pathIndex;
      } else if (head[patternIndex] === first[pathIndex]) {
        patternIndex += 1;
        pathIndex += 1;
      } else if (starIndex !== -1) {
        patternIndex = starIndex + 1;
        pathIndex = ++starPathIndex;
      } else return false;
    }
    while (head[patternIndex] === '*') patternIndex += 1;
    return patternIndex === head.length;
  };

  // Dynamic programming bounds the number of segment-level states instead of
  // revisiting the same suffixes recursively; each state may also compare a
  // pattern segment with a path segment.
  let previous = Array(pathSegments.length + 1).fill(false);
  previous[0] = true;
  for (const segment of patternSegments) {
    const current = Array(pathSegments.length + 1).fill(false);
    if (segment === '**') current[0] = previous[0];
    for (let index = 1; index <= pathSegments.length; index += 1) {
      current[index] = segment === '**'
        ? previous[index] || current[index - 1]
        : previous[index - 1] && matchSegment(segment, pathSegments[index - 1]);
    }
    previous = current;
  }
  return previous[pathSegments.length];
}

/**
 * @param {string} path
 * @param {string} pattern
 * @returns {boolean}
 */
function isSupportedScopePattern(pattern) {
  if (typeof pattern !== 'string') return false;
  const trimmed = pattern.trim();
  const normalized = normalizeWorkspacePath(trimmed.replace(/\/+$/, ''));
  if (!normalized || (trimmed.endsWith('/') && normalized.includes('*'))) return false;
  return normalized.split('/').every((segment) => segment === '**' || (segment.match(/\*/g) ?? []).length <= 1);
}

export function pathMatchesScope(path, pattern) {
  if (!isSupportedScopePattern(pattern)) return false;
  const normalizedPath = normalizeWorkspacePath(path);
  const trimmedPattern = pattern.trim();
  const rawPattern = trimmedPattern.replace(/\/+$/, '');
  const normalizedPattern = normalizeWorkspacePath(rawPattern);
  if (!normalizedPath || !normalizedPattern) return false;
  const pathValue = fold(normalizedPath);
  const patternValue = fold(normalizedPattern);
  if (trimmedPattern.endsWith('/')) {
    return pathValue === patternValue || pathValue.startsWith(patternValue + '/');
  }
  if (patternValue.includes('*')) {
    return matchGlobSegments(patternValue.split('/'), pathValue.split('/'));
  }
  return pathValue === patternValue;
}

/**
 * @param {string} path
 * @param {string[]} [inScope]
 * @param {string[]} [outOfScope]
 * @returns {'in_scope'|'out_of_scope'|'undeclared'|'illegal'}
 */
export function classifyChangedPath(path, inScope = [], outOfScope = []) {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized || isDefaultExcludedPath(normalized)) return 'illegal';
  if ([...inScope, ...outOfScope].some((pattern) => !isSupportedScopePattern(pattern))) return 'illegal';
  if (outOfScope.some((pattern) => pathMatchesScope(normalized, pattern))) return 'out_of_scope';
  if (inScope.some((pattern) => pathMatchesScope(normalized, pattern))) return 'in_scope';
  return 'undeclared';
}

const MAX_ARTIFACT_BYTES = 2 * 1024 ** 3;

async function artifactGit(args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  return (await exec('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

function assertProvenance({ teamId, taskId, attemptId }) {
  if (![teamId, taskId, attemptId].every((value) => typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value))
    || teamId.includes('/') || taskId.includes('/')) throw new TypeError('invalid provenance');
}

async function inspectArtifact({ worktree, base, inScope, outOfScope = [], teamId, taskId, attemptId, requireProvenance = true, acceptedProvenanceAttempts = [] }) {
  if (!worktree || !base || !Array.isArray(inScope) || !inScope.length || !teamId || !taskId || !attemptId) {
    throw new TypeError('worktree, base, non-empty inScope, teamId, taskId, and attemptId are required');
  }
  assertProvenance({ teamId, taskId, attemptId });
  const resolvedBase = (await artifactGit(['rev-parse', '--verify', `${base}^{commit}`], worktree)).trim();
  const head = (await artifactGit(['rev-parse', '--verify', 'HEAD^{commit}'], worktree)).trim();
  const ancestor = await artifactGit(['merge-base', '--is-ancestor', resolvedBase, head], worktree).then(() => true, (error) => {
    if (error.code === 1) return false;
    throw error;
  });
  if (!ancestor) throw new Error('contract_error: not_descendant');

  const statusText = await artifactGit(['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z'], worktree);
  const statusPaths = statusText.split('\0').filter(Boolean).map((entry) => entry.slice(3));
  const diffText = await artifactGit(['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', resolvedBase], worktree);
  const changed = [...new Set([...statusPaths, ...diffText.split('\0').filter(Boolean)])].sort();
  for (const path of changed) {
    const normalized = normalizeWorkspacePath(path);
    const lowerPath = path.toLowerCase();
    const segments = lowerPath.split('/');
    const sensitive = segments.includes('.ssh') || ['.npmrc', '.netrc', 'credentials.json'].includes(segments.at(-1))
      || segments.some((segment, index) => segment === '.aws' && segments[index + 1] === 'credentials');
    if (!normalized || normalized !== path || sensitive || classifyChangedPath(path, inScope, outOfScope) !== 'in_scope') {
      throw new Error(`contract_error: illegal_or_out_of_scope_path: ${path}`);
    }
    try {
      const parts = path.split('/');
      for (let index = 1; index <= parts.length; index += 1) {
        const info = await lstat(join(worktree, ...parts.slice(0, index)));
        if (info.isSymbolicLink()) throw new Error(`contract_error: symlink: ${path}`);
        if (index === parts.length && info.isFile() && info.size > MAX_ARTIFACT_BYTES) throw new Error(`contract_error: oversized_file: ${path}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (head !== resolvedBase && statusPaths.length === 0) {
    if (!changed.length) throw new Error('contract_error: empty_commit');
    if (requireProvenance) {
      const message = await artifactGit(['show', '-s', '--format=%B', head], worktree);
      const trailers = message.trimEnd().split(/\r?\n\r?\n/).at(-1).split(/\r?\n/);
      const expected = [`Agent-Teams-Task: ${teamId}/${taskId}`, `Agent-Teams-Base: ${resolvedBase}`];
      const attemptTrailers = trailers.filter((line) => /^Agent-Teams-Attempt:/i.test(line));
      // A commit that survived a DB failure keeps the old attempt trailer. It
      // is reusable only when the service explicitly accepts that attempt for
      // this same task and base.
      const allowedAttempts = new Set([attemptId, ...acceptedProvenanceAttempts]);
      const commitAttempt = attemptTrailers[0]?.slice('Agent-Teams-Attempt:'.length).trim();
      if (attemptTrailers.length !== 1 || !allowedAttempts.has(commitAttempt)
        || expected.some((line) => trailers.filter((item) => item === line).length !== 1)
        || trailers.some((line) => /^Agent-Teams-(Task|Attempt|Base):/i.test(line)
          && !expected.includes(line) && !/^Agent-Teams-Attempt:/i.test(line))) {
        throw new Error('contract_error: provenance_mismatch');
      }
    }
  }
  return { resolvedBase, head, changed, statusPaths, dirty: statusPaths.length > 0 };
}

/**
 * Inspect a candidate artifact and refuse publication when exclusive access is
 * unproven. Kept as the pure inspection entry point; it never commits.
 */
export async function preflightArtifactBeforeReview(input) {
  const inspected = await inspectArtifact(input);
  if (inspected.head === inspected.resolvedBase && inspected.changed.length === 0) throw new Error('contract_error: no_changes');
  if (!inspected.changed.length) throw new Error('contract_error: no_changes');
  throw new Error('infra_error: exclusive_worktree_fence_unavailable');
}

function assertFrozenFence({ fence, worktree, teamId, taskId, attemptId }) {
  // A caller-supplied boolean, timestamp or lease timeout is not evidence. The
  // infrastructure owner must hand back an identity-bound capability whose
  // verify() re-checks the live worktree and whose release() is idempotent.
  if (!fence || typeof fence !== 'object' || typeof fence.verify !== 'function'
    || typeof fence.release !== 'function' || fence.state !== 'frozen'
    || typeof fence.proof !== 'string' || fence.proof.length < 16
    || fence.worktree !== worktree || fence.teamId !== teamId
    || fence.taskId !== taskId || fence.attemptId !== attemptId) {
    throw new Error('infra_error: exclusive_worktree_fence_unavailable');
  }
}

async function verifyFence(fence) {
  let verified;
  try {
    verified = await fence.verify();
  } catch {
    verified = false;
  }
  if (verified !== true) throw new Error('infra_error: exclusive_worktree_fence_lost');
}

/**
 * Commit the member's artifact while a trusted exclusive worktree fence is
 * held, then return the immutable delivery identity. The fence capability is
 * supplied by the infrastructure owner; without it this function fails closed
 * instead of treating a boolean or a single snapshot as proof.
 *
 * @param {{ worktree: string, base: string, inScope: string[], outOfScope?: string[],
 *   teamId: string, taskId: string, attemptId: string, fence: any }} input
 * @returns {Promise<{ sourceBase: string, sourceCommit: string, diffHash: string, changedPaths: string[] }>}
 */
export async function commitArtifactBeforeReview({ worktree, base, inScope, outOfScope = [], teamId, taskId, attemptId, fence, requireProvenance = true, acceptedProvenanceAttempts = [] }) {
  assertFrozenFence({ fence, worktree, teamId, taskId, attemptId });
  try {
    await verifyFence(fence);
    let inspected = await inspectArtifact({ worktree, base, inScope, outOfScope, teamId, taskId, attemptId, requireProvenance, acceptedProvenanceAttempts });
    let committed = false;
    if (inspected.dirty) {
      if (inspected.changed.length === 0) throw new Error('contract_error: no_changes');
      await artifactGit(['add', '--', ...inspected.changed], worktree);
      const trailers = [
        `Agent-Teams-Task: ${teamId}/${taskId}`,
        `Agent-Teams-Attempt: ${attemptId}`,
        `Agent-Teams-Base: ${inspected.resolvedBase}`,
      ];
      await artifactGit([
        '-c', 'user.name=Ai-Agent-Teams',
        '-c', 'user.email=ai-agent-teams@local.invalid',
        'commit', '--no-verify', '-m', `agent-teams: ${teamId}/${taskId}`,
        '-m', trailers.join('\n'),
      ], worktree);
      committed = true;
    }
    inspected = await inspectArtifact({ worktree, base, inScope, outOfScope, teamId, taskId, attemptId, requireProvenance, acceptedProvenanceAttempts });
    if (inspected.dirty) throw new Error('contract_error: worktree_changed_during_commit');
    if (!inspected.changed.length) throw new Error('contract_error: no_changes');
    // Bind the fence to the commit this attempt inspected. A clean tree alone
    // is not proof that an external writer did not commit in the meantime.
    if (typeof fence.expectCommit === 'function') fence.expectCommit(inspected.head);
    await verifyFence(fence);
    // Canonical digest over raw diff entries (mode + full blob ids + path),
    // sorted so output ordering and text diff headers cannot change the
    // identity. Unlike a `git diff` text hash this is independent of context
    // lines, quoting and diff algorithm settings.
    const rawDiff = await artifactGit(['-c', 'core.quotePath=false', 'diff', '--raw', '-z', '--no-renames',
      '--full-index', '--no-abbrev', `${inspected.resolvedBase}..${inspected.head}`, '--'], worktree);
    const tokens = rawDiff.split('\0');
    // `--raw -z` emits `:meta\0path\0` pairs plus a trailing empty token. An
    // even length means a truncated pair, which must not silently drop the
    // last path from the digest.
    if (tokens.length % 2 === 0) throw new Error('contract_error: malformed_raw_diff');
    const entries = [];
    for (let index = 0; index + 1 < tokens.length; index += 2) {
      entries.push(`${tokens[index]}\0${tokens[index + 1]}`);
    }
    entries.sort();
    const diffHash = createHash('sha256').update(entries.join('\0')).digest('hex');
    return {
      sourceBase: inspected.resolvedBase,
      sourceCommit: inspected.head,
      diffHash,
      changedPaths: inspected.changed,
      ...(committed ? { committed: true } : { alreadyCommitted: true }),
    };
  } finally {
    try {
      await fence.release();
    } catch {
      // Releasing a fence must not hide the commit/validation error. A lost
      // release is reported by the provider and reconciled there.
    }
  }
}
