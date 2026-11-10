// Reading and rewriting the workspace `.gitignore`.
//
// The bootstrap adds its rules as a managed block between two marker comments
// and never touches text outside it. That makes the operation idempotent (a
// second run replaces the block instead of appending a second copy) and lets a
// user opt out by deleting the block.
//
// Refusals live here rather than in the caller because they are all about the
// file itself: a symlink would make an "atomic replace" write through to a
// target outside the workspace, and a non-regular file cannot be replaced
// without destroying it. Both are hard failures, not warnings.

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GITIGNORE_END, GITIGNORE_RULES, GITIGNORE_START } from './contract.mjs';
import { GitBootstrapError } from './errors.mjs';
import { bootstrapStateDirectory } from './fs-primitives.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

/**
 * Read the existing `.gitignore`, or report that there is none.
 *
 * `ENOENT`/`ENOTDIR` are the normal "no file yet" answers; anything else is a
 * permission failure worth its own code, because the bootstrap cannot proceed
 * without knowing whether it would destroy user content.
 */
export function readGitignore(root) {
  const path = join(root, '.gitignore');
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { exists: false, content: '' };
    throw new GitBootstrapError('GIT_PERMISSION', `cannot inspect .gitignore: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', '.gitignore is a symbolic link; refusing to overwrite its target');
  }
  if (!stat.isFile()) {
    throw new GitBootstrapError('GIT_BOOTSTRAP_FAILED', '.gitignore is not a regular file');
  }
  try {
    return { exists: true, content: readFileSync(path, 'utf8'), mode: stat.mode & 0o777 };
  } catch (error) {
    throw new GitBootstrapError(
      error.code === 'EACCES' || error.code === 'EPERM' ? 'GIT_PERMISSION' : 'GIT_BOOTSTRAP_FAILED',
      `cannot read .gitignore: ${error.message}`,
    );
  }
}

/**
 * Replace the managed block, preserving everything outside it.
 *
 * The line ending matches the file when one already exists, so a CRLF
 * `.gitignore` does not gain mixed endings. When the file has no managed block
 * the rules are appended after a blank line, keeping the user's own rules and
 * their grouping intact.
 */
export function upsertGitignoreBlock(existing) {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const block = [GITIGNORE_START, ...GITIGNORE_RULES, GITIGNORE_END].join(eol);
  const start = existing.indexOf(GITIGNORE_START);
  const end = existing.indexOf(GITIGNORE_END);
  if (start !== -1 && end > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + GITIGNORE_END.length)}`;
  }
  if (existing === '') return `${block}${eol}`;
  const prefix = existing.endsWith(eol) ? existing : `${existing}${eol}`;
  return `${prefix}${eol}${block}${eol}`;
}

/**
 * Write `.gitignore` atomically, using the state directory for the scratch file.
 *
 * The scratch directory is created on demand: rollback can run after a failure
 * that happened before the lock was taken, so it cannot assume the directory
 * exists.
 */
export function writeGitignoreAtomically(root, content, mode) {
  return writeFileAtomic(join(root, '.gitignore'), content, {
    mode,
    tempDir: bootstrapStateDirectory(root),
  });
}
