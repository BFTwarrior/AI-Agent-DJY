// Undoing a partial bootstrap.
//
// A failure after `git init` must not leave a repository this module created but
// never finished, and must not leave a `.gitignore` it rewrote. Rollback is
// therefore the inverse of the mutation phase, and its scope is deliberately
// narrow:
//
// - `.git` is removed only when `initRepository` returned `created: true` for
//   this exact call. The flag is passed in and never re-derived from the
//   filesystem, because a concurrent process may have created `.git` after our
//   init failed, and deleting that would destroy someone else's repository.
// - `.gitignore` is restored only when this call wrote it, from the content and
//   mode captured under the lock. If it did not exist before, it is removed.
//
// Both operations are best-effort and report what happened. A failed restore
// does not replace the original error the caller is about to report; it shows up
// as `gitRemoved: false` / `gitignoreRestored: false` so the residue is visible
// instead of implied to be clean.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeGitignoreAtomically } from './gitignore.mjs';

/**
 * Reverse a partial bootstrap.
 *
 * @param {{
 *   root: string,
 *   gitCreated: boolean,
 *   gitignoreWritten: boolean,
 *   originalGitignore?: { exists: boolean, content: string, mode?: number }
 * }} input
 * @returns {{ gitRemoved: boolean, gitignoreRestored: boolean }}
 */
export function rollbackBootstrap({ root, gitCreated, gitignoreWritten, originalGitignore }) {
  const result = { gitRemoved: false, gitignoreRestored: false };
  if (gitignoreWritten && originalGitignore) {
    try {
      if (originalGitignore.exists) {
        writeGitignoreAtomically(root, originalGitignore.content, originalGitignore.mode);
      } else {
        rmSync(join(root, '.gitignore'), { force: true });
      }
      result.gitignoreRestored = true;
    } catch {
      // The caller still gets the original failure and can report the residue.
    }
  }
  // Only a repository created by this exact call may be removed. The caller
  // passes initRepository()'s value; never probe the filesystem here, because a
  // concurrent process may have created `.git` in the meantime.
  if (gitCreated === true) {
    try {
      rmSync(join(root, '.git'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      result.gitRemoved = !existsSync(join(root, '.git'));
    } catch {
      result.gitRemoved = false;
    }
  }
  return result;
}
