import { createInterface } from 'node:readline';
import { createMcpHandler } from './handler.mjs';
import { ensureDaemon } from '../bootstrap.mjs';
import { hasTeamConfig } from '../workspace-target.mjs';

// Replaceable runtime for the stable MCP shell in `shell.mjs`.
//
// This file is the original `src/mcp-server.mjs` behaviour moved verbatim: it
// owns the handler, the JSON-RPC line loop and the opt-out auto-start. The
// shell spawns it as a child process so a new runtime entry can be swapped in
// without the host noticing a different stdio server.
const workspace = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const autoStart = process.env.AGENT_TEAMS_AUTOSTART !== '0';
// ZCode starts this server in its own default workspace. Starting a daemon
// there would either fail (not a git repo) or create an unrelated team, so
// auto-start only where a team config exists; otherwise the handler resolves
// the workspace per call and can fall back to a recent daemon.
if (autoStart && hasTeamConfig(workspace)) {
  try {
    await ensureDaemon({ workspace });
  } catch (error) {
    console.error(`AgentTeams bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const handle = createMcpHandler({ workspace, ...(autoStart ? { ensureDaemon } : {}) });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  void (async () => {
    let request;
    try {
      request = JSON.parse(text);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    const response = await handle(request);
    if (response !== null) process.stdout.write(JSON.stringify(response) + '\n');
  })();
});
