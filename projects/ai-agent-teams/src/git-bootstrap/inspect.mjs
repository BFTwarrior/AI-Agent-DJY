// Workspace resolution and the read-only inspection phase.
//
// `inspectProject` is the gate that runs before anything is written. It answers
// one question — may this workspace receive a repository created by us — and it
// must never mutate the tree, because callers use it on every startup and a
// failed startup must cost nothing.
//
// Blockers are reported, not thrown, so the caller can surface an error code
// and the human-readable reason together. A workspace inside a parent
// repository, a nested repository, another VCS checkout, or a read-only tree
// all land in distinct codes; "permission" is separate from "read-only" because
// the first is an unreadable path and the second a writable-but-refused one.

import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { DEFAULT_MAX_ENTRIES, VCS_MARKERS } from './contract.mjs';
import { errorEntry } from './errors.mjs';
import {
  compareCodePoints,
  hasGitEntry,
  isIgnoredDirectoryName,
  isOwnerWritable,
  looksLikeBareRepository,
  pathRisks,
  pathWritable,
  relativePosix,
  resolveWorkspace,
} from './fs-primitives.mjs';

function findVcsMarkers(start) {
  const markers = [];
  let cursor = start;
  while (true) {
    for (const marker of VCS_MARKERS) {
      const path = join(cursor, marker);
      if (existsSync(path)) markers.push({ path, marker });
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return markers;
}

/**
 * Classify the workspace `.gitignore` without modifying it.
 *
 * A symlinked or non-regular `.gitignore` is a warning here and a refusal in
 * `readGitignore`. Inspecting must stay tolerant because the file is not ours
 * yet, while mutating it through a symlink would write outside the workspace.
 */
export function inspectGitignore(root, warnings) {
  const path = join(root, '.gitignore');
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { symlink: true };
    if (!stat.isFile()) return { notFile: true };
    return { readOnly: !isOwnerWritable(stat) || !pathWritable(path) };
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      warnings.push(`cannot inspect .gitignore: ${error.message}`);
    }
    return {};
  }
}

/**
 * Breadth-first scan for repositories below the workspace.
 *
 * Bounded by `maxDepth` and `maxEntries`; ignored directories are not entered,
 * so a `node_modules` full of nested packages costs nothing. Truncation is
 * reported through `onTruncated` instead of being treated as "none found".
 */
export function findNestedRepos(root, { maxDepth, maxEntries, warnings, onTruncated }) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  let cursor = 0;
  let visited = 0;
  while (cursor < queue.length) {
    const { dir, depth } = queue[cursor];
    cursor += 1;
    if (dir !== root) {
      let nested = false;
      try {
        nested = hasGitEntry(dir);
      } catch (error) {
        warnings.push(`cannot inspect ${relativePosix(root, dir)}: ${error.message}`);
        continue;
      }
      if (nested) {
        const rel = relativePosix(root, dir);
        if (rel !== '.') found.push(rel);
        continue;
      }
    }
    if (depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push(`cannot scan ${relativePosix(root, dir)}: ${error.message}`);
      continue;
    }
    entries.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) {
        warnings.push(`nested repository scan stopped after ${maxEntries} entries`);
        if (typeof onTruncated === 'function') onTruncated();
        return found.sort(compareCodePoints);
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (isIgnoredDirectoryName(entry.name)) continue;
      queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
    }
  }
  return found.sort(compareCodePoints);
}

/**
 * Inspect a workspace and decide whether bootstrap is allowed.
 *
 * `repoRoot` is the repository that governs the workspace: the workspace
 * itself for status 'git', the parent repository for status 'parent-repo',
 * and null otherwise. `parentRepo` always carries the detected parent.
 *
 * @param {{ cwd?: string, maxNestedDepth?: number, maxEntries?: number }} [input]
 * @returns {{
 *   cwd: string,
 *   status: 'git'|'not-git'|'parent-repo'|'nested-repo'|'existing-vcs'|'read-only'|'permission',
 *   code: string|null,
 *   repoRoot: string|null,
 *   parentRepo: string|null,
 *   bootstrapRequired: boolean,
 *   nestedRepos: string[],
 *   vcsMarkers: Array<{ path: string, marker: string }>,
 *   risks: Array<{ type: string, path: string, message: string }>,
 *   errors: Array<{ code: string, message: string }>,
 *   warnings: string[]
 * }}
 */
export function inspectProject({ cwd = process.cwd(), maxNestedDepth = 3, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  let root;
  const errors = [];
  const warnings = [];
  try {
    root = resolveWorkspace(cwd);
  } catch (error) {
    return {
      cwd: resolve(cwd),
      status: 'permission',
      code: 'GIT_PERMISSION',
      repoRoot: null,
      parentRepo: null,
      bootstrapRequired: false,
      nestedRepos: [],
      vcsMarkers: [],
      risks: [],
      errors: [errorEntry('GIT_PERMISSION', error.message)],
      warnings,
    };
  }
  const result = {
    cwd: root,
    status: 'not-git',
    code: null,
    repoRoot: null,
    parentRepo: null,
    bootstrapRequired: true,
    nestedRepos: [],
    vcsMarkers: [],
    risks: [],
    errors,
    warnings,
  };

  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (error) {
    errors.push(errorEntry('GIT_PERMISSION', `cannot access workspace ${root}: ${error.message}`));
    return { ...result, status: 'permission', code: 'GIT_PERMISSION', bootstrapRequired: false };
  }
  if (!rootStat.isDirectory()) {
    errors.push(errorEntry('GIT_PERMISSION', `workspace path is not a directory: ${root}`));
    return { ...result, status: 'permission', code: 'GIT_PERMISSION', bootstrapRequired: false };
  }

  result.risks.push(...pathRisks(root));

  try {
    if (hasGitEntry(root)) {
      return { ...result, status: 'git', repoRoot: root, bootstrapRequired: false };
    }
    // A bare repository has no `.git` entry; it is still a git repository and
    // must never receive a nested working-copy repository.
    if (looksLikeBareRepository(root)) {
      warnings.push('workspace is a bare git repository');
      return { ...result, status: 'git', repoRoot: root, bootstrapRequired: false };
    }
  } catch (error) {
    errors.push(errorEntry('GIT_PERMISSION', `cannot inspect ${root}: ${error.message}`));
    return { ...result, status: 'permission', code: 'GIT_PERMISSION', bootstrapRequired: false };
  }

  // A workspace inside a parent repository is a deliberate blocker for the
  // core: creating a nested repository would make worktree isolation ambiguous.
  // The daemon may still choose to reuse that parent repository; the core only
  // reports it.
  let parentRepo = null;
  try {
    let cursor = dirname(root);
    while (true) {
      if (hasGitEntry(cursor)) {
        parentRepo = cursor;
        break;
      }
      const next = dirname(cursor);
      if (next === cursor) break;
      cursor = next;
    }
  } catch (error) {
    errors.push(errorEntry('GIT_PERMISSION', `cannot inspect parent directories: ${error.message}`));
    return { ...result, status: 'permission', code: 'GIT_PERMISSION', bootstrapRequired: false };
  }

  const vcsMarkers = findVcsMarkers(root);
  const readOnly = !pathWritable(root);
  const gitignoreState = inspectGitignore(root, warnings);
  const nestedDepth = Number.isInteger(Number(maxNestedDepth)) && Number(maxNestedDepth) >= 0
    ? Number(maxNestedDepth)
    : 3;
  const entryLimit = Number.isInteger(Number(maxEntries)) && Number(maxEntries) > 0
    ? Number(maxEntries)
    : DEFAULT_MAX_ENTRIES;
  // Skip the nested scan when a terminal blocker already exists. The scan is
  // bounded and cheap for normal projects, but a workspace inside a huge parent
  // repository should fail fast instead of walking it.
  let truncated = false;
  const nestedRepos = parentRepo || vcsMarkers.length > 0 || readOnly
    ? []
    : findNestedRepos(root, { maxDepth: nestedDepth, maxEntries: entryLimit, warnings, onTruncated: () => { truncated = true; } });

  if (parentRepo) {
    errors.push(errorEntry('GIT_PARENT_REPO', `workspace is inside the git repository at ${parentRepo}`));
  }
  if (vcsMarkers.length > 0) {
    errors.push(errorEntry(
      'GIT_EXISTING_VCS',
      `another version-control system is present: ${vcsMarkers.map((item) => item.path).join(', ')}`,
    ));
  }
  if (nestedRepos.length > 0) {
    errors.push(errorEntry('GIT_NESTED_REPO', `nested git repositories found: ${nestedRepos.join(', ')}`));
  }
  if (readOnly) {
    errors.push(errorEntry('GIT_READ_ONLY', `workspace is not writable: ${root}`));
  } else if (gitignoreState.readOnly) {
    errors.push(errorEntry('GIT_READ_ONLY', 'the existing .gitignore is not writable'));
  }
  if (gitignoreState.symlink) {
    warnings.push('.gitignore is a symbolic link; bootstrap will refuse to rewrite it');
  }
  if (gitignoreState.notFile) {
    warnings.push('.gitignore exists but is not a regular file; bootstrap will refuse to rewrite it');
  }

  let status = 'not-git';
  let code = null;
  if (parentRepo) {
    status = 'parent-repo';
    code = 'GIT_PARENT_REPO';
  } else if (vcsMarkers.length > 0) {
    status = 'existing-vcs';
    code = 'GIT_EXISTING_VCS';
  } else if (nestedRepos.length > 0) {
    status = 'nested-repo';
    code = 'GIT_NESTED_REPO';
  } else if (readOnly || gitignoreState.readOnly) {
    status = 'read-only';
    code = 'GIT_READ_ONLY';
  }

  return {
    ...result,
    status,
    code,
    repoRoot: status === 'git' ? root : parentRepo,
    parentRepo,
    bootstrapRequired: status === 'not-git',
    nestedRepos,
    vcsMarkers,
    warnings,
    ...(truncated ? { truncated: true } : {}),
  };
}
