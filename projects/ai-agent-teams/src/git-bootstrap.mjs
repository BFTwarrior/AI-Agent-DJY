// Safe git bootstrap for a workspace that is not a git repository yet.
//
// This file is the public entry point and stays deliberately thin: the
// implementation lives in `src/git-bootstrap/`, split by concern, and this
// facade is the compatibility surface the tests and any future caller import
// from. It must keep exporting the same names with the same meaning and must not
// grow its own logic.
//
// The module is a pure core: it does not know about the daemon, the installer,
// team config, or feature flags. Callers decide *when* to run it; this package
// decides *whether* it is safe and performs only the mechanical steps (init,
// ignore rules, explicit `git add`, first commit, marker).
//
// Safety rules that must not regress:
// - Never `git add -A`; only the files returned by planBootstrap are added.
// - Never commit dependencies, build output, secrets, symlinks, or large files.
// - Never initialize a repository inside another repository or next to a
//   different version-control system.
// - Never delete a `.git` directory that this process did not create.
// - A rerun on a repository bootstrapped by this module is a no-op.
//
// Modules:
//   contract.mjs      frozen names, limits, ignore rules, error codes, git env deny-list
//   errors.mjs        GitBootstrapError, code normalization, failure result shape
//   fs-primitives.mjs path identity, workspace resolution, comparisons, risk reporting
//   inspect.mjs       the read-only pre-flight gate
//   patterns.mjs      include/exclude pattern compilation
//   secret-scan.mjs   secret names plus the bounded content scan
//   atomic-write.mjs  temp-file + rename replacement
//   gitignore.mjs     managed `.gitignore` block read/rewrite
//   plan.mjs          the file list every later phase is restricted to
//   git-command.mjs   sanitized-environment git runner, version parsing
//   repository.mjs    init, local config, explicit staging, verification, commit
//   lock.mjs          cross-process bootstrap lock
//   marker.mjs        `.git/agent-teams-bootstrap.json` read/write
//   rollback.mjs      undo only what this call created
//   bootstrap.mjs     the transaction that ties the phases together
export {
  GIT_BOOTSTRAP_VERSION,
  GIT_BOOTSTRAP_MARKER,
  GIT_BOOTSTRAP_LOCK,
  BOOTSTRAP_STATE_DIR,
  DEFAULT_AUTHOR_NAME,
  DEFAULT_AUTHOR_EMAIL,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  HARD_MAX_FILE_BYTES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_SECRET_SCAN_BYTES,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STALE_LOCK_MS,
  LONG_PATH_THRESHOLD,
  COMMIT_MESSAGE,
  GITIGNORE_START,
  GITIGNORE_END,
  GIT_BOOTSTRAP_ERROR_CODES,
  IGNORED_DIRECTORIES,
  GITIGNORE_RULES,
} from './git-bootstrap/contract.mjs';
export { GitBootstrapError } from './git-bootstrap/errors.mjs';
export { inspectProject } from './git-bootstrap/inspect.mjs';
export { planBootstrap } from './git-bootstrap/plan.mjs';
export { runGit } from './git-bootstrap/git-command.mjs';
export { bootstrapGit } from './git-bootstrap/bootstrap.mjs';

// Internal hooks for tests and diagnostics. Not part of the supported public
// API; the daemon and installer only use the three exported entry points above.
import {
  buildGitEnv as buildGitEnvForTesting,
  parseGitVersion as parseGitVersionForTesting,
  runGit as runGitForTesting,
  supportsInitialBranch as supportsInitialBranchForTesting,
} from './git-bootstrap/git-command.mjs';
import { pathRisks as pathRisksForTesting } from './git-bootstrap/fs-primitives.mjs';
import { writeFileAtomic as writeFileAtomicForTesting } from './git-bootstrap/atomic-write.mjs';
import {
  acquireBootstrapLock as acquireBootstrapLockForTesting,
  releaseBootstrapLock as releaseBootstrapLockForTesting,
} from './git-bootstrap/lock.mjs';
import { rollbackBootstrap as rollbackBootstrapForTesting } from './git-bootstrap/rollback.mjs';
import {
  addFiles as addFilesForTesting,
  initRepository as initRepositoryForTesting,
  verifyStagedEntries as verifyStagedEntriesForTesting,
} from './git-bootstrap/repository.mjs';

export const __testing = Object.freeze({
  runGit: runGitForTesting,
  rollbackBootstrap: rollbackBootstrapForTesting,
  initRepository: initRepositoryForTesting,
  addFiles: addFilesForTesting,
  verifyStagedEntries: verifyStagedEntriesForTesting,
  acquireBootstrapLock: acquireBootstrapLockForTesting,
  releaseBootstrapLock: releaseBootstrapLockForTesting,
  parseGitVersion: parseGitVersionForTesting,
  supportsInitialBranch: supportsInitialBranchForTesting,
  pathRisks: pathRisksForTesting,
  buildGitEnv: buildGitEnvForTesting,
  writeFileAtomic: writeFileAtomicForTesting,
});
