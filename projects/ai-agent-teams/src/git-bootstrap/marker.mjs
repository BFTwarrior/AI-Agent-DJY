// The bootstrap marker: `.git/agent-teams-bootstrap.json`.
//
// The marker is the record a later run (and any other tool) reads to answer
// "did this module bootstrap this repository, and what exactly did it commit".
// Because of that it is written last, after the commit exists, and a failure to
// write it degrades to a warning with `markerWritten: false` — the commit is
// already the source of truth and must not be abandoned for a missing report.
//
// Reading is intentionally total: a corrupt, truncated or foreign file yields
// `null` rather than an exception, so a damaged marker makes the next run treat
// the workspace as an ordinary existing repository instead of failing.
//
// The ignored list is capped at `MARKER_IGNORED_LIMIT` entries before it is
// handed in. A truncated list is flagged, never silently shortened, because the
// marker is read by humans diagnosing an unexpected baseline.

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { GIT_BOOTSTRAP_MARKER } from './contract.mjs';

/**
 * Write the marker and return its absolute path.
 *
 * The write is not atomic on purpose: the file lives inside `.git`, which this
 * module just created, and nothing else reads it until this process returns.
 */
export function writeBootstrapMarker(gitDir, payload) {
  const path = join(gitDir, GIT_BOOTSTRAP_MARKER);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
}

export function readBootstrapMarker(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, '.git', GIT_BOOTSTRAP_MARKER), 'utf8'));
    if (!value || typeof value !== 'object' || typeof value.commit !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Sum the current on-disk size of committed files.
 *
 * Used for the marker's `totalBytes` so it reflects what the commit actually
 * references. A file removed between add and report is skipped: the commit is
 * already the source of truth, so a missing path is not an error here.
 */
export function totalSize(root, files) {
  let total = 0;
  for (const file of files) {
    try {
      total += statSync(join(root, file)).size;
    } catch {
      // The file may have been removed between add and report.
    }
  }
  return total;
}
