// A stub daemon in its own process, so `stopStaleDaemon` can really kill it.
//
// Every other stub in this suite serves `pid: process.pid`, and
// `stopStaleDaemon` refuses to signal the calling process. That refusal is the
// right safety behaviour, but it means the *successful* replacement branch --
// including the `replacedVersion` assignment the supervisor logs -- never runs
// under test, so that line could be deleted with the whole suite still green.
//
// A child process fixes that: it holds a real port and a real pid, reports a
// version of the test's choosing, and dies to a real signal.
import { spawn, spawnSync } from 'node:child_process';

// Runs in the child's module graph, so it has to be a string. The child's
// `process.argv` is [node, port, version, workspace, token, instanceId] --
// `node -e` does not consume a script-path slot.
const CHILD_SOURCE = `
const { createServer } = require('node:http');
const [, port, version, workspace, token, instanceId] = process.argv;
const server = createServer((req, res) => {
  if (req.url === '/api/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { status: 'ok', version, workspace, pid: process.pid, instanceId } }));
    return;
  }
  if (req.url === '/api/v1/teams') {
    const authorized = req.headers.authorization === 'Bearer ' + token;
    res.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: authorized }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(Number(port), '127.0.0.1', () => {
  process.stdout.write('listening ' + server.address().port + '\\n');
});
`;

/**
 * Terminate a process, falling back to `taskkill /F /T` on Windows.
 *
 * `process.kill(pid, 'SIGTERM')` does terminate a detached Node process on
 * Windows -- an earlier version of this comment claimed otherwise and that was
 * wrong, measured: the process is gone within 2s. `taskkill /F /T` is used
 * anyway because it also takes the child's own subprocesses (`/T`), which plain
 * signal delivery does not.
 * @param {number} pid
 */
export function terminate(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 1) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(numeric), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
    } catch { /* already gone */ }
    return;
  }
  try { process.kill(numeric, 'SIGTERM'); } catch { /* already gone */ }
}

/**
 * Start a killable stub daemon that reports `version`.
 * @param {{ version: string, workspace: string, token: string }} options
 * @returns {Promise<{ pid: number, port: number, instanceId: string, stop: () => void }>}
 */
export async function startChildDaemon({ version, workspace, token }) {
  const instanceId = `child-${Math.random().toString(16).slice(2, 10)}`;
  const child = spawn(process.execPath, [
    '-e', CHILD_SOURCE,
    '0', version, workspace, token, instanceId,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`child daemon exited with code ${child.exitCode}: ${stderr || stdout}`);
    }
    const match = /listening (\d+)/.exec(stdout);
    if (match) {
      return {
        pid: child.pid,
        port: Number(match[1]),
        instanceId,
        stop: () => terminate(child.pid),
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  try { child.kill(); } catch { /* already gone */ }
  throw new Error(`child daemon did not start: ${stderr || stdout}`);
}
