// Running git with a sanitized environment.
//
// Inheriting the caller's environment is unsafe for a bootstrap: `GIT_DIR`,
// `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the `GIT_CONFIG_*` family can silently
// redirect the command to a different repository or a different config. The
// environment is therefore rebuilt from scratch: allowed variables are copied,
// deny-listed ones are dropped, and global/system config is pointed at a null
// device so only repository-local config applies.
//
// `GIT_CONFIG_GLOBAL` must be `NUL` on Windows, not `\\.\nul`: Git for Windows
// cannot open Node's `devNull` spelling and would fail every command.
//
// A git child can exit before reading stdin (old git without `check-ignore -z
// --stdin`, an `index.lock` conflict). Without a stdin error listener that EPIPE
// becomes an uncaught exception that would take the daemon down, so the write
// failure is converted into a rejected promise.

import { spawn } from 'node:child_process';
import { devNull } from 'node:os';

import { GIT_ENV_DENY } from './contract.mjs';
import { GitBootstrapError } from './errors.mjs';
import { isWin32 } from './fs-primitives.mjs';

export function buildGitEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (GIT_ENV_DENY.has(key)) continue;
    if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) continue;
    env[key] = value;
  }
  // Full isolation: no system or user gitconfig, no inherited repository
  // pointers. Everything this module needs is written as repository-local
  // config by configureRepository().
  env.GIT_CONFIG_GLOBAL = isWin32() ? 'NUL' : devNull;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.LC_ALL = 'C';
  if (overrides) Object.assign(env, overrides);
  return env;
}

/**
 * Run a git command with a sanitized environment.
 *
 * Resolves with `{ code, stdout, stderr }` for any of `allowedExitCodes` and
 * rejects otherwise, so "exit 1 means nothing is ignored" stays expressible
 * without every caller re-checking the code.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {{
 *   input?: string,
 *   allowedExitCodes?: number[],
 *   gitCommand?: string,
 *   env?: Record<string, string>
 * }} [options]
 */
export function runGit(args, cwd, { input, allowedExitCodes = [0], gitCommand = 'git', env } = {}) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    let child;
    try {
      child = spawn(gitCommand, args, {
        cwd,
        windowsHide: true,
        env: buildGitEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      settleReject(new GitBootstrapError('GIT_BOOTSTRAP_FAILED', `cannot spawn ${gitCommand}: ${error.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      const code = error.code === 'ENOENT' ? 'GIT_REQUIRED' : 'GIT_BOOTSTRAP_FAILED';
      settleReject(new GitBootstrapError(code, `cannot run ${gitCommand}: ${error.message}`, { stderr }));
    });
    child.on('close', (exitCode) => {
      if (allowedExitCodes.includes(exitCode)) {
        settleResolve({ code: exitCode, stdout, stderr });
        return;
      }
      settleReject(new GitBootstrapError(
        'GIT_BOOTSTRAP_FAILED',
        stderr.trim() || `git ${args[0] ?? ''} exited with ${exitCode}`,
        { exitCode, stdout, stderr },
      ));
    });
    // A git process may exit before reading stdin. Without this listener the
    // resulting EPIPE would be an uncaught exception.
    child.stdin.on('error', (error) => {
      settleReject(new GitBootstrapError(
        'GIT_BOOTSTRAP_FAILED',
        `cannot write to ${gitCommand} stdin: ${error.message}`,
        { stderr },
      ));
    });
    try {
      child.stdin.end(input ?? '');
    } catch (error) {
      settleReject(new GitBootstrapError('GIT_BOOTSTRAP_FAILED', `cannot write to ${gitCommand} stdin: ${error.message}`));
    }
  });
}

export function parseGitVersion(stdout) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/u.exec(stdout);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

export function supportsInitialBranch(version) {
  return version !== null && (version.major > 2 || (version.major === 2 && version.minor >= 28));
}
