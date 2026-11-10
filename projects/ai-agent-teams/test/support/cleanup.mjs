import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

/**
 * Scratch-space redirection lives in `tmp-root.mjs`, which `npm test` preloads
 * before any test file (or this module) is imported.
 *
 * This module deliberately does NOT set TMP/TEMP/TMPDIR. It used to, and that
 * defeated the per-run isolation there: `tmp-root.mjs` points TMP at a
 * `run-<pid>-<ts>` subdirectory so leftovers die with the process, and then this
 * block overwrote TMP back to the bare shared root. The result was that setting
 * `AGENT_TEAMS_TEST_TMP` -- the documented CI usage -- silently reintroduced the
 * accumulation the per-run directory exists to prevent.
 *
 * If you run a single test file directly (`node --test test/foo.test.mjs`) the
 * preload is absent and the OS temp dir is used; that is intentional, so a
 * one-off file run behaves like stock Node.
 */

/**
 * Remove a directory tree, retrying briefly on Windows `EPERM`/`EBUSY`.
 *
 * A test that just drove a merge can still have a git child process (or the
 * filesystem filter driver) holding a handle on the checkout for a few
 * milliseconds. `rmSync` then fails with `EPERM` even though nothing is wrong
 * with the test. Retrying with a short backoff makes the cleanup deterministic
 * without hiding a genuine failure: after the last attempt the error is thrown.
 *
 * @param {string} path
 * @param {{ attempts?: number, delayMs?: number }} [options]
 */
export function removeTreeWithRetry(path, { attempts = 8, delayMs = 25 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: delayMs });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
      const until = Date.now() + delayMs * (attempt + 1);
      while (Date.now() < until) { /* busy-wait a few milliseconds */ }
    }
  }
  throw lastError;
}

/**
 * Root for every temporary directory a test creates.
 *
 * `tmpdir()` already reflects the redirection that `tmp-root.mjs` performed at
 * preload time, including the per-run `run-<pid>-<ts>` subdirectory. Reading
 * `AGENT_TEAMS_TEST_TMP` directly here would skip that subdirectory and drop the
 * directories straight into the shared root, where nothing deletes them.
 *
 * @returns {string}
 */
export function testTmpRoot() {
  return tmpdir();
}

/**
 * Create a temporary directory under {@link testTmpRoot}. The caller owns it and
 * must remove it (usually via {@link removeTreeWithRetry}).
 *
 * @param {string} prefix
 * @returns {string}
 */
export function makeTestTmpDir(prefix) {
  const root = testTmpRoot();
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}

let memberHomeRoot;
export function testHomeRoot() {
  memberHomeRoot ??= makeTestTmpDir('agent-teams-test-homes-');
  return memberHomeRoot;
}
after(() => {
  if (memberHomeRoot) removeTreeWithRetry(memberHomeRoot);
});
