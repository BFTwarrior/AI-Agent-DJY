import { promises as fsp } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { RUNTIME_DIR, fail, randomSuffix, sleep } from './support.mjs';

const LOCK_FILE_NAME = '.hot-update.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
// A local lock is reclaimed immediately when its pid is dead; this age limit
// only covers locks owned by another host (or a reused pid) and is deliberately
// much longer than a build/install on this repository.
const DEFAULT_LOCK_STALE_MS = 600000;

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === 'EPERM';
  }
}

async function isRuntimeLockStale(lockPath, staleMs) {
  let stat;
  let info = null;
  try {
    stat = await fsp.stat(lockPath);
    try { info = JSON.parse(await fsp.readFile(lockPath, 'utf8')); } catch { info = null; }
  } catch (error) {
    return error.code === 'ENOENT';
  }
  if (info && Number.isFinite(info.createdAt) && Date.now() - info.createdAt > staleMs) return true;
  if (info && info.hostname === hostname() && Number.isInteger(info.pid)) {
    return !isPidAlive(info.pid);
  }
  return Date.now() - stat.mtimeMs > staleMs;
}

// A release only removes the file when the token still matches: a caller whose
// lock was reclaimed as stale must not delete the new owner's lock.
async function releaseRuntimeLock(lockPath, token) {
  try {
    const info = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
    if (info?.token === token) await fsp.rm(lockPath, { force: true });
  } catch {
    // The lock is already gone; nothing to release.
  }
}

/**
 * Cross-process lock for pointer read-modify-write cycles and for version
 * directory maintenance. The lock is a create-only file with the owner's pid,
 * host and a random token; a stale lock (older than `staleMs`, or owned by a
 * dead process on this host) is reclaimed. Release only removes the lock when
 * the token still matches, so a late release cannot delete a newer owner's
 * lock.
 *
 * @param {string} pluginRoot
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 */
export async function acquireRuntimeLock(pluginRoot, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(options.staleMs) && options.staleMs > 0
    ? options.staleMs
    : DEFAULT_LOCK_STALE_MS;
  const lockPath = join(pluginRoot, RUNTIME_DIR, LOCK_FILE_NAME);
  await fsp.mkdir(dirname(lockPath), { recursive: true });
  const token = randomSuffix();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, hostname: hostname(), createdAt: Date.now() }));
        try { await handle.sync(); } catch { /* best effort */ }
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        token,
        release: async () => { await releaseRuntimeLock(lockPath, token); },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        fail('HOT_UPDATE_IO_FAILED', `cannot create runtime lock ${lockPath}: ${error.message}`);
      }
      if (await isRuntimeLockStale(lockPath, staleMs)) {
        // Reclaiming by rename is atomic: if two waiters both saw the same
        // stale lock, only one rename succeeds and the other loops to observe
        // the winner's fresh lock instead of deleting it.
        const stalePath = `${lockPath}.stale-${randomSuffix()}`;
        try {
          await fsp.rename(lockPath, stalePath);
          await fsp.rm(stalePath, { force: true }).catch(() => {});
        } catch (reclaimError) {
          if (reclaimError.code !== 'ENOENT') {
            fail('HOT_UPDATE_IO_FAILED', `cannot reclaim stale lock ${lockPath}: ${reclaimError.message}`);
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        fail('HOT_UPDATE_LOCK_TIMEOUT', `timed out after ${timeoutMs}ms waiting for ${lockPath}`, { lockPath });
      }
      await sleep(20);
    }
  }
}
