---
description: Open the live AI Agent Teams panel in the ZCode side pane
---

# /team-view

Open the AI Agent Teams visual team view.

1. Prefer the MCP App panel: call `mcp__agent-teams__agent_teams_view` once. Its tool result uses `surface: "ai-agent-teams"` and `preferredDisplayMode: "fullscreen"`, so ZCode opens/focuses the real side-pane tab. If the host does not open the side pane, the tool text still contains the keyed Markdown `/ui` link.
2. Do not open the panel for an ordinary test or one-shot task. The plugin `SessionStart` hook only injects the startup rule when `AI_AGENT_TEAMS_AUTO_PANEL=1`; MCP `initialize.instructions` never auto-opens it. Do not call it repeatedly; a second call refreshes the same surface/tab.
3. If the MCP App is unavailable, call `agent_teams_view` again: it auto-starts the daemon and retries once. If starting manually, run `node src/daemon.mjs`; it prefers port 8779 and automatically chooses a free loopback port if 8779 is occupied. Wait up to about 5 seconds for `runtime.json`.
4. Prefer `node src/cli.mjs panel --open` for an explicit external browser; it reads the workspace discovery, including the panel access key, and opens a working URL. If opening manually, read `~/.ai-agent-teams/runtime.json` and take `port` and `uiKey`; do not cache an old port. Open `http://127.0.0.1:<port>/ui?key=<uiKey>#tasks`. If the discovery has no `uiKey` (an older daemon), use `http://127.0.0.1:<port>/ui#tasks`. If discovery is unavailable, use `AGENT_TEAMS_URL` or `AGENT_TEAMS_PORT` (default `8779`).
5. Open the URL in the browser only when the side-pane path is unavailable. Prefer Chrome, then Edge, then the in-app browser; reuse one tab and do not leave duplicate tabs. The first visit sets an HttpOnly cookie, so later visits can use `/ui` directly.
6. This is a read-only visual view. Do not create, approve, halt, or archive teams from this command. If browser control is unavailable, print the URL clearly and tell the user to open it.
