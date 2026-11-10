// Error type, code normalization and the shared failure result shape.
//
// Two rules make the bootstrap reportable without parsing prose:
// - a thrown failure carries a code from `GIT_BOOTSTRAP_ERROR_CODES`, so a
//   caller can branch on it and tests can assert it;
// - every non-throwing failure path returns `failureResult`, so `ok`, `code`,
//   `status`, `repoRoot` and `rolledBack` keep the same meaning whether the
//   failure came from planning, a git command, or the rollback itself.
//
// `bootstrapErrorCode` keeps an explicit code and otherwise maps the usual
// filesystem/git text to the closest stable code. The text fallbacks exist only
// for errors raised by git or by the OS; internal failures always set a code.

import { GIT_BOOTSTRAP_ERROR_CODES } from './contract.mjs';

export class GitBootstrapError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitBootstrapError';
    this.code = code;
    for (const [key, value] of Object.entries(details)) {
      if (key !== 'code' && value !== undefined) this[key] = value;
    }
  }
}

export function isBootstrapErrorCode(code) {
  return typeof code === 'string' && GIT_BOOTSTRAP_ERROR_CODES.includes(code);
}

export function errorEntry(code, message, extra = {}) {
  return { code, message, ...extra };
}

export function bootstrapErrorCode(error) {
  if (error instanceof GitBootstrapError && isBootstrapErrorCode(error.code)) return error.code;
  const text = `${error?.message ?? ''} ${error?.stderr ?? ''}`;
  if (/read-only file system/iu.test(text)) return 'GIT_READ_ONLY';
  if (/\bEACCES\b|\bEPERM\b|permission denied/iu.test(text)) return 'GIT_PERMISSION';
  if (/\bENOSPC\b|no space left/iu.test(text)) return 'GIT_TOO_LARGE';
  return 'GIT_BOOTSTRAP_FAILED';
}

/**
 * Build the single failure shape used by `bootstrapGit`.
 *
 * `rolledBack` is only attached when the caller actually attempted a rollback,
 * so "did this process undo anything" stays answerable from the result alone.
 */
export function failureResult({
  code,
  message,
  errors,
  warnings = [],
  status = 'failed',
  repoRoot = null,
  parentRepo = null,
  risks = [],
  contentSecrets = [],
  truncated = false,
  dryRun = false,
  rolledBack,
}) {
  const normalized = Array.isArray(errors) && errors.length > 0
    ? errors
    : [errorEntry(code, message)];
  return {
    ok: false,
    code,
    message,
    status,
    repoRoot,
    parentRepo,
    dryRun,
    errors: normalized,
    warnings,
    risks,
    ...(contentSecrets.length > 0 ? { contentSecrets } : {}),
    ...(truncated ? { truncated } : {}),
    ...(rolledBack ? { rolledBack } : {}),
  };
}
