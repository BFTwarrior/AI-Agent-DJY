// Secret detection: file names, and a bounded look at file content.
//
// This is a safety net, not a secret scanner. Two independent checks run because
// each one alone is insufficient:
// - a *name* check catches the conventional carriers (`.env`, `*.pem`,
//   `id_rsa*`, `credentials*`) that a content scan would happily read as text;
// - a *content* check catches a private key or token pasted into an ordinary
//   source file, which the name check cannot see.
//
// The content check is bounded by `secretScanBytes` per file and by global file
// and byte budgets. When a budget is exhausted the scan stops and reports
// truncation; it never silently claims the remaining files are clean. The
// patterns are deliberately prefix-anchored and conservative: a false positive
// blocks a legitimate first commit, so only unambiguous key/token shapes match.

import { openSync, readSync, closeSync } from 'node:fs';

import { MAX_LINE_COUNT_FILE_BYTES } from './contract.mjs';
import { isWin32 } from './fs-primitives.mjs';

// Name patterns follow the design's prefix semantics: `.env*`, `id_rsa*`,
// `credentials*`. On Windows the comparison is case-insensitive because the
// filesystem is; on POSIX it stays byte-exact, matching git's own semantics.
const SECRET_BASENAME_PATTERNS = Object.freeze([
  /^\.env/u,
  /\.(?:pem|key|p12|pfx|keystore|jks)$/u,
  /^id_rsa/u,
  /^credentials/u,
  /^\.netrc$/u,
  /^\.npmrc$/u,
  /^\.pypirc$/u,
]);

const CONTENT_SECRET_PATTERNS = Object.freeze([
  { kind: 'private-key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/u },
  { kind: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { kind: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u },
  { kind: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u },
  { kind: 'stripe-secret-key', regex: /\bsk_live_[A-Za-z0-9]{16,}\b/u },
  { kind: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/u },
]);

const TEXT_EXTENSIONS = Object.freeze(new Set([
  'c', 'cc', 'cfg', 'cjs', 'cpp', 'cs', 'css', 'go', 'gradle', 'h', 'hpp',
  'html', 'ini', 'java', 'js', 'json', 'jsx', 'kt', 'less', 'lua', 'm', 'md',
  'mjs', 'mm', 'php', 'ps1', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte',
  'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml',
]));

export function isSecretName(name) {
  const candidate = isWin32() ? name.toLowerCase() : name;
  return SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(candidate));
}

export function isTextName(name) {
  const index = name.lastIndexOf('.');
  if (index === -1) return false;
  return TEXT_EXTENSIONS.has(name.slice(index + 1).toLowerCase());
}

/**
 * Read at most `limit` bytes from the start of a file.
 *
 * A loop is used instead of a single `readSync` because a short read is legal
 * and would otherwise silently shrink the scanned window, making the reported
 * `secretScanBytes` a lie.
 */
export function readPrefix(path, limit) {
  if (limit <= 0) return Buffer.alloc(0);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const read = readSync(fd, buffer, offset, limit - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

export function countLinesIn(buffer) {
  let lines = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) lines += 1;
  }
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/**
 * 1-based line number of a byte offset in already-decoded text.
 *
 * The offset comes from a regex match on the same string, so no byte/character
 * conversion is needed; counting newlines is exact even with multi-byte text
 * because the scan happens after decoding.
 */
export function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === '\n') line += 1;
  }
  return line;
}

/**
 * Scan the first `limit` bytes of a file for one unambiguous secret shape.
 *
 * Only the first match is reported: one finding per file is enough to block the
 * commit, and reporting an arbitrary number of token positions would put the
 * token itself into a log line.
 */
export function scanContentSecrets(path, size, limit) {
  const prefix = readPrefix(path, Math.min(size, limit)).toString('utf8');
  if (prefix === '') return null;
  for (const pattern of CONTENT_SECRET_PATTERNS) {
    const match = pattern.regex.exec(prefix);
    if (match) return { kind: pattern.kind, line: lineAt(prefix, match.index) };
  }
  return null;
}

export function countFileLines(path, size) {
  const limit = Math.min(size, MAX_LINE_COUNT_FILE_BYTES);
  const buffer = readPrefix(path, limit);
  return { lines: countLinesIn(buffer), complete: size <= limit };
}
