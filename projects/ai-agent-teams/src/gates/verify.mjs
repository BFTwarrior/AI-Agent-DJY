import { spawn } from 'node:child_process';
import { killProcessTree } from '../session/process-tree.mjs';

export const DEFAULT_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
export const OUTPUT_CAP = 64 * 1024;

function createCapture() {
  return { buffer: Buffer.alloc(OUTPUT_CAP), length: 0, truncated: false };
}

// Cap while chunks stream in: a chatty verify command must not grow the
// daemon's memory until `close`. Once the cap is reached, every later chunk is
// dropped and only the truncation marker is recorded.
function appendCapture(capture, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const room = OUTPUT_CAP - capture.length;
  if (room <= 0) {
    capture.truncated = true;
    return;
  }
  const length = Math.min(bytes.length, room);
  bytes.copy(capture.buffer, capture.length, 0, length);
  capture.length += length;
  if (bytes.length > room) capture.truncated = true;
}

function captureValue(capture) {
  let end = capture.length;
  if (capture.truncated && end > 0) {
    let start = end - 1;
    while (start > 0 && (capture.buffer[start] & 0xc0) === 0x80) start -= 1;
    const lead = capture.buffer[start];
    const width = lead >= 0xf0 && lead <= 0xf4 ? 4
      : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
    if (end - start < width) end = start;
  }
  const text = capture.buffer.subarray(0, end).toString('utf8');
  return capture.truncated ? `${text} [truncated]` : text;
}

/**
 * Run one shell command and resolve with its exit code. A nonzero exit is a
 * value, not an exception; spawn failure or timeout rejects.
 * @param {{ command: string, cwd: string, timeoutMs?: number }} input
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export function runCommand({ command, cwd, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      // POSIX: own the process group so a timeout kills the shell and every
      // child it started. Windows uses `taskkill /T` in killProcessTree.
      detached: process.platform !== 'win32',
    });
    const stdout = createCapture();
    const stderr = createCapture();
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // `child.kill()` only signals the shell and can leave verify children
      // (test runners, watchers) alive as orphans. Surface a failed tree kill
      // instead of silently claiming the timeout cleaned everything up.
      const killed = killProcessTree(child);
      const suffix = killed?.ok === false ? `; process-tree kill failed: ${killed.error}` : '';
      reject(new Error(`verify command timed out after ${timeoutMs}ms: ${command}${suffix}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { appendCapture(stdout, chunk); });
    child.stderr.on('data', (chunk) => { appendCapture(stderr, chunk); });
    child.on('error', (error) => {
      if (settled) return;
      const killed = killProcessTree(child);
      if (killed?.ok === false && error && typeof error === 'object') {
        error.cleanupError = killed.error;
      }
      finish(reject, error);
    });
    child.on('close', (code) => {
      finish(resolve, {
        exitCode: code ?? 1,
        stdout: captureValue(stdout),
        stderr: captureValue(stderr),
        outputTruncated: stdout.truncated || stderr.truncated,
      });
    });
  });
}

/**
 * Run every declared verify command in one working directory.
 * @param {{ cwd: string, commands: string[], timeoutMs?: number }} input
 * @returns {Promise<Array<{ command: string, status: 'passed'|'failed', exitCode: number, stdout: string, stderr: string }>>}
 */
export async function runVerify({ cwd, commands, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS }) {
  const results = [];
  for (const command of commands) {
    const result = await runCommand({ command, cwd, timeoutMs });
    results.push({
      command,
      // A successful exit cannot make clipped output complete evidence.
      status: result.exitCode === 0 && !result.outputTruncated ? 'passed' : 'failed',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputTruncated: result.outputTruncated,
    });
  }
  return results;
}
