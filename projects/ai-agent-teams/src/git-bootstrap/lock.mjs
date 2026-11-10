// Cross-process bootstrap lock.
//
// Two bootstraps racing in one workspace would both see "no repository", both
// init, and one would win the commit while the other rolled back over it. The
// lock removes that window: it is created with `wx` (O_EXCL), so exactly one
// contender can create it, and the loser waits and then re-inspects under the
// lock instead of trusting its earlier read.
//
// Ownership is proven by a random token inside the file. Release reads the file
// back and unlinks only if the token is still there, so a holder whose lock was
// reclaimed as stale cannot delete the new holder's lock.
//
// A stale lock (older than `staleMs`) is reclaimed with a warning: a crash must
// not block the workspace forever. Reclaiming is a tolerant operation — if
// another waiter unlinks it first, the loop simply continues — because the only
// requirement is that the directory eventually contains a live owner's lock or
// none at all.

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BOOTSTRAP_STATE_DIR, GIT_BOOTSTRAP_LOCK, LOCK_POLL_MS } from './contract.mjs';
import { GitBootstrapError } from './errors.mjs';
import { bootstrapStateDirectory } from './fs-primitives.mjs';

function sleep(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

/**
 * Acquire `.ai-agent-teams/git-bootstrap.lock` with O_EXCL. A lock older than
 * `staleMs` is reclaimed; a live lock is waited on until `waitMs`.
 *
 * @returns {Promise<{ path: string, token: string }>}
 */
export async function acquireBootstrapLock(root, { waitMs, staleMs, warnings }) {
  const directory = bootstrapStateDirectory(root);
  const path = join(directory, GIT_BOOTSTRAP_LOCK);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new GitBootstrapError(
      error.code === 'EACCES' || error.code === 'EPERM' ? 'GIT_PERMISSION' : 'GIT_BOOTSTRAP_FAILED',
      `cannot create ${BOOTSTRAP_STATE_DIR}: ${error.message}`,
    );
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = randomBytes(12).toString('hex');
    try {
      const fd = openSync(path, 'wx');
      try {
        const payload = `${JSON.stringify({
          version: 1,
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
          cwd: root,
        })}\n`;
        writeFileSync(fd, payload, 'utf8');
      } finally {
        closeSync(fd);
      }
      return { path, token };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new GitBootstrapError(
          error.code === 'EACCES' || error.code === 'EPERM' ? 'GIT_PERMISSION' : 'GIT_BOOTSTRAP_FAILED',
          `cannot create bootstrap lock ${path}: ${error.message}`,
        );
      }
    }
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new GitBootstrapError(
        error.code === 'EACCES' || error.code === 'EPERM' ? 'GIT_PERMISSION' : 'GIT_BOOTSTRAP_FAILED',
        `cannot inspect bootstrap lock ${path}: ${error.message}`,
      );
    }
    if (Date.now() - stat.mtimeMs > staleMs) {
      warnings.push(`reclaimed a stale bootstrap lock older than ${staleMs} ms`);
      try {
        unlinkSync(path);
        continue;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        // Another waiter may have reclaimed it first; fall through and wait.
      }
    }
    if (Date.now() >= deadline) {
      throw new GitBootstrapError(
        'GIT_BOOTSTRAP_FAILED',
        `timed out after ${waitMs} ms waiting for ${path}`,
      );
    }
    await sleep(LOCK_POLL_MS);
  }
}

/**
 * Release the lock only when this call still owns it.
 *
 * A failure to read or unlink is swallowed deliberately: the lock is either
 * already released or will be reclaimed as stale, and reporting it here would
 * replace the caller's real error with a cleanup error.
 */
export function releaseBootstrapLock(lock) {
  if (!lock) return;
  try {
    const content = readFileSync(lock.path, 'utf8');
    if (content.includes(lock.token)) unlinkSync(lock.path);
  } catch {
    // A missing lock or a lock owned by another process is left alone.
  }
}
