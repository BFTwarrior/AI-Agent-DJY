import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  RUNTIME_DIR,
  SHA256_PATTERN,
  VERSIONS_RELATIVE_PATH,
  defaultSyncFile,
  fail,
  hashFile,
  isInside,
  lstatOrNull,
  randomSuffix,
  readDirOrEmpty,
  sleep,
  withLockRetry,
} from './support.mjs';
import { assertPublishTargetInside, verifyPackage } from './manifest.mjs';
import { readPointerDocument } from './pointer.mjs';

const RECOVERY_JOURNAL_PREFIX = 'recovery-';
const RECOVERY_JOURNAL_VERSION = 1;
// Only staging -> target gets this Windows workaround. EPERM can also mean a
// permanent denial, so it is a candidate, not proof of a sharing violation.
const PUBLISH_RETRY_CODES = new Set(['EPERM', 'EBUSY']);
const PUBLISH_RENAME_ATTEMPTS = 5;
const PUBLISH_RENAME_BUDGET_MS = 1000;

async function directoryIdentity(path) {
  const stat = await fsp.lstat(path, { bigint: true });
  return stat.isDirectory() && stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : null;
}

async function assertTargetMissing(target) {
  if (await lstatOrNull(target)) {
    fail('HOT_UPDATE_VERSION_EXISTS', `runtime target appeared during publish: ${target}`);
  }
}

async function renameStaging(staging, target) {
  const deadline = performance.now() + PUBLISH_RENAME_BUDGET_MS;
  let lastError;
  for (let attempt = 0; ; attempt += 1) {
    // The runtime lock excludes cooperating writers. Never intentionally replace
    // a target introduced by an outside writer, including an empty directory.
    await assertTargetMissing(target);
    if (attempt > 0 && performance.now() >= deadline) throw lastError;
    try {
      await fsp.rename(staging, target);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !PUBLISH_RETRY_CODES.has(error?.code)
        || attempt + 1 >= PUBLISH_RENAME_ATTEMPTS) throw error;
      lastError = error;
      const delay = 25 * (attempt + 1);
      if (performance.now() + delay >= deadline) throw error;
      await sleep(delay);
      if (performance.now() >= deadline) throw error;
    }
  }
}

// 64 random bits: the swap id is the only proof that a pointer write belongs to
// a specific replace, so a per-mille collision is not an acceptable risk.
function randomSwapId() {
  return randomBytes(8).toString('hex');
}

async function writeJsonDurable(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await withLockRetry(() => fsp.writeFile(path, text, { mode: 0o600 }), `write ${path}`);
  // A recovery point that is still in the page cache is not a recovery point.
  await defaultSyncFile(path);
}

/**
 * True when `runtime/current.json` proves it was written for this swap: the
 * pointer carries the journal's `swapId`, its `entry` resolves inside `target`
 * and the recorded sha256 still matches that file.
 *
 * A journal normally means the replace never committed, because `commit()`
 * deletes the journal before the backup. The exception is a process that died
 * after the pointer was rewritten but before `commit()` ran: the pointer then
 * names the new bytes, and restoring the old backup would leave a pointer whose
 * sha256 no longer matches the file the shell spawns.
 *
 * The pointer digest alone is not enough: a forced re-install of the *same*
 * version id whose entry file did not change produces a pointer that matches the
 * new tree as well, so a crash before `writePointerAtomic` would bless a tree
 * that never passed its health check. The `swapId` is written by
 * `publishStaged` into the journal and, only after the pointer switch, into the
 * pointer, so the pointer can prove which swap it committed.
 */
async function pointerCommitsSwap(pluginRoot, target, swapId) {
  if (typeof swapId !== 'string' || !swapId) return false;
  const doc = await readPointerDocument(pluginRoot);
  const pointer = doc.pointer;
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) return false;
  if (pointer.swapId !== swapId) return false;
  const sha256 = String(pointer.sha256 ?? '').toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) return false;
  if (typeof pointer.entry !== 'string' || !pointer.entry.trim()) return false;
  const entryPath = resolve(pluginRoot, pointer.entry);
  if (!isInside(target, entryPath)) return false;
  try {
    return await hashFile(entryPath) === sha256;
  } catch {
    return false;
  }
}

async function packageVerifies(dir) {
  try {
    await verifyPackage(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finish or undo a replace swap.
 *
 * `mode: 'journal'` means a recovery point survived a crash. The journal alone
 * is not proof that the swap never committed: a crash between `writePointerAtomic`
 * and `commit()` leaves a live journal next to an already committed pointer. In
 * that case the pointer (matching `swapId`, plus a verifying package) wins and
 * the backup is discarded; otherwise the old bytes at `backup` win even if the
 * newly published target happens to verify.
 *
 * `mode: 'orphan'` is a `<target>.replaced-*` directory with no journal: keep
 * the target when it is a valid package, otherwise put the backup back.
 */
async function resolveReplaceSwap({ pluginRoot, target, backup, swapId, stagedIdentity, actions, errors, mode }) {
  const targetExists = await lstatOrNull(target);
  const backupExists = await lstatOrNull(backup);
  if (!backupExists) {
    if (!targetExists) errors.push(`recovery point ${backup} is missing and ${target} does not exist`);
    return;
  }
  if (!targetExists) {
    await fsp.rename(backup, target);
    actions.push({ action: 'restored', target, backup });
    return;
  }
  if (mode === 'journal') {
    const committed = await pointerCommitsSwap(pluginRoot, target, swapId);
    if (committed && await packageVerifies(target)) {
      await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
      actions.push({ action: 'discarded-backup', target, backup, reason: 'pointer-committed' });
      return;
    }
    // New journals bind the staging directory's filesystem identity. If a
    // failed publish found an unrelated target, recovery must not delete it.
    // Legacy journals retain their existing recovery semantics.
    if (stagedIdentity !== undefined && (typeof stagedIdentity !== 'string'
      || stagedIdentity !== await directoryIdentity(target))) {
      errors.push(`recovery target changed; keeping ${target}, ${backup} and its journal`);
      return false;
    }
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    await fsp.rename(backup, target);
    actions.push({ action: 'restored-previous', target, backup });
    return;
  }
  if (await packageVerifies(target)) {
    await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
    actions.push({ action: 'discarded-backup', target, backup });
    return;
  }
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  await fsp.rename(backup, target);
  actions.push({ action: 'restored-previous', target, backup });
}

/**
 * Recover from a process that died between the two renames of a forced
 * publish, and remove throwaway staging directories. Journals are written by
 * `publishStaged` before the old version is moved aside. Callers normally hold
 * the runtime lock for the whole operation that created a journal or staging
 * directory, so anything visible under the lock is a crash leftover;
 * `minAgeMs` is an optional conservative guard for callers that cannot lock.
 *
 * @param {string} pluginRoot
 * @param {{ now?: number, minAgeMs?: number }} [options]
 * @returns {Promise<{ actions: object[], errors: string[] }>}
 */
export async function recoverRuntimeState(pluginRoot, options = {}) {
  const runtimeDir = join(pluginRoot, RUNTIME_DIR);
  const versionsRoot = join(pluginRoot, VERSIONS_RELATIVE_PATH);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const minAgeMs = Number.isFinite(options.minAgeMs) && options.minAgeMs > 0 ? options.minAgeMs : 0;
  const oldestAllowed = now - minAgeMs;
  const actions = [];
  const errors = [];
  const referencedTargets = new Set();

  for (const entry of await readDirOrEmpty(runtimeDir)) {
    if (!entry.isFile() || !entry.name.startsWith(RECOVERY_JOURNAL_PREFIX) || !entry.name.endsWith('.json')) continue;
    const journalPath = join(runtimeDir, entry.name);
    let journal = null;
    try {
      journal = JSON.parse(await fsp.readFile(journalPath, 'utf8'));
    } catch (error) {
      errors.push(`cannot read recovery journal ${journalPath}: ${error.message}`);
      await fsp.rm(journalPath, { force: true }).catch(() => {});
      continue;
    }
    const journalCreated = Number.isFinite(journal?.createdAt) ? journal.createdAt : 0;
    if (journalCreated > oldestAllowed) continue;
    const target = typeof journal?.target === 'string' ? resolve(journal.target) : null;
    const backup = typeof journal?.backup === 'string' ? resolve(journal.backup) : null;
    // Journals written before `swapId` existed name no swap, so recovery treats
    // them as uncommitted — the conservative reading, and the one that keeps the
    // pointer/entry mismatch out of the way.
    const swapId = typeof journal?.swapId === 'string' && journal.swapId ? journal.swapId : null;
    if (
      journal?.schemaVersion !== RECOVERY_JOURNAL_VERSION
      || !target || !backup
      || !isInside(versionsRoot, target)
      || !isInside(versionsRoot, backup)
      || !backup.startsWith(`${target}.replaced-`)
    ) {
      errors.push(`ignoring an invalid recovery journal: ${journalPath}`);
      await fsp.rm(journalPath, { force: true }).catch(() => {});
      continue;
    }
    referencedTargets.add(target);
    const recovered = await resolveReplaceSwap({
      pluginRoot, target, backup, swapId, stagedIdentity: journal.stagedIdentity, actions, errors, mode: 'journal',
    });
    if (recovered !== false) await fsp.rm(journalPath, { force: true }).catch(() => {});
  }

  for (const entry of await readDirOrEmpty(versionsRoot)) {
    const name = entry.name;
    if (name.startsWith('.')) {
      if (name.startsWith('.staging-') || name.startsWith('.install-')) {
        const dirPath = join(versionsRoot, name);
        const stat = await fsp.stat(dirPath).catch(() => null);
        if (!stat || stat.mtimeMs <= oldestAllowed) {
          await fsp.rm(dirPath, { recursive: true, force: true }).catch(() => {});
          actions.push({ action: 'removed-temp', path: dirPath });
        }
      }
      continue;
    }
    const replaced = /^(.+)\.replaced-[0-9a-f]{8}$/.exec(name);
    if (!replaced) continue;
    const target = join(versionsRoot, replaced[1]);
    const backup = join(versionsRoot, name);
    if (referencedTargets.has(target)) continue;
    const stat = await fsp.stat(backup).catch(() => null);
    if (!stat || stat.mtimeMs > oldestAllowed) continue;
    await resolveReplaceSwap({ pluginRoot, target, backup, actions, errors, mode: 'orphan' });
  }

  return { actions, errors };
}

/**
 * Undo a publish after a later step failed. Failures are reported, never
 * swallowed: a half-restored version directory would otherwise look like a
 * successful rollback. The journal is deliberately left in place when the
 * restore fails, so the next `recoverRuntimeState` can finish the swap.
 */
async function restorePrevious({ target, backup, dropJournal, published = true }) {
  // A rejected staging rename did not create target. Removing that path would
  // destroy an outside writer's directory, not undo this publish.
  if (!published && await lstatOrNull(target)) {
    fail('HOT_UPDATE_UNDO_FAILED', `refusing to restore over a changed runtime target: ${target}`, { target, backup });
  }
  const problems = [];
  if (published) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
    } catch (error) {
      problems.push(`cannot remove the published runtime ${target}: ${error.message}`);
    }
  }
  try {
    await fsp.rename(backup, target);
  } catch (error) {
    problems.push(`cannot restore the previous runtime ${backup}: ${error.message}`);
  }
  if (problems.length > 0) {
    fail('HOT_UPDATE_UNDO_FAILED', `failed to roll back ${target}: ${problems.join('; ')}`, { target, backup });
  }
  const journalResult = await dropJournal();
  return journalResult === true ? { warnings: [] } : { warnings: [`${journalResult}; recovery will retry`] };
}

// No previous directory was touched, so undo only has to remove the copy that
// was just published — and say so loudly when even that fails.
async function removePublished({ target }) {
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch (error) {
    fail('HOT_UPDATE_UNDO_FAILED', `failed to remove the newly published runtime ${target}: ${error.message}`, { target });
  }
  return { warnings: [] };
}

/**
 * Publish a fully written staging directory at `target`. The rename is the
 * atomic step; `force` keeps the previous directory alive only until the
 * caller commits, so a failed health check can put the old bytes back. Before
 * the previous directory is moved aside, a recovery journal records the swap;
 * `recoverRuntimeState` can then finish or undo the swap after a crash.
 *
 * `target` must be a direct child of `versionsRoot`; anything else is rejected
 * before the filesystem is touched.
 *
 * @param {{
 *   staging: string, target: string, pluginRoot: string, versionsRoot?: string, force?: boolean,
 * }} options
 * @returns {Promise<{
 *   target: string, swapId: string, created: boolean,
 *   commit: () => Promise<{ warnings: string[] }>,
 *   undo: () => Promise<{ warnings: string[] }>,
 * }>}
 */
export async function publishStaged({ staging, target, pluginRoot, versionsRoot, force = false }) {
  const root = resolve(versionsRoot ?? join(pluginRoot, VERSIONS_RELATIVE_PATH));
  const resolvedTarget = assertPublishTargetInside(root, target);
  // The swap id is the proof that a later pointer write belongs to this publish.
  // It is recorded in the journal first and only reaches the pointer when the
  // caller commits, so recovery can tell "switched" from "published but never
  // activated" even when both trees look identical to the pointer digest.
  const swapId = randomSwapId();
  const existing = await lstatOrNull(resolvedTarget);
  if (!existing) {
    await renameStaging(staging, resolvedTarget);
    return {
      target: resolvedTarget,
      swapId,
      created: true,
      commit: async () => ({ warnings: [] }),
      undo: async () => removePublished({ target: resolvedTarget }),
    };
  }
  if (!force) {
    fail('HOT_UPDATE_VERSION_EXISTS', `runtime version already exists: ${resolvedTarget} (pass --force to replace it)`);
  }
  if (!existing.isDirectory()) {
    fail('HOT_UPDATE_BUILD_FAILED', `refusing to replace a non-directory runtime version: ${resolvedTarget}`);
  }
  const backup = `${resolvedTarget}.replaced-${randomSuffix()}`;
  let journalPath = null;
  if (isInside(join(resolve(pluginRoot), VERSIONS_RELATIVE_PATH), resolvedTarget)) {
    journalPath = join(pluginRoot, RUNTIME_DIR, `${RECOVERY_JOURNAL_PREFIX}${randomSuffix()}.json`);
    await writeJsonDurable(journalPath, {
      schemaVersion: RECOVERY_JOURNAL_VERSION,
      target: resolvedTarget,
      backup,
      swapId,
      staging,
      stagedIdentity: await directoryIdentity(staging),
      createdAt: Date.now(),
    });
  }
  // Returns true on success, or a message describing why the journal is still
  // there (a live journal is safe now that recovery checks the pointer first).
  const dropJournal = async () => {
    if (!journalPath) return true;
    try {
      await fsp.rm(journalPath, { force: true });
      return true;
    } catch (error) {
      return `cannot delete the recovery journal ${journalPath}: ${error.message}`;
    }
  };
  await fsp.rename(resolvedTarget, backup);
  try {
    await renameStaging(staging, resolvedTarget);
  } catch (error) {
    // Put the old directory back — and say so when even that fails, instead of
    // leaving the version directory missing with no explanation. `fail()` builds
    // a new error, so the undo failure has to travel in its `details`.
    let detail = '';
    const details = {};
    try {
      const restored = await restorePrevious({ target: resolvedTarget, backup, dropJournal, published: false });
      for (const warning of restored?.warnings ?? []) detail += `; ${warning}`;
    } catch (undoError) {
      detail += `; restoring the previous runtime also failed: ${undoError.message}`;
      details.undoError = { code: undoError?.code ?? null, message: undoError.message };
    }
    fail('HOT_UPDATE_BUILD_FAILED', `failed to publish ${resolvedTarget}: ${error.message}${detail}`, details);
  }
  return {
    target: resolvedTarget,
    swapId,
    created: true,
    // The journal goes first. A crash between the two deletes then leaves an
    // orphan `.replaced-*` backup, which recovery discards once the target
    // verifies — instead of a live journal whose backup would roll the freshly
    // installed version back.
    commit: async () => {
      const warnings = [];
      const journalResult = await dropJournal();
      if (journalResult !== true) {
        // Keep the backup: recovery needs the pair to finish or undo the swap.
        warnings.push(`${journalResult}; ${backup} is kept so recovery can finish or undo the swap`);
        return { warnings };
      }
      try {
        await fsp.rm(backup, { recursive: true, force: true });
      } catch (error) {
        warnings.push(`cannot remove the replaced runtime ${backup}: ${error.message}; recovery will discard it`);
      }
      return { warnings };
    },
    undo: async () => restorePrevious({ target: resolvedTarget, backup, dropJournal }),
  };
}
