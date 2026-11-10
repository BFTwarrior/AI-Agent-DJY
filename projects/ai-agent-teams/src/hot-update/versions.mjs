import { join, relative, resolve } from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  MANIFEST_NAME,
  VERSIONS_RELATIVE_PATH,
  assertRelativePath,
  fail,
  isInside,
  lstatOrNull,
  readJson,
  toPosixPath,
} from './support.mjs';

/**
 * List installed versions under `runtime/versions`. This is a presence check,
 * not a digest check: `verifyPackage` is the authority and `getStatus` runs it
 * for the current version only. A broken version is still listed with its
 * error so an operator can see it and replace it.
 *
 * @param {string} pluginRoot
 * @returns {Promise<object[]>} newest `createdAt` first, then by id.
 */
export async function listInstalledVersions(pluginRoot) {
  const versionsRoot = join(pluginRoot, VERSIONS_RELATIVE_PATH);
  let entries;
  try {
    entries = await fsp.readdir(versionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const versions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.includes('.replaced-')) continue;
    const dir = join(versionsRoot, entry.name);
    try {
      const manifest = await readJson(join(dir, MANIFEST_NAME), 'HOT_UPDATE_MANIFEST_INVALID');
      const manifestEntry = assertRelativePath(manifest?.entry);
      const entryPath = resolve(dir, ...manifestEntry.split('/'));
      if (!isInside(dir, entryPath)) fail('HOT_UPDATE_MANIFEST_INVALID', 'manifest entry escapes the package');
      const stat = await lstatOrNull(entryPath);
      if (!stat || !stat.isFile()) fail('HOT_UPDATE_FILE_MISSING', `runtime entry is missing: ${manifestEntry}`);
      versions.push({
        // Presence of a parseable manifest and its entry only. A full digest
        // check is `verifyPackage`; status runs it for the current version.
        entryPresent: true,
        id: entry.name,
        dir,
        version: typeof manifest.version === 'string' ? manifest.version : entry.name,
        gitCommit: String(manifest.gitCommit ?? ''),
        shortCommit: String(manifest.shortCommit ?? String(manifest.gitCommit ?? '').slice(0, 7)),
        apiVersion: manifest.apiVersion,
        createdAt: Number.isFinite(manifest.createdAt) ? manifest.createdAt : null,
        fileCount: Number.isInteger(manifest.fileCount) ? manifest.fileCount : null,
        totalBytes: Number.isFinite(manifest.totalBytes) ? manifest.totalBytes : null,
        entry: toPosixPath(relative(pluginRoot, entryPath)),
        manifestEntry,
      });
    } catch (error) {
      versions.push({
        entryPresent: false,
        id: entry.name,
        dir,
        error: { code: error.code ?? 'HOT_UPDATE_MANIFEST_INVALID', message: error.message },
      });
    }
  }
  versions.sort((left, right) => {
    const leftTime = left.createdAt ?? 0;
    const rightTime = right.createdAt ?? 0;
    if (leftTime !== rightTime) return rightTime - leftTime;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return versions;
}

/**
 * Resolve a version spec to exactly one installed version. A spec matches a
 * package id first, then an exact version, then an id prefix; anything
 * ambiguous is an error, never a guess, because selecting the wrong package
 * would activate a runtime the operator did not ask for.
 *
 * @param {object[]} versions
 * @param {string} spec
 * @returns {object}
 */
export function matchInstalledVersion(versions, spec) {
  const query = String(spec ?? '').trim().toLowerCase();
  if (!query) fail('HOT_UPDATE_VERSION_UNKNOWN', 'a version or package id is required');
  const installed = versions.filter((version) => version.entryPresent);
  const byId = installed.filter((version) => version.id.toLowerCase() === query);
  if (byId.length === 1) return byId[0];
  const byVersion = installed.filter((version) => version.version.toLowerCase() === query);
  if (byVersion.length === 1) return byVersion[0];
  if (byVersion.length > 1) {
    fail('HOT_UPDATE_VERSION_AMBIGUOUS', `version ${spec} matches several packages: ${byVersion.map((version) => version.id).join(', ')}`);
  }
  const byPrefix = installed.filter((version) => version.id.toLowerCase().startsWith(query));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) {
    fail('HOT_UPDATE_VERSION_AMBIGUOUS', `version ${spec} matches several packages: ${byPrefix.map((version) => version.id).join(', ')}`);
  }
  fail(
    'HOT_UPDATE_VERSION_UNKNOWN',
    `no installed runtime package matches ${spec}`,
    { available: installed.map((version) => version.id) },
  );
}
