// Filesystem primitives shared by inspection, planning and mutation.
//
// These helpers are the only place that decides "what is this path", so every
// caller reaches the same answer for the same entry:
// - Windows comparison is case-insensitive where the filesystem is, and
//   byte-exact on POSIX (matching git's own semantics). Getting this backwards
//   makes `.ENV` commit on Linux and vanish on Windows.
// - `lstat` is used everywhere identity matters: a symlink must be classified
//   as a symlink, never as the regular file it points at, because following one
//   would commit content from outside the workspace.
// - Ordering never depends on the locale or on ICU, so marker digests and
//   reports are identical on every machine.

import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { BOOTSTRAP_STATE_DIR, IGNORED_DIRECTORIES, LONG_PATH_THRESHOLD } from './contract.mjs';
import { GitBootstrapError } from './errors.mjs';

export function isWin32() {
  return process.platform === 'win32';
}

export function toPosix(value) {
  return sep === '/' ? value : value.split(sep).join('/');
}

export function relativePosix(root, path) {
  return toPosix(relative(root, path)) || '.';
}

// Sorting must not depend on ICU or the active locale: marker digests and
// reports have to be identical on every machine.
export function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareIgnored(left, right) {
  return compareCodePoints(left.path, right.path) || compareCodePoints(left.reason, right.reason);
}

export function compareRisk(left, right) {
  return compareCodePoints(left.type, right.type) || compareCodePoints(left.path, right.path);
}

/**
 * Merge risk lists from several phases, de-duplicated by type/path/message.
 *
 * Inspection and planning both look for long paths and OneDrive roots, so the
 * same risk is routinely found twice; the reported list must not contain it
 * twice, and its order must stay stable.
 */
export function mergeRisks(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const risk of list ?? []) {
      const key = `${risk.type}\0${risk.path}\0${risk.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(risk);
    }
  }
  return merged.sort(compareRisk);
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function isGitEntryName(name) {
  return isWin32() ? name.toLowerCase() === '.git' : name === '.git';
}

export function isIgnoredDirectoryName(name) {
  if (isWin32()) {
    const lower = name.toLowerCase();
    return IGNORED_DIRECTORIES.some((candidate) => candidate.toLowerCase() === lower);
  }
  return IGNORED_DIRECTORIES.includes(name);
}

// Temp files written by writeFileAtomic live next to the state directory. They
// must never be planned as content of the baseline, or a crashed writer would
// commit its own scratch file.
export function isBootstrapTempName(name) {
  return name.startsWith('.ai-agent-teams-gitignore-');
}

export function realPath(value) {
  // `realpathSync.native` resolves Windows junctions and 8.3 short names the
  // same way the filesystem does; the fs copy is the fallback everywhere else.
  const resolver = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync;
  return resolver(value);
}

/**
 * Resolve the workspace to an absolute, symlink-free path.
 *
 * Every later phase compares paths against this root, so resolving once is what
 * makes "inside the workspace" checks sound: a junction could otherwise make a
 * child path look like it lives outside the workspace or vice versa. Failing
 * here is a permission problem, not a bootstrap problem: the path may simply
 * not exist yet.
 */
export function resolveWorkspace(cwd) {
  const absolute = resolve(cwd);
  try {
    return realPath(absolute);
  } catch (error) {
    throw new GitBootstrapError(
      'GIT_PERMISSION',
      `cannot resolve workspace ${absolute}: ${error.message}`,
      { cause: error },
    );
  }
}

export function isOwnerWritable(stat) {
  return (stat.mode & 0o200) !== 0;
}

export function pathWritable(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return false;
  }
  if (!isOwnerWritable(stat)) return false;
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `lstat`-based existence check for a `.git` entry.
 *
 * A `.git` FILE is a git worktree or submodule pointer and counts as a
 * repository; only `ENOENT`/`ENOTDIR` mean "absent". Any other error is
 * rethrown so a permission problem is never misread as "safe to init here".
 */
export function hasGitEntry(dir) {
  try {
    lstatSync(join(dir, '.git'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

export function looksLikeBareRepository(dir) {
  try {
    return statSync(join(dir, 'HEAD')).isFile()
      && statSync(join(dir, 'config')).isFile()
      && statSync(join(dir, 'objects')).isDirectory()
      && statSync(join(dir, 'refs')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Report environmental hazards that make git unreliable but must not block it.
 *
 * OneDrive and long paths are reported, never refused: a synced folder works
 * most of the time, and refusing would make the feature unusable for those
 * users, while refusing silently would hide a real cause of later failures.
 */
export function pathRisks(path) {
  const risks = [];
  const segments = path.split(/[\\/]+/u).filter(Boolean);
  if (segments.some((segment) => /^OneDrive(?: - .*)?$/iu.test(segment))) {
    risks.push({
      type: 'onedrive',
      path,
      message: 'workspace is inside a OneDrive-synced folder; sync conflicts and file locks can break git operations',
    });
  }
  if (path.length > LONG_PATH_THRESHOLD) {
    risks.push({
      type: 'long-path',
      path,
      message: `path is ${path.length} characters long; Windows MAX_PATH limits can reject git operations`,
    });
  }
  const oneDriveRoot = process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial;
  if (oneDriveRoot) {
    try {
      const normalized = realPath(oneDriveRoot);
      if (path === normalized) risks.push({ type: 'onedrive', path, message: 'workspace is the OneDrive root' });
      const prefix = normalized.endsWith(sep) ? normalized : `${normalized}${sep}`;
      if (path.startsWith(prefix)) {
        risks.push({
          type: 'onedrive',
          path,
          message: 'workspace is inside the OneDrive folder from the environment; sync can interfere with git',
        });
      }
    } catch {
      // An unreadable OneDrive environment variable is not a blocker.
    }
  }
  return risks;
}

/**
 * Directory that holds the bootstrap lock and the atomic-write scratch files.
 *
 * Both writers need it, so it lives with the other path identity rules rather
 * than in either caller.
 */
export function bootstrapStateDirectory(root) {
  return join(root, BOOTSTRAP_STATE_DIR);
}
