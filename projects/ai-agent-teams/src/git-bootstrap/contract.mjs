// Frozen policy for the git bootstrap core: names, limits, ignore rules and the
// stable error codes.
//
// Everything here is observable contract. The marker schema, the managed
// `.gitignore` block markers and the limit defaults are read back by other
// tools, so changing a value is a compatibility change, not tuning. Per-call
// options may lower a limit, but `HARD_MAX_FILE_BYTES` is the ceiling no caller
// can raise; that asymmetry is what keeps a workspace with one multi-gigabyte
// file from being committed by a widened option.

export const GIT_BOOTSTRAP_VERSION = 2;
export const GIT_BOOTSTRAP_MARKER = 'agent-teams-bootstrap.json';
export const GIT_BOOTSTRAP_LOCK = 'git-bootstrap.lock';
export const BOOTSTRAP_STATE_DIR = '.ai-agent-teams';
export const DEFAULT_AUTHOR_NAME = 'Agent Teams';
export const DEFAULT_AUTHOR_EMAIL = 'agent-teams@localhost';
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const HARD_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 200000;
export const DEFAULT_SECRET_SCAN_BYTES = 8 * 1024;
export const DEFAULT_LOCK_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;
export const LONG_PATH_THRESHOLD = 240;
export const COMMIT_MESSAGE = 'chore: baseline before Ai-Agent-Teams collaboration';
export const GITIGNORE_START = '# >>> ai-agent-teams bootstrap >>>';
export const GITIGNORE_END = '# <<< ai-agent-teams bootstrap <<<';

// GIT_REQUIRED means the git executable cannot be run. A workspace that merely
// lacks a repository is reported by inspectProject as status 'not-git' with
// bootstrapRequired: true; that is a normal pre-bootstrap state, not an error.
export const GIT_BOOTSTRAP_ERROR_CODES = Object.freeze([
  'GIT_REQUIRED',
  'GIT_PARENT_REPO',
  'GIT_NESTED_REPO',
  'GIT_EXISTING_VCS',
  'GIT_READ_ONLY',
  'GIT_SECRETS_FOUND',
  'GIT_TOO_LARGE',
  'GIT_PERMISSION',
  'GIT_BOOTSTRAP_FAILED',
]);

/**
 * A directory name that is never walked or committed. The list is the union of
 * the bootstrap design document, the usual caches produced by Node, Rust, Java,
 * Python, and Next.js projects, and the daemon state directory.
 */
export const IGNORED_DIRECTORIES = Object.freeze([
  '.git',
  '.hg',
  '.svn',
  '.ai-agent-teams',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  'bin',
  'obj',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  '.next',
  'coverage',
  '.cache',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '历史',
  '归档',
]);

export const GITIGNORE_RULES = Object.freeze([
  '# Dependencies and build output',
  'node_modules/',
  'dist/',
  'build/',
  'target/',
  'out/',
  'bin/',
  'obj/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.gradle/',
  '.next/',
  'coverage/',
  '.cache/',
  '历史/',
  '归档/',
  '',
  '# Team daemon state and lock files',
  '.ai-agent-teams/',
  '',
  '# Secrets and local credentials',
  '.env*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.jks',
  'id_rsa*',
  'credentials*',
  '.netrc',
  '.npmrc',
  '.pypirc',
]);

// Checkouts of another version-control system must not silently gain a git
// repository next to them: two index formats in one tree make "what changed"
// and worktree isolation ambiguous. The list is the marker each tool leaves at
// the root of the checkout it owns.
export const VCS_MARKERS = Object.freeze(['.hg', '.svn', '.p4config', 'p4config.txt', '.p4ignore']);

// Scan budgets. They exist so an adversarial or merely huge workspace cannot
// turn planning into an unbounded read; every truncation is reported instead of
// silently narrowing the baseline.
export const ADD_BATCH_FILES = 200;
export const ADD_BATCH_BYTES = 6000;
export const MAX_CONTENT_SCAN_FILES = 20000;
export const MAX_CONTENT_SCAN_BYTES = 128 * 1024 * 1024;
export const MAX_LINE_COUNT_FILES = 5000;
export const MAX_LINE_COUNT_BYTES = 64 * 1024 * 1024;
export const MAX_LINE_COUNT_FILE_BYTES = 8 * 1024 * 1024;
export const MARKER_IGNORED_LIMIT = 200;
export const LOCK_POLL_MS = 50;

// Git commands inherit the caller's environment, which may contain variables
// that redirect the repository, the index, or the configuration files. They are
// stripped so a bootstrap can never operate on a different repository.
export const GIT_ENV_DENY = Object.freeze(new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_TERMINAL_PROMPT',
]));
