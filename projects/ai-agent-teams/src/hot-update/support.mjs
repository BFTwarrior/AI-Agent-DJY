import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import { RUNTIME_API_VERSION } from '../mcp/shell.mjs';

// Shared foundation for the hot-update modules: the on-disk contract, the
// stable error type and the filesystem primitives every other module uses.
//
// The layout names below are a contract with two independent readers that must
// not be changed here alone: `src/mcp/shell.mjs` watches `runtime/current.json`,
// and packages already installed on disk keep their `runtime/versions/<id>/`
// shape and `manifest.json` schema. Keeping them in one module is what stops a
// second, subtly different copy from appearing next to the pointer writer.
export const HOT_UPDATE_API_VERSION = RUNTIME_API_VERSION;
export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_RUNTIME_ENTRY = 'src/mcp/runtime-entry.mjs';
export const POINTER_RELATIVE_PATH = 'runtime/current.json';
export const VERSIONS_RELATIVE_PATH = 'runtime/versions';
export const RUNTIME_DIR = 'runtime';

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
export const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
// Windows refuses these codes while another handle (a virus scanner, an indexer,
// a concurrent reader) briefly owns the file; they are retried, everything else
// is a real failure.
export const LOCK_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN']);

/**
 * Stable, machine-readable failure for every hot-update operation. Callers
 * (the CLI and the tests) switch on `code`, never on the message text.
 */
export class HotUpdateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HotUpdateError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new HotUpdateError(code, message, details);
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function randomSuffix() {
  return randomBytes(4).toString('hex');
}

export function hashBytes(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function hashFile(path) {
  return hashBytes(await fsp.readFile(path));
}

// Published package content must survive a crash right after the pointer
// switches. Without an fsync the renames can reach the disk while the file
// bytes are still in the page cache, so a power loss leaves a pointer that
// names files whose content was never written.
//
// The function is injectable (`options.syncFile`) so tests can prove that every
// staged file and the manifest were flushed; production always uses this one.
export async function defaultSyncFile(path) {
  let handle;
  try {
    handle = await fsp.open(path, 'r+');
  } catch (error) {
    fail('HOT_UPDATE_IO_FAILED', `cannot open ${path} to flush it to disk: ${error.message}`);
  }
  try {
    await handle.sync();
  } catch (error) {
    fail('HOT_UPDATE_IO_FAILED', `cannot flush ${path} to disk: ${error.message}`);
  } finally {
    await handle.close().catch(() => {});
  }
}

export function resolveSyncFile(candidate) {
  return typeof candidate === 'function' ? candidate : defaultSyncFile;
}

export function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function toPosixPath(path) {
  return path.split('\\').join('/');
}

// Resolve a POSIX package path without touching the filesystem. Returns null
// when the path escapes the package root; the caller treats that as a broken
// import (it cannot resolve inside the package either way).
export function normalizePosixPath(path) {
  const parts = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

export function posixDirname(path) {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

export async function lstatOrNull(path) {
  try {
    return await fsp.lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readDirOrEmpty(path) {
  try {
    return await fsp.readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// Transient sharing violations are not lock contention: this wrapper only
// absorbs the OS-level retryable codes so a caller can treat the operation as
// atomic. Cross-process exclusion is `acquireRuntimeLock`, not this helper.
export async function withLockRetry(operation, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!LOCK_RETRY_CODES.has(error?.code)) throw error;
      lastError = error;
      await sleep(15 + attempt * 5);
    }
  }
  fail('HOT_UPDATE_IO_FAILED', `${label} failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

// Manifest paths are POSIX and relative to the package root. Reject anything
// that could escape the package (absolute paths, drive letters, `..`, or a
// stray backslash that would split differently on Windows).
export function assertRelativePath(value, code = 'HOT_UPDATE_MANIFEST_INVALID') {
  if (typeof value !== 'string' || value.length === 0) fail(code, 'package path must be a non-empty string');
  if (value.includes('\\')) fail(code, `package path must use POSIX separators: ${value}`);
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail(code, `package path must be relative: ${value}`);
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(code, `package path must not contain empty, "." or ".." segments: ${value}`);
  }
  return value;
}

export function validateVersion(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    fail('HOT_UPDATE_INVALID_VERSION', `invalid package version: ${String(version)}`);
  }
  return version;
}

export function normalizeCommit(commit) {
  const value = String(commit ?? '').toLowerCase();
  if (!COMMIT_PATTERN.test(value)) {
    fail('HOT_UPDATE_INVALID_COMMIT', `git commit must be 7-40 hex characters: ${String(commit)}`);
  }
  return value;
}

export async function readJson(path, code) {
  let text;
  try {
    text = await fsp.readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && code === 'HOT_UPDATE_MANIFEST_INVALID') {
      fail('HOT_UPDATE_MANIFEST_MISSING', `package is missing ${MANIFEST_NAME}: ${dirname(path)}`);
    }
    fail(code, `cannot read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(code, `cannot parse ${path}: ${error.message}`);
  }
}
