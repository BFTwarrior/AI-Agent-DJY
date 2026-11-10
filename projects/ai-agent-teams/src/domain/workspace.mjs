import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Compare two workspace paths, tolerating Windows case differences.
 * @param {string | undefined} left
 * @param {string | undefined} right
 * @returns {boolean}
 */
export function sameWorkspace(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  let a;
  let b;
  try {
    a = resolve(left);
    b = resolve(right);
  } catch {
    return false;
  }
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * @param {string} workspace
 * @returns {boolean}
 */
export function isGitWorkspace(workspace) {
  const result = spawnSync('git', ['-C', workspace, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  return result.status === 0 && String(result.stdout).trim() === 'true';
}
