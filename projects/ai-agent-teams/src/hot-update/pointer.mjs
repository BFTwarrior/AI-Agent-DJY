import { promises as fsp } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  HOT_UPDATE_API_VERSION,
  LOCK_RETRY_CODES,
  POINTER_RELATIVE_PATH,
  SHA256_PATTERN,
  fail,
  hashFile,
  isInside,
  lstatOrNull,
  randomSuffix,
  sleep,
  withLockRetry,
} from './support.mjs';

// A reader may observe a pointer mid-write on a filesystem that does not
// guarantee rename atomicity for the observing process (network shares, some
// Windows filter drivers). Re-reading a few times distinguishes a torn write
// from a genuinely corrupt file, and re-reading is cheap.
const POINTER_READ_ATTEMPTS = 5;

/**
 * Read and parse `runtime/current.json`, tolerating a transient partial read.
 *
 * @param {string} pluginRoot
 * @returns {Promise<{ pointer: object | null, text: string | null, error: { code: string, message: string } | null, pointerPath: string }>}
 */
export async function readPointerDocument(pluginRoot) {
  const pointerPath = join(pluginRoot, POINTER_RELATIVE_PATH);
  let lastError = null;
  for (let attempt = 0; attempt < POINTER_READ_ATTEMPTS; attempt += 1) {
    let text;
    try {
      text = await fsp.readFile(pointerPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { pointer: null, text: null, error: null, pointerPath };
      if (!LOCK_RETRY_CODES.has(error.code)) {
        return {
          pointer: null,
          text: null,
          error: { code: 'HOT_UPDATE_POINTER_INVALID', message: `cannot read runtime pointer: ${error.message}` },
          pointerPath,
        };
      }
      lastError = error.message;
      await sleep(15);
      continue;
    }
    if (!text.trim()) return { pointer: null, text, error: null, pointerPath };
    try {
      return { pointer: JSON.parse(text), text, error: null, pointerPath };
    } catch (error) {
      // A non-atomic writer can expose a partial file; re-read before calling
      // the pointer corrupt.
      lastError = `runtime pointer is not valid JSON: ${error.message}`;
      await sleep(15);
    }
  }
  return {
    pointer: null,
    text: null,
    error: { code: 'HOT_UPDATE_POINTER_INVALID', message: lastError ?? 'runtime pointer is unreadable' },
    pointerPath,
  };
}

/**
 * Copy the pointer fields that may be carried forward into a new pointer.
 * Whitelisting (instead of spreading the parsed object) keeps an unknown field
 * written by a future or hostile pointer from being promoted into the active
 * pointer by a rollback.
 *
 * @param {object} pointer
 * @returns {object}
 */
export function sanitizePointer(pointer) {
  const copy = {};
  for (const key of ['version', 'entry', 'apiVersion', 'sha256', 'gitCommit', 'installedAt', 'swapId']) {
    if (pointer[key] !== undefined) copy[key] = pointer[key];
  }
  return copy;
}

/**
 * Replace the pointer atomically: write a sibling temp file, flush it, rename.
 * A reader never sees a half-written pointer, and the flush means a crash after
 * the rename cannot leave the pointer naming bytes that were never on disk.
 *
 * @param {string} pluginRoot
 * @param {object} pointer
 */
export async function writePointerAtomic(pluginRoot, pointer) {
  const pointerPath = join(pluginRoot, POINTER_RELATIVE_PATH);
  await fsp.mkdir(dirname(pointerPath), { recursive: true });
  const tempPath = join(dirname(pointerPath), `.current-${process.pid}-${randomSuffix()}.tmp`);
  const text = `${JSON.stringify(pointer, null, 2)}\n`;
  await withLockRetry(() => fsp.writeFile(tempPath, text, { mode: 0o644 }), 'write runtime pointer');
  try {
    const handle = await fsp.open(tempPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // fsync is best-effort; the rename below is what makes the switch atomic.
  }
  try {
    await withLockRetry(() => fsp.rename(tempPath, pointerPath), 'publish runtime pointer');
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    fail('HOT_UPDATE_POINTER_WRITE_FAILED', `failed to publish ${pointerPath}: ${error.message}`);
  }
}

/**
 * Validate that a pointer can be executed by the shell: entry inside the
 * plugin root, a regular file, a supported apiVersion and a matching sha256.
 * Mirrors the checks in `src/mcp/shell.mjs` so status/rollback report the same
 * verdict the shell would reach.
 *
 * @param {string} pluginRoot
 * @param {object} pointer
 * @returns {Promise<{ valid: boolean, error: object | null, entryPath?: string, sha256?: string }>}
 */
export async function validatePointerTarget(pluginRoot, pointer) {
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) {
    return { valid: false, error: { code: 'HOT_UPDATE_POINTER_INVALID', message: 'runtime pointer must be a JSON object' } };
  }
  if (typeof pointer.entry !== 'string' || !pointer.entry.trim()) {
    return { valid: false, error: { code: 'HOT_UPDATE_POINTER_INVALID', message: 'runtime pointer must contain a non-empty "entry"' } };
  }
  if (pointer.apiVersion !== HOT_UPDATE_API_VERSION) {
    return {
      valid: false,
      error: {
        code: 'HOT_UPDATE_UNSUPPORTED_API',
        message: `runtime pointer apiVersion ${String(pointer.apiVersion)} is not ${HOT_UPDATE_API_VERSION}`,
      },
    };
  }
  const entryPath = resolve(pluginRoot, pointer.entry);
  if (!isInside(pluginRoot, entryPath)) {
    return {
      valid: false,
      error: { code: 'HOT_UPDATE_POINTER_INVALID', message: `runtime entry escapes the plugin directory: ${pointer.entry}` },
    };
  }
  const stat = await lstatOrNull(entryPath);
  if (!stat || !stat.isFile()) {
    return {
      valid: false,
      error: { code: 'HOT_UPDATE_FILE_MISSING', message: `runtime entry does not exist: ${entryPath}` },
    };
  }
  // lstat only protects the last segment; a symlinked parent could still
  // resolve outside the plugin directory, exactly like the shell's check.
  const realRoot = await fsp.realpath(pluginRoot).catch(() => pluginRoot);
  const realEntry = await fsp.realpath(entryPath).catch(() => null);
  if (!realEntry || !isInside(realRoot, realEntry)) {
    return {
      valid: false,
      error: { code: 'HOT_UPDATE_POINTER_INVALID', message: `runtime entry resolves outside the plugin directory: ${pointer.entry}` },
    };
  }
  const sha256 = String(pointer.sha256 ?? '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    return {
      valid: false,
      error: { code: 'HOT_UPDATE_POINTER_INVALID', message: 'runtime pointer must contain a 64-character hex "sha256"' },
    };
  }
  const actual = await hashFile(realEntry);
  if (actual !== sha256) {
    return {
      valid: false,
      error: {
        code: 'HOT_UPDATE_DIGEST_MISMATCH',
        message: `runtime entry sha256 mismatch for ${entryPath} (expected ${sha256}, got ${actual})`,
      },
    };
  }
  return { valid: true, entryPath, sha256, error: null };
}
