# Migration log

Date: 2026-10-26

## Project root

`<project-root>` (this repository).

## Moved

| Item | From | To |
| --- | --- | --- |
| Complete spec | `<source-workspace>/ai-agent-teams-COMPLETE-SPEC.md` | `<project-root>/SPEC.md` |
| agent-teams-ai README | `<source-workspace>/agent-teams-ai-README.md` | `<reference-root>/agent-teams-ai-README.md` |
| dsh-agent-teams clone | `<source-workspace>/dsh-agent-teams` | `<reference-root>/dsh-agent-teams` |

## Result

- The source workspace is empty.
- The package root contains only project files.
- Reference material lives outside the package root and is not published.
- ZCode runtime data under `<user-home>/.zcode` was not moved; it belongs to the application.

## Rule going forward

- New project files go under `<project-root>`.
- Do not move ZCode runtime data.
- Reference clones are read-only inputs; do not edit them.

## 0.1.11 native worker-model selection (source implementation)

These steps document the source implementation and required manual acceptance; they do not assert that the unreleased 0.1.11 plugin is installed. The repository metadata is 0.2.2, but the latest formal release is 0.1.8. Do not present this source-only migration as a release download/update until the corresponding release and marketplace artifact exist.

- Update the full plugin, not only its runtime bundle: the new `agents/team-worker.md` resource and `agents` manifest entry belong to the host-managed plugin shell. Runtime hot updates intentionally cannot register native agent resources.
- Keep the existing marketplace identity. Refresh that marketplace in **Plugin Marketplace / Marketplace Sources**, then choose **Update** on the plugin and confirm the installed version matches the source you are installing (current source is 0.2.2; use whatever the release actually publishes) in **Settings / Plugins**. Do not add a second same-named marketplace merely to update an existing installation. Source/catalog edits alone do not update installed files.
- In **Settings / Subagents**, find the plugin's shared `team-worker` entry and select the desired worker provider/model, for example DeepSeek. Ordinary workers, leads and model-backed contractors share this choice; the captain conversation and shadow are not repinned. There is one preference entry, not one native entry per roster row.
- Use a protocol-backed team daemon for an explicit native choice. CLI/container adapters cannot honor this pin and refuse it instead of silently using another model. Removing the override (**Inherit default**) restores the original fixed/follow-host policy; it does not change those configuration keys.
- Restart the relevant plugin/daemon through the normal user-controlled update flow and test in a new task. The acceptance example is a GPT captain dispatching one worker task: verify the worker model reports the selected DeepSeek provider/model while the captain remains GPT. Real provider execution may incur costs and remains a separate, explicitly authorized trial.
- If a native selection is invalid or cannot be applied, correct Settings first and explicitly release the task's `native_model_selection` hold. Never clear an unknown-session recovery gate just because the model setting was corrected.
- The source catalog in this repository is named `ai-agent-teams`; a packaged local marketplace uses `ai-agent-teams-local`. The stable override is bound to the actual installed marketplace identity, never hard-coded to either name. No personal agent configuration is rewritten by the bridge.
- Installation, native GUI visibility and paid-provider execution are not verified by source/payload tests. This change does not restore the removed cost gateway.

## 0.1.9 working tree compatibility notes

Historical source checkpoint; not the current source version. These notes describe compatibility changes introduced in that tree, not a published release or an installed-plugin acceptance result.

- The cost-budget gateway is removed (ADR-0027): remove `cost` and `budgetUsd` from old configurations and stop using the removed gateway command. Provider quota/429 retries remain. `isolation.network=gateway-only` is a network isolation mode and stays supported.
- A persisted `budget_paused` control stays blocked; an operator must explicitly resume the team after checking its state. There is no automatic budget-state conversion.
- Claim, heartbeat and task update require the current attempt ID, including after continue. Update older MCP clients to send `attempt_id`; never substitute an ID for an old reply. See `docs/contracts.md` and ADR-0031.
- Service, MCP and hot-update extraction keeps the existing public entry points. Source edits do not replace an already-installed plugin or restart a running daemon; install/restart verification is a separate operation.

## 0.1.8 flexible workspace and standalone panel

- The MCP server resolves the team project per tool call. `agent_teams_workspace current|list|use|auto` switches projects inside one conversation; every tool also accepts an optional `workspace`. A folder with no team config falls back to the newest live daemon instead of auto-starting a daemon there.
- The saved target (`~/.ai-agent-teams/active-workspace.json`) is only a fallback; a session that owns team config keeps its own workspace. `auto` clears the saved target. `agent_teams_workspace` is captain/UI-only and is hidden from member sessions.
- `SessionStart` also injects the panel rule when a live daemon exists, covering ZCode's default workspace. `AI_AGENT_TEAMS_AUTO_PANEL=0` still disables it; worker sessions remain silent.
- `panel --window` / `npm run panel:window` / `open-panel.cmd` / `agent_teams_view {window:true}` opens a standalone Edge/Chrome app window. Browser order is Edge, then Chrome, then the OS default.
- Reinstall/update the plugin to 0.1.8, restart ZCode (the MCP process is long-lived), and keep the daemon at 0.1.8.

## 0.1.7 startup panel and runtime fixes

- The plugin declares a `SessionStart` hook (`hooks/hooks.json` + `scripts/session-start.mjs`) that injects the one-time `agent_teams_view` startup call in a team workspace. The model then makes that call, and its fullscreen result opens the side-pane tab. This is model-mediated, not a host popup. MCP `initialize.instructions` repeats the rule, but its consumption by ZCode 0.17.1 is unverified. Worker sessions and `AI_AGENT_TEAMS_AUTO_PANEL=0` skip the hook; unrelated workspaces are skipped unless `AI_AGENT_TEAMS_AUTO_PANEL=1` is set.
- `agent_teams_view` now requests `preferredDisplayMode: "fullscreen"` and does not set `showInline: true` (that flag pins an inline card). Hosts that do not open the side pane only get the Markdown `/ui` link; an inline card is not guaranteed, and `pip` is not requested.
- An empty git repository no longer fails every worktree attempt with `fatal: invalid reference: <base>`; the first dispatch creates an empty baseline ref. This does not commit untracked files. A non-empty repository still fails fast if the configured base is missing.
- Reinstall/update the plugin to 0.1.7 and restart ZCode; the daemon can be restarted independently.

## 0.1.6 project rename

- The project directory was renamed from a legacy folder name on 2026-10-30; update any absolute path recorded in local configuration.
- The npm package, plugin id, MCP server name and marketplace name remain `ai-agent-teams`; only the project folder and display name changed.
- The daemon discovery moved to the new workspace hash; restart the supervisor/task after moving so it uses the new absolute path.

## 0.1.6 panel upgrade

- The daemon now publishes a per-process `uiKey` and `/ui` requires it. Open the panel with `node src/cli.mjs panel --open`, not a cached `/ui` URL.
- An already-running ZCode session may still hold the 0.1.5 MCP process; restart ZCode after installing 0.1.6 so the MCP tools and panel instructions come from the new handler. The daemon can be restarted independently.
- Existing 0.1.5 discovery records without `uiKey` remain readable, but only a 0.1.6 daemon serves the keyed panel.
