import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { sleep } from './support.mjs';

export const RUNTIME_API_VERSION = 1;
export const DEFAULT_RUNTIME_ENTRY = 'src/mcp/runtime-entry.mjs';
const LOCK_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUNTIME_COPY_PREFIX = '.runtime-';

function hashBytes(data) {
  return createHash('sha256').update(data).digest('hex');
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function sha256File(path) {
  const data = await fsp.readFile(path);
  return hashBytes(data);
}

async function withLockRetry(operation, label) {
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
  throw new Error(`${label} failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

// Resolves and verifies pointer targets. It owns no process or protocol state.
export class RuntimeTargets {
  constructor({ pluginRoot, pointerPath, packageVersion, log }) {
    this.pluginRoot = pluginRoot;
    this.pointerPath = pointerPath;
    this.packageVersion = packageVersion;
    this.log = log;
  }

  async readPointerDocument() {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let text;
      try {
        text = await fsp.readFile(this.pointerPath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return { text: null, pointer: null };
        if (!LOCK_RETRY_CODES.has(error.code)) throw error;
        lastError = error;
        await sleep(15);
        continue;
      }
      if (!text.trim()) return { text, pointer: null };
      try {
        return { text, pointer: JSON.parse(text) };
      } catch (error) {
        // A non-atomic writer can let us observe a partial file; re-read.
        lastError = new Error(`runtime pointer is not valid JSON: ${error.message}`);
        await sleep(15);
      }
    }
    throw lastError ?? new Error('runtime pointer is unreadable');
  }

  fallbackTarget() {
    const entry = resolve(this.pluginRoot, DEFAULT_RUNTIME_ENTRY);
    return {
      source: 'fallback',
      version: this.packageVersion,
      entry,
      originalEntry: entry,
      sha256: null,
      apiVersion: RUNTIME_API_VERSION,
      key: `fallback:${entry}:${this.packageVersion}`,
    };
  }

  async materializeRuntime(entry, sha256) {
    const target = join(dirname(entry), `${RUNTIME_COPY_PREFIX}${sha256}.mjs`);
    const existing = await fsp.readFile(target).catch(() => null);
    if (existing && hashBytes(existing) === sha256) return target;
    const source = await withLockRetry(() => fsp.readFile(entry), 'read runtime entry');
    const actual = hashBytes(source);
    if (actual !== sha256) {
      // The file changed between validation and copy: never spawn bytes that
      // were not covered by the pointer digest.
      throw new Error(`runtime entry changed after validation: ${entry} (expected ${sha256}, got ${actual})`);
    }
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await withLockRetry(() => fsp.writeFile(temp, source, { mode: 0o600 }), 'write runtime copy');
    const copied = await fsp.readFile(temp).catch(() => null);
    if (!copied || hashBytes(copied) !== sha256) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw new Error(`runtime copy verification failed for ${entry}`);
    }
    try {
      await withLockRetry(() => fsp.rename(temp, target), 'publish runtime copy');
    } catch {
      // Windows cannot always rename over an existing file; drop the stale
      // copy and publish once more.
      await fsp.rm(target, { force: true }).catch(() => {});
      try {
        await withLockRetry(() => fsp.rename(temp, target), 'publish runtime copy');
      } catch (retryError) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw retryError;
      }
    }
    const published = await fsp.readFile(target).catch(() => null);
    if (!published || hashBytes(published) !== sha256) {
      throw new Error(`runtime copy at ${target} does not match sha256 ${sha256}`);
    }
    this.log(`materialized runtime ${sha256.slice(0, 12)}... at ${target}`);
    return target;
  }

  async resolveRuntimeTarget() {
    const { pointer } = await this.readPointerDocument();
    if (!pointer) return this.fallbackTarget();
    if (typeof pointer !== 'object' || Array.isArray(pointer)) {
      throw new Error('runtime pointer must be a JSON object');
    }
    if (typeof pointer.entry !== 'string' || !pointer.entry.trim()) {
      throw new Error('runtime pointer must contain a non-empty "entry"');
    }
    if (pointer.apiVersion !== RUNTIME_API_VERSION) {
      throw new Error(`unsupported runtime apiVersion: ${pointer.apiVersion ?? 'missing'}`);
    }
    const entry = resolve(this.pluginRoot, pointer.entry);
    if (!isInside(this.pluginRoot, entry)) {
      throw new Error(`runtime entry escapes the plugin directory: ${pointer.entry}`);
    }
    const stat = await fsp.lstat(entry).catch(() => null);
    if (!stat) throw new Error(`runtime entry does not exist: ${entry}`);
    if (!stat.isFile()) throw new Error(`runtime entry must be a regular file (symlinks are not allowed): ${entry}`);
    const sha256 = typeof pointer.sha256 === 'string' ? pointer.sha256.trim().toLowerCase() : '';
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error('runtime pointer must contain a 64-character hex "sha256"');
    }
    // lstat only protects the last path segment; resolve the whole path so a
    // symlinked parent directory cannot point the runtime outside the plugin.
    const realRoot = await fsp.realpath(this.pluginRoot).catch(() => this.pluginRoot);
    const realEntry = await fsp.realpath(entry).catch(() => null);
    if (!realEntry || !isInside(realRoot, realEntry)) {
      throw new Error(`runtime entry resolves outside the plugin directory: ${pointer.entry}`);
    }
    const actual = await sha256File(realEntry);
    if (actual !== sha256) {
      throw new Error(`runtime entry sha256 mismatch for ${entry} (expected ${sha256}, got ${actual})`);
    }
    const spawnEntry = await this.materializeRuntime(realEntry, sha256);
    const version = typeof pointer.version === 'string' && pointer.version.trim()
      ? pointer.version.trim()
      : this.packageVersion;
    return {
      source: 'pointer',
      version,
      entry: spawnEntry,
      originalEntry: realEntry,
      sha256,
      apiVersion: pointer.apiVersion,
      key: `pointer:${realEntry}:${sha256}:${version}`,
    };
  }
}
