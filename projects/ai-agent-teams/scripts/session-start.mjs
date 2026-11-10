// ZCode SessionStart hook. Two independent jobs:
//
// 1. Persist the host session id so the daemon can follow the captain's model
//    even though only hook subprocesses receive ZCODE_SESSION_ID. The file is
//    `.ai-agent-teams/host-session.json` (0600) next to the workspace.
// 2. Opt-in panel rule: a "call agent_teams_view first" instruction is injected
//    only when AI_AGENT_TEAMS_AUTO_PANEL=1. Normal sessions get no instruction
//    and no tool call, so a simple test stays a simple test.
//
// The output schema is strict: only { hookEventName, additionalContext } is
// allowed for SessionStart. Any other key fails validation and is discarded.

import { isAbsolute, resolve } from 'node:path';
import { writeHostSessionFile } from '../src/host-model.mjs';
import { AUTO_PANEL_ENV, PANEL_STARTUP_RULE } from '../src/domain/prompt-rules.mjs';
import { hasTeamConfig } from '../src/workspace-target.mjs';

function readStdin() {
  return new Promise((resolvePromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', () => resolvePromise(data));
    if (process.stdin.isTTY) resolvePromise('');
  });
}

function parsePayload(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return null; // malformed input never gets to influence the panel rule
  }
}

function workspaceOf(payload) {
  const cwd = typeof payload?.cwd === 'string' && payload.cwd.trim() ? payload.cwd : process.cwd();
  return isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd);
}

function persistHostSession(payload) {
  const sessionId = process.env.ZCODE_SESSION_ID || payload?.session_id || payload?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId.trim()) return;
  const workspace = workspaceOf(payload);
  // Only team workspaces get the state file. Writing it into every repository
  // a user opens would leave an untracked .ai-agent-teams/ directory behind.
  if (!hasTeamConfig(workspace)) return;
  try {
    writeHostSessionFile(workspace, sessionId);
  } catch {
    // The daemon also falls back to its own env; a read-only workspace must not
    // break session startup.
  }
}

async function main() {
  // Member/contractor sessions are spawned by the daemon in task worktrees;
  // their session id is not the host and must never overwrite host-session.json.
  if (process.env.AI_AGENT_TEAMS_WORKER === '1') return;
  const raw = await readStdin();
  const payload = parsePayload(raw);
  persistHostSession(payload);
  // Default off. A live daemon or a team config is not evidence that this
  // particular request is a team task; only an explicit opt-in is.
  if (process.env[AUTO_PANEL_ENV] !== '1') return;
  if (!payload) return; // fail closed: malformed input must not trigger a panel call
  // Only new sessions; resume/compact already have the instruction in context.
  const source = payload.source;
  if (source && source !== 'startup' && source !== 'clear') return;
  process.stdout.write(`${JSON.stringify({
    hookEventName: 'SessionStart',
    additionalContext: PANEL_STARTUP_RULE,
  })}\n`);
}

main().catch(() => {
  // A hook must never block a session because of an internal error.
  process.exitCode = 0;
});
