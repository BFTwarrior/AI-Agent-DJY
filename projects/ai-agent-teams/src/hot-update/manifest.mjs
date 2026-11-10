import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import {
  COMMIT_PATTERN,
  HOT_UPDATE_API_VERSION,
  MANIFEST_NAME,
  MANIFEST_SCHEMA_VERSION,
  SHA256_PATTERN,
  assertRelativePath,
  fail,
  hashFile,
  isInside,
  lstatOrNull,
  readJson,
  validateVersion,
} from './support.mjs';

/**
 * The only directory a publish may land in: a direct child of the versions
 * directory. A slug derived from unvalidated manifest fields could otherwise
 * resolve to `runtime/versions/../../src` and overwrite the plugin's own source
 * tree, so every publish path asserts this before touching the filesystem.
 *
 * @param {string} versionsRoot
 * @param {string} target
 * @returns {string} the resolved target
 */
export function assertPublishTargetInside(versionsRoot, target) {
  const root = resolve(versionsRoot);
  const resolved = resolve(target);
  const rel = relative(root, resolved);
  // Exactly one path segment below `root`. The explicit separator checks are
  // what make this hold on Windows, where `relative()` reports `a\b` for a
  // nested target and a POSIX-only test would let it through.
  const singleSegment = rel !== ''
    && rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
    && !rel.includes('/')
    && !rel.includes('\\');
  if (!singleSegment) {
    fail(
      'HOT_UPDATE_PACKAGE_INVALID',
      `refusing to publish outside the versions directory ${root}: ${resolved}`,
    );
  }
  return resolved;
}

// The directory name is built from verified manifest fields only: `version`
// matches `VERSION_PATTERN` and `shortCommit` is hex after `verifyPackage`, so
// a slug can never carry a path separator or a `..` segment.
export function versionSlug(manifest) {
  return `${manifest.version}-${String(manifest.shortCommit ?? '').toLowerCase()}`;
}

/**
 * Verify a package directory against its manifest: every listed file must
 * exist, be a regular file, and match the recorded sha256 and size.
 *
 * @param {string} packageDir
 * @param {{ apiVersion?: number }} [options]
 * @returns {Promise<{ dir: string, manifest: object, files: object[], entryPath: string, entrySha256: string, shortCommit: string }>}
 */
export async function verifyPackage(packageDir, options = {}) {
  const dir = resolve(packageDir);
  const expectedApiVersion = options.apiVersion ?? HOT_UPDATE_API_VERSION;
  const manifest = await readJson(join(dir, MANIFEST_NAME), 'HOT_UPDATE_MANIFEST_INVALID');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('HOT_UPDATE_MANIFEST_INVALID', `${MANIFEST_NAME} must contain a JSON object`);
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail('HOT_UPDATE_MANIFEST_INVALID', `unsupported manifest schemaVersion: ${String(manifest.schemaVersion)}`);
  }
  validateVersion(manifest.version);
  const gitCommit = String(manifest.gitCommit ?? '').toLowerCase();
  if (!COMMIT_PATTERN.test(gitCommit)) {
    fail('HOT_UPDATE_MANIFEST_INVALID', `manifest gitCommit must be 7-40 hex characters: ${String(manifest.gitCommit)}`);
  }
  // `shortCommit` becomes the version directory name (`<version>-<shortsha>`),
  // so it is never taken on trust: missing, separators or a value that does not
  // prefix `gitCommit` would let a crafted package install as
  // `9.9.9-undefined` or name a directory outside the versions tree.
  const shortCommit = String(manifest.shortCommit ?? '').toLowerCase();
  if (!COMMIT_PATTERN.test(shortCommit)) {
    fail(
      'HOT_UPDATE_MANIFEST_INVALID',
      `manifest shortCommit must be 7-40 hex characters: ${String(manifest.shortCommit)}`,
    );
  }
  if (!gitCommit.startsWith(shortCommit)) {
    fail(
      'HOT_UPDATE_MANIFEST_INVALID',
      `manifest shortCommit ${shortCommit} is not a prefix of gitCommit ${gitCommit}`,
    );
  }
  if (!Number.isFinite(manifest.createdAt)) {
    fail('HOT_UPDATE_MANIFEST_INVALID', 'manifest createdAt must be an epoch-ms number');
  }
  if (manifest.apiVersion !== expectedApiVersion) {
    fail(
      'HOT_UPDATE_UNSUPPORTED_API',
      `package apiVersion ${String(manifest.apiVersion)} is not compatible with runtime apiVersion ${expectedApiVersion}`,
    );
  }
  const entry = assertRelativePath(manifest.entry);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail('HOT_UPDATE_MANIFEST_INVALID', 'manifest files must be a non-empty array');
  }
  const seen = new Set();
  const files = [];
  for (const record of manifest.files) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      fail('HOT_UPDATE_MANIFEST_INVALID', 'manifest file entries must be objects');
    }
    const path = assertRelativePath(record.path);
    if (seen.has(path)) fail('HOT_UPDATE_MANIFEST_INVALID', `duplicate manifest file entry: ${path}`);
    seen.add(path);
    const sha256 = String(record.sha256 ?? '').toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) {
      fail('HOT_UPDATE_MANIFEST_INVALID', `manifest sha256 for ${path} is not 64 hex characters`);
    }
    if (!Number.isInteger(record.size) || record.size < 0) {
      fail('HOT_UPDATE_MANIFEST_INVALID', `manifest size for ${path} must be a non-negative integer`);
    }
    const absolutePath = resolve(dir, ...path.split('/'));
    if (!isInside(dir, absolutePath)) fail('HOT_UPDATE_MANIFEST_INVALID', `package path escapes the package: ${path}`);
    const stat = await lstatOrNull(absolutePath);
    if (!stat || !stat.isFile()) fail('HOT_UPDATE_FILE_MISSING', `package file is missing: ${path}`);
    if (stat.size !== record.size) {
      fail('HOT_UPDATE_DIGEST_MISMATCH', `size mismatch for ${path}: manifest ${record.size}, file ${stat.size}`);
    }
    const actual = await hashFile(absolutePath);
    if (actual !== sha256) {
      fail('HOT_UPDATE_DIGEST_MISMATCH', `sha256 mismatch for ${path}: manifest ${sha256}, file ${actual}`);
    }
    files.push({ path, sha256, size: record.size, absolutePath });
  }
  if (manifest.fileCount !== undefined && manifest.fileCount !== files.length) {
    fail('HOT_UPDATE_MANIFEST_INVALID', `manifest fileCount ${manifest.fileCount} does not match ${files.length} entries`);
  }
  const entryRecord = files.find((file) => file.path === entry);
  if (!entryRecord) fail('HOT_UPDATE_MANIFEST_INVALID', `manifest entry is not listed in files: ${entry}`);
  return {
    dir,
    manifest,
    files,
    entryPath: entryRecord.absolutePath,
    entrySha256: entryRecord.sha256,
    // Normalized to lowercase so callers derive the same slug the directory has.
    shortCommit,
  };
}
