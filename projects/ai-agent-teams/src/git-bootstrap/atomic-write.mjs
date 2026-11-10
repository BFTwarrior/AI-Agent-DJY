// Atomic file replacement.
//
// `.gitignore` belongs to the user, so a crash or a permission error in the
// middle of rewriting it must never leave a truncated file behind: the original
// content either survives as a whole, or the new content replaces it as a
// whole. The sequence is write-sibling-temp, copy permission bits, rename.
//
// The temporary file is created with `wx` so two concurrent writers cannot
// share one scratch path, and it is placed in the caller-provided directory —
// inside the state directory — for two reasons: the rename must stay on one
// filesystem to be atomic, and the scratch file must already be covered by the
// ignore rules so a crash cannot get it committed.
//
// A failure unlinks the temporary file on a best-effort basis; a failure to
// unlink is not allowed to replace the original error, because the original
// error is what the caller reports.

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * Write `content` to `path` through a sibling temporary file and an atomic
 * rename. The rename target keeps the caller-provided mode, so rewriting
 * `.gitignore` does not change its permissions.
 */
export function writeFileAtomic(path, content, { mode, tempDir } = {}) {
  const directory = tempDir ?? dirname(path);
  mkdirSync(directory, { recursive: true });
  const temp = join(directory, `ai-agent-teams-write-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx', mode: mode ?? 0o644 });
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temporary file may not exist or may already have been renamed.
    }
    throw error;
  }
}
