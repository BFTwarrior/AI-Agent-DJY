// Planning: enumerate exactly what a baseline commit would contain.
//
// `planBootstrap` is the only writer of the file list, and every later phase is
// restricted to it — the mutation phase never re-walks the tree and never uses
// `git add -A`. That is the core safety property this module exists to keep.
//
// Each skipped path is recorded with a reason rather than dropped, so a caller
// can explain an incomplete baseline. Skips are classified as:
// - structural: ignored build/state directories, nested repositories;
// - unsafe: symlinks, non-regular files, secret names, oversized files;
// - requested: excluded by the caller's patterns or not matched by `include`.
//
// `include: []` selects nothing. Treating an empty array as "everything" is the
// single most dangerous plausible default here, so it is explicitly excluded.
//
// Two budgets bound the work on a huge tree and both report truncation instead
// of failing: the entry count, and the content-secret / line-count byte and
// file limits. Truncation never silently claims the unvisited files are clean.

import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SECRET_SCAN_BYTES,
  HARD_MAX_FILE_BYTES,
  LONG_PATH_THRESHOLD,
  MAX_CONTENT_SCAN_BYTES,
  MAX_CONTENT_SCAN_FILES,
  MAX_LINE_COUNT_BYTES,
  MAX_LINE_COUNT_FILE_BYTES,
  MAX_LINE_COUNT_FILES,
} from './contract.mjs';
import { GitBootstrapError } from './errors.mjs';
import {
  compareCodePoints,
  compareIgnored,
  compareRisk,
  hasGitEntry,
  isBootstrapTempName,
  isGitEntryName,
  isIgnoredDirectoryName,
  relativePosix,
  resolveWorkspace,
} from './fs-primitives.mjs';
import { compilePatterns, matchesAnyPattern, namesExactly } from './patterns.mjs';
import { countFileLines, isSecretName, isTextName, scanContentSecrets } from './secret-scan.mjs';

/**
 * Enumerate the files a bootstrap would commit.
 *
 * `include` uses the same segment/glob semantics as `exclude`; an explicitly
 * empty array selects no files (it is not treated as "everything"). `entries`
 * carries the dev/ino/size identity captured here so the mutation phase can
 * detect files replaced between planning and `git add`.
 *
 * @param {{
 *   cwd?: string,
 *   include?: string[],
 *   exclude?: string[],
 *   maxFileBytes?: number,
 *   maxEntries?: number,
 *   secretScanBytes?: number
 * }} [input]
 */
export function planBootstrap({
  cwd = process.cwd(),
  include,
  exclude,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxEntries = DEFAULT_MAX_ENTRIES,
  secretScanBytes = DEFAULT_SECRET_SCAN_BYTES,
} = {}) {
  const root = resolveWorkspace(cwd);
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (error) {
    throw new GitBootstrapError('GIT_PERMISSION', `cannot access workspace ${root}: ${error.message}`);
  }
  if (!rootStat.isDirectory()) {
    throw new GitBootstrapError('GIT_PERMISSION', `workspace path is not a directory: ${root}`);
  }
  const fileLimit = Number(maxFileBytes);
  if (!Number.isFinite(fileLimit) || fileLimit <= 0) {
    throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', 'maxFileBytes must be a positive number');
  }
  const entryLimit = Number(maxEntries);
  if (!Number.isInteger(entryLimit) || entryLimit <= 0) {
    throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', 'maxEntries must be a positive integer');
  }
  const scanLimit = Number(secretScanBytes);
  if (!Number.isInteger(scanLimit) || scanLimit < 0) {
    throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', 'secretScanBytes must be a non-negative integer');
  }
  const includes = compilePatterns(include, 'include');
  const includeRequested = include !== undefined && include !== null;
  const excludes = compilePatterns(exclude, 'exclude');

  const entries = [];
  const ignored = [];
  const secrets = [];
  const requestedSecrets = [];
  const contentSecrets = [];
  const largeFiles = [];
  const nestedRepos = [];
  const risks = [];
  const warnings = [];
  const stack = [root];
  let totalBytes = 0;
  let entryCount = 0;
  let codeLines = 0;
  let codeLinesApproximate = false;
  let lineCountFiles = 0;
  let lineCountBytes = 0;
  let contentScanFiles = 0;
  let contentScanBytes = 0;
  let contentScanTruncated = false;
  let truncated = false;

  while (stack.length > 0) {
    const dir = stack.pop();
    const relDir = relativePosix(root, dir);
    if (dir !== root) {
      let nested = false;
      try {
        nested = hasGitEntry(dir);
      } catch (error) {
        warnings.push(`cannot inspect ${relDir}: ${error.message}`);
        ignored.push({ path: relDir, reason: 'unreadable' });
        continue;
      }
      if (nested) {
        nestedRepos.push(relDir);
        ignored.push({ path: `${relDir}/`, reason: 'nested-repo' });
        continue;
      }
    }

    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (dir === root) {
        const code = error.code === 'EACCES' || error.code === 'EPERM' ? 'GIT_PERMISSION' : 'GIT_BOOTSTRAP_FAILED';
        throw new GitBootstrapError(code, `cannot read workspace ${root}: ${error.message}`);
      }
      warnings.push(`cannot read ${relDir}: ${error.message}`);
      ignored.push({ path: relDir, reason: 'unreadable' });
      continue;
    }
    dirents.sort((left, right) => compareCodePoints(left.name, right.name));

    for (const entry of dirents) {
      entryCount += 1;
      if (entryCount > entryLimit) {
        truncated = true;
        warnings.push(`workspace scan stopped after ${entryLimit} entries; the baseline is incomplete`);
        stack.length = 0;
        break;
      }
      const absolute = join(dir, entry.name);
      const rel = relativePosix(root, absolute);
      if (isGitEntryName(entry.name) || isBootstrapTempName(entry.name)) continue;

      let symlink = entry.isSymbolicLink();
      let directory = entry.isDirectory();
      let file = entry.isFile();
      if (!symlink && !directory && !file) {
        // Some network and virtual filesystems report DT_UNKNOWN; ask lstat.
        try {
          const stat = lstatSync(absolute);
          symlink = stat.isSymbolicLink();
          directory = stat.isDirectory();
          file = stat.isFile();
        } catch (error) {
          warnings.push(`cannot inspect ${rel}: ${error.message}`);
          ignored.push({ path: rel, reason: 'unreadable' });
          continue;
        }
      }

      if (symlink) {
        ignored.push({ path: rel, reason: 'symlink' });
        warnings.push(`skipping symbolic link ${rel}`);
        continue;
      }
      if (directory) {
        if (isIgnoredDirectoryName(entry.name)) {
          ignored.push({ path: `${rel}/`, reason: 'directory' });
        } else {
          stack.push(absolute);
        }
        continue;
      }
      if (!file) {
        ignored.push({ path: rel, reason: 'not-a-regular-file' });
        continue;
      }
      if (isSecretName(entry.name)) {
        secrets.push(rel);
        // Naming a secret file explicitly is an error; a directory include that
        // merely contains secrets still excludes them with a report.
        if (namesExactly(includes, rel)) requestedSecrets.push(rel);
        ignored.push({ path: rel, reason: 'secret' });
        continue;
      }
      if (excludes.length > 0 && matchesAnyPattern(rel, excludes)) {
        ignored.push({ path: rel, reason: 'exclude' });
        continue;
      }
      if (includeRequested && (includes.length === 0 || !matchesAnyPattern(rel, includes))) {
        ignored.push({ path: rel, reason: 'not-included' });
        continue;
      }

      let fileStat;
      try {
        fileStat = lstatSync(absolute);
      } catch (error) {
        if (error.code === 'ENOENT') {
          warnings.push(`file disappeared during planning: ${rel}`);
          continue;
        }
        throw new GitBootstrapError(
          error.code === 'EACCES' || error.code === 'EPERM' ? 'GIT_PERMISSION' : 'GIT_BOOTSTRAP_FAILED',
          `cannot inspect ${rel}: ${error.message}`,
        );
      }
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        // The dirent was stale; the path changed between readdir and lstat.
        ignored.push({ path: rel, reason: fileStat.isSymbolicLink() ? 'symlink' : 'not-a-regular-file' });
        warnings.push(`skipping ${rel}; it is no longer a regular file`);
        continue;
      }
      if (fileStat.size > HARD_MAX_FILE_BYTES) {
        throw new GitBootstrapError(
          'GIT_TOO_LARGE',
          `file exceeds the hard size limit of ${HARD_MAX_FILE_BYTES} bytes: ${rel}`,
          { path: rel, size: fileStat.size },
        );
      }
      if (fileStat.size > fileLimit) {
        largeFiles.push({ path: rel, size: fileStat.size });
        ignored.push({ path: rel, reason: 'large-file' });
        continue;
      }

      if (absolute.length > LONG_PATH_THRESHOLD) {
        risks.push({
          type: 'long-path',
          path: rel,
          message: `path is ${absolute.length} characters long; Windows MAX_PATH limits can reject git operations`,
        });
      }

      if (scanLimit > 0) {
        if (contentScanTruncated || contentScanFiles >= MAX_CONTENT_SCAN_FILES
          || contentScanBytes >= MAX_CONTENT_SCAN_BYTES) {
          if (!contentScanTruncated) {
            contentScanTruncated = true;
            warnings.push('content secret scan stopped at its size limit; remaining files were not scanned');
          }
        } else {
          try {
            const hit = scanContentSecrets(absolute, fileStat.size, scanLimit);
            contentScanFiles += 1;
            contentScanBytes += Math.min(fileStat.size, scanLimit);
            if (hit) contentSecrets.push({ path: rel, kind: hit.kind, line: hit.line });
          } catch (error) {
            warnings.push(`cannot scan ${rel} for secret content: ${error.message}`);
          }
        }
      }

      if (isTextName(entry.name)) {
        if (lineCountFiles >= MAX_LINE_COUNT_FILES || lineCountBytes >= MAX_LINE_COUNT_BYTES) {
          codeLinesApproximate = true;
        } else {
          try {
            const counted = countFileLines(absolute, fileStat.size);
            codeLines += counted.lines;
            if (!counted.complete) codeLinesApproximate = true;
            lineCountFiles += 1;
            lineCountBytes += Math.min(fileStat.size, MAX_LINE_COUNT_FILE_BYTES);
          } catch (error) {
            codeLinesApproximate = true;
            warnings.push(`cannot count lines in ${rel}: ${error.message}`);
          }
        }
      }

      entries.push({
        path: rel,
        size: fileStat.size,
        dev: fileStat.dev,
        ino: fileStat.ino,
        mtimeMs: fileStat.mtimeMs,
      });
      totalBytes += fileStat.size;
    }
  }

  entries.sort((left, right) => compareCodePoints(left.path, right.path));
  secrets.sort(compareCodePoints);
  requestedSecrets.sort(compareCodePoints);
  contentSecrets.sort((left, right) => compareCodePoints(left.path, right.path));
  largeFiles.sort((left, right) => compareCodePoints(left.path, right.path));
  ignored.sort(compareIgnored);
  nestedRepos.sort(compareCodePoints);
  risks.sort(compareRisk);

  return {
    cwd: root,
    files: entries.map((entry) => entry.path),
    entries,
    ignored,
    secrets,
    requestedSecrets,
    contentSecrets,
    largeFiles,
    nestedRepos,
    risks,
    warnings,
    totalBytes,
    fileCount: entries.length,
    codeLines,
    codeLinesApproximate,
    truncated,
    contentScanTruncated,
    maxFileBytes: fileLimit,
    maxEntries: entryLimit,
    secretScanBytes: scanLimit,
  };
}
