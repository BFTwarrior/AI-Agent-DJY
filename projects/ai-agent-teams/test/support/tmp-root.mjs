/**
 * Preloaded by `npm test` via `--import`. Keep temporary files in the checkout's
 * dated .tmp directory by default, on every platform. An explicit
 * AGENT_TEAMS_TEST_TMP still supports either an inside or outside location.
 *
 * A Git ceiling at the temporary root stops bare fixtures from discovering the
 * enclosing checkout (and accidentally starting a daemon). Repositories that
 * a test explicitly initializes below that ceiling still work normally.
 */
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.AGENT_TEAMS_TEST_TMP
  || join(repoRoot, '.tmp', `${new Date().toISOString().slice(0, 10)}-tests`);

{
  const resolvedRoot = resolve(root);
  mkdirSync(resolvedRoot, { recursive: true });
  // Preserve inherited ceilings, including Git's empty-entry semantics. Include
  // the physical path too so a checkout reached through a symlink stays fenced.
  const ceilings = process.env.GIT_CEILING_DIRECTORIES?.split(delimiter) ?? [];
  for (const path of [resolvedRoot, realpathSync.native(resolvedRoot)]) {
    // Git skips canonicalization after an inherited empty entry. Use its path
    // separators explicitly so those entries also work with Git for Windows.
    const ceiling = process.platform === 'win32' ? path.replace(/\\/g, '/') : path;
    if (!ceilings.includes(ceiling)) ceilings.push(ceiling);
  }
  process.env.GIT_CEILING_DIRECTORIES = ceilings.join(delimiter);

  // Give THIS test process its own directory under the shared root, and delete
  // it on exit. Many call sites use `mkdtempSync(join(tmpdir(), ...))` and never
  // remove the result; pointing tmpdir at a per-run directory means their
  // leftovers die with the run instead of accumulating (one full suite left ~84
  // directories, ~425 KB, every time).
  //
  // Only the per-run directory is removed, never the shared root: other runs and
  // the user's own shell may be using it.
  const runRoot = join(resolvedRoot, `run-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(runRoot, { recursive: true });
  process.env.TMP = runRoot;
  process.env.TEMP = runRoot;
  process.env.TMPDIR = runRoot;

  // `exit` handlers run last, but a test that started a detached child can still
  // be writing into runRoot when the handler fires, and on Windows a directory
  // recreated a moment later survives. Retry with a growing backoff, then give up
  // silently: a leftover empty directory must never fail the run.
  //
  // Measured: with a short window, `node --test`'s parallel workers sometimes
  // exit while a child still holds a handle, and 5 of them were left behind on
  // one run out of three. Longer backoff cleared it.
  const cleanup = () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        return;
      } catch {
        const until = Date.now() + 150 * (attempt + 1);
        while (Date.now() < until) { /* let the writer close its handle */ }
      }
    }
  };
  process.on('exit', cleanup);
}
