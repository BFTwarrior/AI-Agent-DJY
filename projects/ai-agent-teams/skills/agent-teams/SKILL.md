---
name: agent-teams
description: Use automatically, without asking the user, when a request can be split into two or more independent subtasks, needs multi-perspective review, or is expected to take more than ten minutes single-threaded; this includes complex code and multi-file implementation work. Create the team and start. Also use when the user asks to view the team dashboard or team view. Do NOT use for a single test run, ordinary Q&A, a small one-shot edit, or any task that clearly finishes in under ten minutes on one thread.
---

# AgentTeams

Use the `mcp__agent-teams__agent_teams_*` tools. The daemon must be running (`node src/daemon.mjs` or the packaged equivalent); the MCP server reads `~/.ai-agent-teams/runtime.json` or `AGENT_TEAMS_URL`/`AGENT_TEAMS_TOKEN`.

## Team view

When the user asks to view the team or open the dashboard, when this skill automatically starts a team for a qualifying task, or when the session was explicitly started with `AI_AGENT_TEAMS_AUTO_PANEL=1`:

1. Prefer `agent_teams_view`; its tool result uses `surface: "ai-agent-teams"` and `preferredDisplayMode: "fullscreen"`, so ZCode opens/focuses the real side-pane tab. A Markdown view link remains the fallback for hosts that do not open the side pane. Do not open the panel merely because a team config or daemon exists; a plain test or ordinary task must not trigger it. The plugin `SessionStart` hook only injects the startup rule when `AI_AGENT_TEAMS_AUTO_PANEL=1`; do not repeat the call unless the user asks to refresh/open the view again.
2. If the MCP App is unavailable, call `agent_teams_view` again; it auto-starts the daemon and retries once. Manual start: `node src/daemon.mjs` from the installed plugin root; it prefers port 8779 and chooses a free loopback port when 8779 is occupied. Wait up to about 5 seconds for `runtime.json`.
3. For an explicit external browser, use `node src/cli.mjs panel --open`; it reads the workspace discovery, including the panel access key, and opens a working URL. If opening manually, read the current `~/.ai-agent-teams/runtime.json` `port` and `uiKey`; never reuse a cached old port. Open `http://127.0.0.1:<port>/ui?key=<uiKey>#tasks`; if an older discovery has no `uiKey`, use `/ui#tasks`. Fall back to `AGENT_TEAMS_URL`/`AGENT_TEAMS_PORT`.
4. Only when the side-pane path is unavailable, open the URL in the browser (Chrome, then Edge, then in-app; reuse one tab). The first visit sets an HttpOnly cookie, so later visits can use `/ui` directly.
5. The full page is a packaged read-only view served from `assets/team-view.html`; it renders a live snapshot from `/api/v1/ui/snapshot` and refreshes over `/api/v1/ui/stream` SSE. If the daemon is unavailable it falls back to the static example. Do not create/approve/halt/archive teams through MCP while using this view.

## Protocol

1. Call `agent_teams_status` first. Continue an existing team before creating a new one.
2. Create a staged team with `agent_teams_create`. In v0.6, start with zero workers; roles are materialized on demand.
3. Add tasks with `agent_teams_edit_plan`; use `assigneeRole` when a task needs a role rather than a named person. Every task needs a subject; quality kinds need a contract.
4. For an automatically created team (two or more independent subtasks, multi-perspective review, or >10 minutes single-threaded), call `agent_teams_approve` yourself and start; do not wait for the user. Only pause for a genuinely ambiguous scope or a permission problem. For a team the user explicitly requested, show the plan only if they ask to review it.
5. The scheduler dispatches ready tasks. Do not micromanage members; use `agent_teams_status`.
6. Handle reports. Retryable turn failures continue automatically on the same task/session with the `继续` continue token (up to 3). Use `agent_teams_continue_task` to restart a task already marked `failed` (captain or reviewer). Use `agent_teams_reassign_task` for transfer/takeover. Never create a new task with a "(retry)" subject.
7. Do not self-approve; do not bypass attempts; do not edit team state files.
8. After a failed review, let the automatic repair/review loop run. If the captain is busy, `agent_teams_patrol` uses a one-shot patrol contractor.
9. On delivery, check the audit in `agent_teams_status`; report blockers honestly.
10. Use `agent_teams_sleep_member` / `agent_teams_wake_member` for cold/warm lifecycle, and `agent_teams_relicense_member` only when the member is settled. Contractors are one-shot and never roster members.
11. Archive with `agent_teams_delete` unless the user wants to continue.

## Housekeeping: old session records

Long-lived installs accumulate state outside the project. This is expected bookkeeping, not a defect, and none of it belongs to the plugin install, so reinstalling the plugin never fixes it. Housekeeping is a separate, user-confirmed operation.

### Why the folders multiply

Every daemon binds its discovery file to one workspace path: `workspaceKey()` hashes the resolved path (lowercased on Windows) with SHA-256 and keeps the first 16 hex characters, and `discoveryPathForWorkspace()` writes `<discoveryBaseDir>/workspaces/<16 hex>/runtime.json`. A distinct workspace path means a distinct hash directory, and nothing removes a workspace's directory when that workspace stops being used. Two further sources are easy to miss: `acquireBootstrapLock()` creates the hash directory (for its `<hash>/runtime.json.lock`) before the daemon is healthy, so a failed or aborted start can leave one behind, and a test run or an alternate `HOME`/`USERPROFILE` writes into whatever discovery base resolves at that moment. `active-workspace.json` records only the last `use` choice; it is not a registry of live workspaces.

Member homes are separate again: `memberHomeRoot()` returns `<home>/.ai-agent-teams/homes`, and the dispatch path creates `homes/<teamId>/<memberId>/tmp` before starting a session. Each new member id therefore adds a directory, and nothing sweeps member homes except `purgeMemberHome()` on an explicit remove or archive. Homes are the largest consumer because a live member session also writes `.zcode/` state inside its home.

### Exact paths

| What | Windows | POSIX |
| --- | --- | --- |
| Discovery base | `%USERPROFILE%\.ai-agent-teams\` | `~/.ai-agent-teams/` |
| Per-workspace discovery | `%USERPROFILE%\.ai-agent-teams\workspaces\<hash>\runtime.json` | `~/.ai-agent-teams/workspaces/<hash>/runtime.json` |
| Legacy discovery mirror | `%USERPROFILE%\.ai-agent-teams\runtime.json` | `~/.ai-agent-teams/runtime.json` |
| Saved target | `%USERPROFILE%\.ai-agent-teams\active-workspace.json` | `~/.ai-agent-teams/active-workspace.json` |
| Member homes | `%USERPROFILE%\.ai-agent-teams\homes\<teamId>\<memberId>\` | `~/.ai-agent-teams/homes/<teamId>/<memberId>/` |
| Supervisor log | `%USERPROFILE%\.ai-agent-teams\supervisor.log` | `~/.ai-agent-teams/supervisor.log` |
| Project state | `<workspace>\.ai-agent-teams\state.db` (plus `-wal`/`-shm`) | `<workspace>/.ai-agent-teams/state.db` (plus `-wal`/`-shm`) |

`AGENT_TEAMS_DISCOVERY_BASE` relocates the discovery base for tests and scratch installs; when a host sets it, resolve paths under that value instead of `~`.

### Never delete

- The plugin install directory, `~/.zcode/skills`, `~/.zcode/agents`, or any `~/.zcode/cli/plugins/` content. These are the product, not state.
- `<workspace>/.ai-agent-teams/state.db` by hand. It is the team's only durable history. Use the supported path below.
- `active-workspace.json`, or the `runtime.json` of the workspace the user is currently running.
- `homes/<teamId>/` while any member of that team has a live session or a task is in flight.
- `install-state.json` in a workspace that has not finished the installer wizard; it stores the four-phase progress.

### Reclaimable

- A `workspaces/<hash>/` directory with no `runtime.json` at all.
- A `workspaces/<hash>/` whose `runtime.json` is unreadable, or whose `pid` no longer exists and whose `workspace` is not the active one.
- Old lines in `supervisor.log`; it is an append-only log the supervisor reopens by path, so truncating it is safe while the supervisor runs.
- `homes/<teamId>/<memberId>/` directories whose member no longer exists in the roster. Prefer removing members through the tools rather than deleting folders, so the database stays consistent.

### Decide whether a hash directory is stale

Treat a directory as reclaimable when any of these hold:

1. There is no `runtime.json` in it.
2. `runtime.json` does not parse, or has no usable `pid`.
3. The recorded `pid` is not a running process.
4. Its `mtime` is older than an agreed window (for example 30 days) and the workspace it names no longer exists on disk.

Never use "old `mtime`" alone to delete a directory that still names a live daemon.

### Safe order

1. Stop the daemon or the supervisor first, so no discovery file is rewritten mid-cleanup. Windows: end the `src/daemon.mjs` process and stop the logon task (`Stop-ScheduledTask -TaskName 'AI Agent Teams Daemon'`); POSIX: the supervisor and daemon both exit on `SIGINT`/`SIGTERM`. Confirm nothing answers on the recorded port before continuing.
2. Run the read-only audit and show the user the counts and the exact list.
3. Delete only the listed stale hash directories. Keep the directory named by `active-workspace.json`.
4. Truncate `supervisor.log` if it is large.
5. For the database, back up and compact instead of deleting files. Stop the daemon, copy `state.db`, then either let the next daemon start apply the built-in event cap (`pruneEvents`, called with 50000 at startup) or reclaim space with SQLite `VACUUM` on a copy. Deleting `state.db` destroys team and task history.
6. Restart the daemon; it recreates its own `workspaces/<hash>/runtime.json`. No manual file creation is needed.

### Read-only check

```bash
node -e "const fs=require('node:fs'),os=require('node:os'),p=require('node:path');const b=p.join(os.homedir(),'.ai-agent-teams'),w=p.join(b,'workspaces');let a=null;try{a=String(JSON.parse(fs.readFileSync(p.join(b,'active-workspace.json'),'utf8')).workspace).toLowerCase()}catch{};const alive=n=>{try{process.kill(n,0);return true}catch(e){return e.code==='EPERM'}};const ds=fs.existsSync(w)?fs.readdirSync(w,{withFileTypes:true}).filter(d=>d.isDirectory()):[];let e=0,d=0,l=0,k=0;const out=[];for(const x of ds){const q=p.join(w,x.name),r=p.join(q,'runtime.json');if(!fs.existsSync(r)){e++;out.push(q);continue}let j;try{j=JSON.parse(fs.readFileSync(r,'utf8'))}catch{d++;out.push(q);continue}if(a&&j.workspace&&String(j.workspace).toLowerCase()===a){k++;continue}if(j.pid&&alive(Number(j.pid))){l++;continue}d++;out.push(q)}console.log('hashDirs='+ds.length+' noRecord='+e+' deadPid='+d+' livePid='+l+' active='+k+' reclaimable='+out.length);out.forEach(s=>console.log('STALE '+s))"
```

It prints counts plus one `STALE <path>` line per candidate. It reads and prints only; it never writes or deletes.

### Cleanup command (requires user confirmation)

Ask before running this. It is the same selection logic behind an environment gate:

```bash
node -e "const fs=require('node:fs'),os=require('node:os'),p=require('node:path');const b=p.join(os.homedir(),'.ai-agent-teams'),w=p.join(b,'workspaces');let a=null;try{a=String(JSON.parse(fs.readFileSync(p.join(b,'active-workspace.json'),'utf8')).workspace).toLowerCase()}catch{};const alive=n=>{try{process.kill(n,0);return true}catch(e){return e.code==='EPERM'}};const ds=fs.existsSync(w)?fs.readdirSync(w,{withFileTypes:true}).filter(d=>d.isDirectory()):[];const out=[];for(const x of ds){const q=p.join(w,x.name),r=p.join(q,'runtime.json');if(!fs.existsSync(r)){out.push(q);continue}let j;try{j=JSON.parse(fs.readFileSync(r,'utf8'))}catch{out.push(q);continue}if(a&&j.workspace&&String(j.workspace).toLowerCase()===a){continue}if(j.pid&&alive(Number(j.pid))){continue}out.push(q)}if(process.env.AGENT_TEAMS_RECLAIM!=='1'){out.forEach(s=>console.log('STALE '+s));console.log('DRY RUN: '+out.length+' stale directories; set AGENT_TEAMS_RECLAIM=1 to delete them.')}else{for(const s of out)fs.rmSync(s,{recursive:true,force:true});console.log('deleted '+out.length+' stale hash directories')}"
```

Without `AGENT_TEAMS_RECLAIM=1` it is a dry run. Set the variable only after the user approves the printed list.

### What to tell the user before cleaning

State three things plainly: which folders will be deleted (the stale `workspaces/<hash>` directories listed by the audit, and old `supervisor.log` lines), which will be kept (the plugin install, `~/.zcode` skills and agents, `state.db` and its history, `active-workspace.json`, and the current workspace's `runtime.json` and member homes), and that the daemon recreates its discovery file on the next start, so the dashboard URL and port may change. After cleaning, restart the daemon and confirm `agent_teams_status` (or the panel) works again.

## Hard numbers

Legacy configs: 1 captain, 2 teams, 16 members per team (max 32), 6 active workers. v0.6 configs start with zero members and use memory presets: 16GB dual 6+6 (max 8+8), 32GB 8+8 or 10+10, 64GB 12+12 or 16+16. Roster size is not concurrency.
