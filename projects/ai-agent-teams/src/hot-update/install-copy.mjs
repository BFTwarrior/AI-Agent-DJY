import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MANIFEST_NAME,
  fail,
  hashFile,
  posixDirname,
  readDirOrEmpty,
  withLockRetry,
} from './support.mjs';

// The stable shell writes its own sibling copy of the entry next to it as
// `.runtime-<sha256>.mjs`, so a running shell never executes a file that a
// publish may replace under it.
const RUNTIME_COPY_PREFIX = '.runtime-';
const EXTRA_FILE_WARNING_LIMIT = 20;

/**
 * Copy a verified external package into the versions directory. Only the files
 * named in the manifest (plus `manifest.json`) are copied: an extra file in a
 * draft — `config/local.json`, `*.bak`, `node_modules/**` — can never leak into
 * the runtime tree. The stable shell's own `.runtime-<sha256>.mjs` sibling copy
 * is preserved when its digest matches the entry.
 *
 * @param {{ sourceDir: string, verified: object, staging: string, warnings: string[], syncFile: (path: string) => Promise<void> }} options
 */
export async function copyVerifiedPackage({ sourceDir, verified, staging, warnings, syncFile }) {
  for (const file of verified.files) {
    const target = join(staging, ...file.path.split('/'));
    await fsp.mkdir(dirname(target), { recursive: true });
    await withLockRetry(() => fsp.copyFile(file.absolutePath, target), `copy ${file.path}`);
    await flushCopiedFile(target, syncFile);
  }
  const manifestTarget = join(staging, MANIFEST_NAME);
  await withLockRetry(() => fsp.copyFile(join(sourceDir, MANIFEST_NAME), manifestTarget), `copy ${MANIFEST_NAME}`);
  await flushCopiedFile(manifestTarget, syncFile);
  const entryDirRel = posixDirname(verified.manifest.entry);
  const entryDirAbs = join(sourceDir, ...entryDirRel.split('/').filter(Boolean));
  for (const entry of await readDirOrEmpty(entryDirAbs)) {
    if (!entry.isFile() || !entry.name.startsWith(RUNTIME_COPY_PREFIX) || !entry.name.endsWith('.mjs')) continue;
    const relPath = entryDirRel ? `${entryDirRel}/${entry.name}` : entry.name;
    const expected = `${RUNTIME_COPY_PREFIX}${verified.entrySha256}.mjs`;
    if (entry.name !== expected) {
      warnings.push(`skipped shell copy with an unexpected digest: ${relPath}`);
      continue;
    }
    // The name claims a digest; the bytes must match it. The shell would
    // overwrite a poisoned copy anyway, but a package that ships one is not the
    // package its name promises, so it never enters the versions tree.
    const sourceCopy = join(sourceDir, ...relPath.split('/'));
    const actual = await hashFile(sourceCopy);
    if (actual !== verified.entrySha256) {
      warnings.push(
        `skipped shell copy whose bytes do not match its digest: ${relPath} (expected ${verified.entrySha256}, got ${actual})`,
      );
      continue;
    }
    const target = join(staging, ...relPath.split('/'));
    await fsp.mkdir(dirname(target), { recursive: true });
    await withLockRetry(() => fsp.copyFile(sourceCopy, target), `copy ${relPath}`);
    await flushCopiedFile(target, syncFile);
  }
}

// A copied file keeps the source's mode, and an external package unpacked
// read-only (0444) would then refuse the write handle used to flush it. The
// staging copy is made owner-writable first so a read-only source can still be
// installed and still be flushed.
async function flushCopiedFile(target, syncFile) {
  try {
    await fsp.chmod(target, 0o644);
  } catch (error) {
    fail('HOT_UPDATE_IO_FAILED', `cannot make the staged copy writable: ${target}: ${error.message}`);
  }
  await syncFile(target);
}

/**
 * Warn about draft files the manifest does not name. They are never copied, so
 * this is purely informational — but silence would make a package that carries
 * `config/local.json` look clean.
 *
 * @param {{ sourceDir: string, verified: object, warnings: string[] }} options
 */
export async function warnAboutUncopiedFiles({ sourceDir, verified, warnings }) {
  const listed = new Set(verified.files.map((file) => file.path));
  listed.add(MANIFEST_NAME);
  const entryDirRel = posixDirname(verified.manifest.entry);
  const shellCopy = `${RUNTIME_COPY_PREFIX}${verified.entrySha256}.mjs`;
  listed.add(entryDirRel ? `${entryDirRel}/${shellCopy}` : shellCopy);
  const { files, truncated } = await listDraftFiles(sourceDir);
  const extras = [];
  for (const file of files) {
    if (listed.has(file.path)) continue;
    extras.push(file.symlink ? `${file.path} (symlink)` : file.path);
  }
  if (extras.length > 0) {
    const shown = extras.slice(0, EXTRA_FILE_WARNING_LIMIT);
    warnings.push(
      `package contains ${extras.length} file(s) not listed in ${MANIFEST_NAME}; they were not copied: `
      + `${shown.join(', ')}${extras.length > shown.length ? `, ... and ${extras.length - shown.length} more` : ''}`,
    );
  }
  if (truncated) {
    warnings.push('package file scan stopped after 20000 entries; the extra-file warning may be incomplete');
  }
}

// Walk a package draft without following symlinks or applying name-based
// exclusions. The manifest decides what is installed; this walk only feeds the
// "files that were not copied" warning.
async function listDraftFiles(sourceDir) {
  const files = [];
  const pending = [''];
  let truncated = false;
  while (pending.length > 0) {
    const relDir = pending.pop();
    const absoluteDir = join(sourceDir, ...relDir.split('/').filter(Boolean));
    let entries;
    try {
      entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        files.push({ path: relPath, symlink: true });
      } else if (entry.isDirectory()) {
        pending.push(relPath);
      } else if (entry.isFile()) {
        files.push({ path: relPath, symlink: false });
      }
      if (files.length >= 20000) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  return { files, truncated };
}
