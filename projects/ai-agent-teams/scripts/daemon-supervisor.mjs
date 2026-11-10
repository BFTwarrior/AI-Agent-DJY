#!/usr/bin/env node
/**
 * Keep the workspace daemon alive for the stable UI URL (default 8779).
 *
 * Run at login (or manually) with `npm run daemon:supervise`. The supervisor
 * calls ensureDaemon every interval; if the daemon dies or discovery points at
 * a stale process, it starts a fresh daemon on the preferred port. The daemon
 * is detached, so this loop is cheap and only logs state changes/failures.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRotatingLog } from '../src/discovery.mjs';
import { ensureDaemon } from '../src/bootstrap.mjs';
import { formatDaemonResult } from './supervisor-log.mjs';

const workspace = process.env.AGENT_TEAMS_WORKSPACE || fileURLToPath(new URL('..', import.meta.url));
const configPath = process.env.AGENT_TEAMS_CONFIG || join(workspace, 'config', 'local.json');
const intervalMs = Math.max(5000, Number(process.env.AGENT_TEAMS_SUPERVISOR_INTERVAL_MS) || 30000);
const logPath = join(homedir(), '.ai-agent-teams', 'supervisor.log');

function log(message) {
  try {
    appendRotatingLog(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging is best-effort; the daemon is the important part.
  }
}

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

log(`supervisor start workspace=${workspace} config=${configPath} interval=${intervalMs}ms`);
while (!stopping) {
  try {
    const result = await ensureDaemon({ workspace, configPath, timeoutMs: 20000 });
    const line = formatDaemonResult(result);
    if (line) log(line);
  } catch (error) {
    log(`ensureDaemon failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
}
log('supervisor stop');
