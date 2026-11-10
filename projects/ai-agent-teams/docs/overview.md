# Ai-Agent-Teams-Zcode

> Project directory renamed from `AI-agent-teams` on 2026-10-30. The internal npm package and ZCode plugin id remain `ai-agent-teams` for compatibility with existing installations and tool names.

> A team control plane for ZCode. One captain, two teams, 8–32 members per team (16 default), an optional single shadow (小队长) for overflow coordination, a shared worker pool with a configurable total cap (6 in the default UI, dynamically split), and two reserved contractor slots: patrol + merge review.

**Current formal release: `0.1.8`; current source/package: `0.2.2` (unreleased).** The 0.1.8 description below records the last formal-release capability baseline, not a claim that the dirty 0.2.2 worktree has passed every runtime or installation acceptance check. The worker Dockerfile now defines a pinned upstream Linux ZCode CLI source build; the current image build and runtime check are still pending. Startup image pulls refresh only the configured image reference, not a CLI version feed. The specification, SQLite store, daemon + HTTP/SSE, scheduler service, staged plan/member lifecycle, 37 `agent_teams_*` tools, lazy v0.6 members, licenses, warm/cold lifecycle, dynamic dual-team allocation, an optional single shadow (小队长) with captain-level delegated authority and on-demand start/stop, captain-gated A↔B mail, standard/full-access automation, slot-partitioned one-shot contractors (patrol 1 + merge review 1, with legacy `main` as the patrol alias), integration-branch post-merge review, and captain patrol exist and are tested with a fake adapter. The plugin includes a packaged MCP App team card (`agent_teams_view`), a native plugin UI surface for the ZCode side pane, and the full `/ui` view. Member sessions mount a member-scoped `agent-teams-member` MCP server; the plugin's admin-token MCP server is denied by exact tool name, and protocol turns are watched for `turn.failed` so rate-limit failures are retried in-process with backoff instead of waiting for the task lease. Actual hard-container execution is verified on this host as of 2026-10-30; read-only container completion through the member MCP is verified, while multi-host load is **not verified**; ZCode 0.17 still has no conversation-header button slot. Historical real-load evidence: paced 16-way 16/16; on 2026-10-29, real 32-way passed 32/32 paced and unthrottled, and 48-way passed 48/48 unthrottled, using the backup `provider-a/model-x` endpoint. These runs are historical results, not current-source or cross-provider guarantees.

> **Working source: 0.2.2 (unreleased).** The hardened worker Dockerfile is configured to build a Linux ZCode CLI from pinned upstream source commit `a9fe401eede6e6e5e01be9048679c206fe6f02d9` (tag `v3.17.2`); startup pull policy refreshes that configured image only. The 0.2.2 image build has not yet passed runtime validation. The package does not publish an official worker registry. End-to-end Linux runtime acceptance remains pending until the image build and `zcode --version` are verified on the available Podman environment. The changes and acceptance boundary are tracked in [STATUS](status/STATUS.md). This source includes a shared `team-worker` entry for native **Settings / Subagents** model selection: a GPT captain can select DeepSeek for protocol-backed workers independently. Full-plugin update and real-provider acceptance remain separate; see [migration and trial steps](guides/MIGRATION.md#0111-native-worker-model-selection-source-implementation). No installed-copy or production-readiness claim is made.

## What this is

- A **team control plane** that runs outside the ZCode chat session.
- One captain commands one or two teams. Each team has one lead and a roster of members (8–32, 16 by default). An optional single shadow (小队长) can take over coordination across both teams when the captain is busy; it acts with captain-level authority under its own identity.
- Each member is an independent ZCode session, woken by a daemon through the ZCode Protocol or CLI.
- Tasks are persistent, dependency-aware, attempt-tokened, and quality-gated.
- Isolation is layered: git worktree (separate working folder per task, file separation only) -> optional container mode (one container per active worker, needs WSL2 + Docker/Podman) -> microVM (stronger, advanced/not bundled). The default is worktree; no container is created unless container mode is configured.
- Interruption is layered: `queue` -> `guide` -> `stop`.
- ZCode 0.17 has no conversation-header contribution slot, but it does support native plugin UI surfaces in the session side pane. The plugin declares `ui.surfaces` with `availability: "session"`. ZCode 0.17's surface schema has no `autoOpen` field, so startup uses a plugin **SessionStart hook** plus a one-time tool call: the hook injects a short rule into a new session, the model calls `agent_teams_view` once, and that tool's `_meta.ui` declares `surface: "ai-agent-teams"` plus `preferredDisplayMode: "fullscreen"`, which the host maps to its side-pane opener. This is a model-mediated path, not a host popup: if the model skips the call, the panel does not open by itself. The MCP `initialize.instructions` carries the same rule as a secondary hint, but this host's consumption of that field is unverified. Design and limits: `docs/decisions.md`. The hook fires in a workspace with `.ai-agent-teams/` or a `config/local.json` containing this tool's `teams` array, or when a live team daemon exists (the default-workspace fallback); set `AI_AGENT_TEAMS_AUTO_PANEL=1` to force it elsewhere and `=0` to disable it.
- A packaged visual team view is available at `GET /ui` and opened by `/team-view` (read-only live snapshot + SSE; static fallback). The daemon prefers port `8779`, falls back to a free loopback port when occupied, and writes `~/.ai-agent-teams/workspaces/<hash>/runtime.json` (plus the legacy `runtime.json` mirror) so two workspaces do not overwrite each other; `agent_teams_view` auto-restarts a stopped daemon once before returning the new URL. For a stable 8779 across reboots, run `npm run daemon:supervise` and register it at logon with `scripts/register-daemon-task.ps1`.
- The plugin also exposes `agent_teams_view`, a read-only MCP App that opens the live side-pane tab (with a Markdown view link on hosts that do not open the side pane) and includes a clickable `打开任务` link plus a keyed `/ui` fallback.
- Open the panel from the program: `npm run panel:open` (or `node src/cli.mjs panel --open`) reads discovery, checks `/api/v1/health`, then launches Edge, Chrome, or the OS default browser in that order. `npm run panel:window` (or `open-panel.cmd`) opens a standalone chromeless Edge/Chrome app window that stays open independently of ZCode; `agent_teams_view {window:true}` does the same from a chat. `npm run panel` only prints the URL and instructions. The daemon prints the same hint at startup and includes it in the MCP `initialize` instructions; in ZCode the SessionStart hook asks the model to make the first call, and `/team-view` remains the manual fallback.
- The MCP server resolves the target project per call, not per process. `agent_teams_workspace current|list|use|auto` switches between projects in one conversation (for example A and B); any tool also accepts an optional `workspace` argument. A host folder with no team config falls back to the newest live daemon instead of failing with `not a git repository`. Details: `docs/decisions.md`.

### Hard isolation configuration (0.1.6+)

- `isolation.homeSeed` points at the host ZCode profile (normally `~/.zcode/v2`). Each worker home receives only `credentials.json`, `provider_config.json` and `setting.json`; session databases and logs are not copied. `isolation.workerModel` injects `defaultModelSelection` so headless containers do not depend on an interactive model picker.
- `isolation.workerMode` defaults to `yolo` for non-plan container turns, because headless CLI turns have no permission client; read-only roles stay on `plan`. `yolo` is warned about explicitly. The container is the isolation boundary, not the permission mode.
- `isolation.bindHost` defaults to `0.0.0.0` in container mode so workers can call back. The API still requires a bearer token, and `/ui` is loopback-only when the bind is non-loopback. `/ui` also requires a per-process access key (delivered once in the URL, then an HttpOnly cookie scoped to that panel port), so another local OS account cannot open it by reaching loopback. `isolation.hostAddress` overrides the detected vEthernet (WSL) address; `containerUrl` is derived from it unless explicitly configured. Config validation rejects a loopback-only `bindHost` in container mode.
- The discovery file contains the admin bearer token. POSIX replaces it atomically through a 0600 temp file; a Windows replace failure can briefly remove the old file before the new one is renamed; on Windows `writeDiscovery` uses the absolute `%SystemRoot%\System32\icacls.exe` with `/inheritance:r /grant:r <current-user>:F` and fails closed if the token file cannot be restricted. The admin token is never placed in the panel URL; the panel URL carries only the per-process UI access key.
- `isolation.network=gateway-only` uses a Podman bridge with NAT and the host gateway, not host networking. Outbound egress is **not** filtered; a prompt-injected worker can reach the network. Host ZCode credentials are copied into each worker home for authentication, so only run this on a trusted host and remove/archive members to purge their homes.
- Verified on this host on 2026-10-30: WSL 2.7.14 + Podman 5.8.3, worker image self-test, container callback via the WSL gateway, a writable `work` task completing through team-cli, and a read-only analyst `verification` task completing through the member MCP in `plan` mode with Bash disabled. Multi-host load remains unverified.

## What this is not

- It is not a conversation-header button. ZCode 0.17 owns that row and exposes no plugin slot; the supported entry is the side-pane plugin tab. The manifest also has no `autoOpen` field: the automatic path is a SessionStart-hook instruction plus the model's first call, not a host popup.
- It does not use Windows UI automation to click ZCode's side-pane "+" button; that would be brittle and is intentionally excluded.
- It does not rely on hidden ZCode subagent APIs; it uses public CLI and protocol surfaces.
- It does not claim production readiness, absolute security, or that every provider/host can sustain 32 concurrent workers.
- It does not replace ZCode's model, tools, or permission system.

## Hard numbers

| Item | Default | Maximum | Notes |
| --- | --- | --- | --- |
| Captain | 1 | 1 | Commands both teams |
| Team | 2 | 2 | One lead per team |
| Shadow / workspace | 0 (on demand) | 1 | Control session; captain-level delegation; not a delivery worker |
| Lead | 1 / team | 1 / team | Control session; not a worker by default |
| Member / team | 16 | 32 (min 8) | Database rows, not processes; roster range 8-32 |
| Total members | 32 | 64 (min 16) | 2 x 8 to 2 x 32 |
| Active workers | 6 | 1-32 by design; up to 64 only with `allowAboveDesignCap: true` | Shared cap; dynamic split by task difficulty (legacy 3/3 when dynamicTeams=false) |
| Active containers | 6 | Same as active workers | Container mode only; each dispatched active worker gets one; worktree mode does not create containers |

**Roster size is not concurrency.** A roster of 8-32 members means rows; only 6 workers run by default. The rest queue.

## Install

See [docs/guides/INSTALL.md](guides/INSTALL.md) for ZIP and source installs. If a user has only the GitHub link, follow [docs/guides/INSTALL-WITH-AI.md](guides/INSTALL-WITH-AI.md): the AI must inspect the host, ask hard/soft isolation, install, ask the user to reboot manually, verify, then offer conservative/balanced presets. No `npm install` is needed at runtime. State lives in `<workspace>/.ai-agent-teams/`.

## Quick start

```bash
npm test
npm run check
npm run validate
npm run plan
npm run recommend
npm run install:detect
```

No runtime dependencies are required. Node.js 22.5+ is required (built-in `node:sqlite`); development checks and packaging use the tools listed in `package.json`.

One-command setup (checks prerequisites and starts the daemon):

```bash
npm run setup
```

`setup` uses the worktree-isolation example config. Run it inside a git repository, or generate `config/local.json` with `node src/install-wizard.mjs --apply ...`; outside git it fails fast instead of silently running tasks in the shared directory.

Run the daemon with the fake adapter (no model calls):

```bash
node src/daemon.mjs --fake --db :memory: --port 43123 --no-loop
curl http://127.0.0.1:43123/api/v1/health
```

For a real ZCode model, use the app-server protocol and set an explicit model and reasoning level (the CLI has no `--model` flag):

```json
{
  "zcode": {
    "protocol": "app-server",
    "defaultModel": "providerId/modelId",
    "defaultReasoning": "max",
    "maxRequestsPerMinute": 8,
    "mode": "build"
  }
}
```

Members created through lazy allocation, `agent_teams_add_member`, or `agent_teams_create` inherit these defaults unless they override `model`/`reasoning`. The daemon automatically selects app-server when either default is set, even if `zcode.protocol` is `cli`; use `cli` only when the CLI's own provider is already configured. Set `maxRequestsPerMinute` to space dispatch starts (for example 8); this is a start pacer, not a hard cap on model turns/tool-loop requests, so a strict provider quota still needs a lower active-session count. `0` disables pacing. Use `mode: "yolo"` only for an explicit unattended test; otherwise use `build` and approve tool calls interactively.

Members mount a member-scoped `agent-teams-member` MCP server (`zcode.memberMcpServers: "minimal"`); the plugin's admin-token MCP server is blocked by an exact-name denylist, so the member token boundary is preserved without loading the full host catalog. Protocol turns are watched through `session/events`; a `turn.failed` provider error closes the attempt and requeues the task with exponential backoff (`zcode.turnFailureRetry`), without waiting for `taskTimeoutMinutes`. A provider `retryAfterMs` hint overrides the local backoff. Capacity/429 failures use a separate budget of 3 retries (4 attempts max), reduce `activeWorkerSlots` before retrying, persist that reduction in `.ai-agent-teams/runtime-capacity.json`, and restore slots one at a time after a cooldown with sustained successes.

For a manual one-shot prompt with a selected model, use the wrapper instead of `zcode -p` (which has no `--model` flag):

```bash
npm run zcode:real -- \
  --model provider-b/model-x \
  --reasoning max \
  --prompt "Reply with exactly OK" \
  --cwd D:\path\to\workspace
```

Real compact/resume lifecycle check (create → prompt → compact → close → resume → prompt):

```bash
npm run zcode:lifecycle -- \
  --model provider-b/model-x \
  --reasoning max \
  --cwd D:\path\to\workspace
```

## Repository map

```text
SPEC.md                 authoritative target specification (19 sections, 51 numbered invariant entries including unimplemented INV-046, 55 counted baseline test IDs)
AGENTS.md               model onboarding, invariants, read order and change protocol
llms.txt                machine-friendly index
docs/status/           STATUS.md, HANDOFF.md, CHANGELOG.md (mutable project state/history)
docs/guides/            install, migration, localization, contribution, constraints, onboarding guides
config/                 JSON Schema, examples, roster, field reference
.zcode-plugin/          ZCode plugin manifest
skills/ commands/     plugin resources
prompts/                captain, shadow, team-lead, member, reviewer, handoff prompts
src/                    daemon, MCP/HTTP adapters, scheduler, domain and service modules
test/                   Node built-in tests
scripts/                repository checks and ZIP packaging
examples/               sample task graph
docs/                   contracts, decisions, roadmap, verification, limits, glossary,
                        test matrix, guides and mutable status records
diagrams/               current Markdown diagrams
tools/                  entrypoint map to the canonical scripts/ directory
CHANGELOG.md            change log
```


## Read order

- Humans: `README.md` -> `SPEC.md` -> `docs/roadmap.md` -> `docs/status/HANDOFF.md`.
- AI agents: `AGENTS.md` -> `docs/status/STATUS.md` -> `docs/status/HANDOFF.md` -> `SPEC.md` sections 1-5 -> `config/README.md` -> `docs/contracts.md` -> `docs/design-v0.6-roster-and-licenses.md`.

## Implementation baseline and verification

The capability bullets below summarize implemented source and dated evidence, not formal release status. The `0.1.11` source baseline was fully verified locally on 2026-11-10; the 0.2.2 worker-image changes have a separate in-progress verification in `docs/status/STATUS.md`. Historical real-model and container runs are called out by date and do not imply current provider acceptance.

- The target design is documented in `SPEC.md`; it is not an implementation or test-coverage report. Current acceptance status is tracked in `docs/test-matrix.md` and `docs/status/STATUS.md`.
- Configuration schema, legacy 16-member roster, and v0.6 preset examples: done.
- SQLite store, daemon, HTTP/SSE, scheduler service, mailbox, halt/resume, staged plan/member lifecycle: implemented and tested with a fake adapter.
- MCP tool layer (37 captain tools, 33 shadow tools, 29 ordinary-member tools; including model policy, continue and shadow controls), ZCode plugin manifest, skill and command: implemented; handler-tested.
- MCP App team card (`agent_teams_view`), native side-pane UI surface, and full `/ui` view: packaged; the current ZCode host maps fullscreen results to the side pane and does not implement picture-in-picture pip.
- Members mount a member-scoped `agent-teams-member` MCP server; the plugin admin server is denied by exact tool name. Same-process `turn.failed` retry with backoff is implemented; a task that turns red gets one hidden automatic review that only sends `继续` (max 3) and then reports to the captain.
- Installer wizard with host/ZIP checks, explicit hard/soft choice, restart verification, and conservative/balanced presets: implemented and unit-tested. Hard dispatch is wired through `ContainerCliSessionAdapter` and a mandatory image/CLI self-test; a seeded worker home plus explicit worker model completed a real container task on 2026-10-30, and a read-only analyst task completed through the member MCP.
- ZCode CLI adapter and member team CLI: implemented; not model-tested.
- Verify runner integrated into completion; review tasks snapshot scope and detect drift.
- Worktree manager, merge queue, and container spec exist; self-bootstrap starts the daemon; Protocol adapter create/send/stop/setModel works; a real container completed a workspace-write `work` task on 2026-10-30; the side-pane surface is declared but a conversation-header button is not available.
- 6/16/32 logical-worker load passes with the fake adapter; a six-worker real-model smoke passed; real 16-way passed 16/16 with `maxRequestsPerMinute=8`; the 2026-10-29 real 32-way run passed 32/32 with pacing and 32/32 unthrottled, and a 48-way unthrottled run passed 48/48 on the backup `provider-a/model-x` endpoint; a persistent-SQLite restart recovered 8 in-progress tasks and 16 sessions, then completed 16/16.
- v0.6 first version is implemented in `config/example.v06.json` and `src/domain/lifecycle.mjs`: 16GB 6+6, 32/64GB presets, lazy members, licenses, settled-only re-license, warm/cold, contractors, post-merge review, and captain patrol. Legacy configs still use 6/3-3. A packaged read-only `/ui` view, the `agent_teams_view` MCP App card, and the native side-pane surface exist; a conversation-header button is still not available.
- Default isolation is **worktree** (soft isolation, no WSL): one worktree per task, member homes, read-only reviewer tools, git-derived changed paths, and the review/merge queue. `GET /api/v1/teams/:id/soft-isolation` checks it. WSL2 + Docker/Podman is optional.
- Historical test snapshot (2026-11-05): 933 Node tests, 930 pass and 3 skipped on Windows. The 0.1.11 source checkpoint recorded 1378/1378 passing with zero skips on 2026-11-10; rerun `npm test` for current 0.2.2 verification. This is test-suite evidence, not installed-plugin or real-provider acceptance.

See `docs/status/STATUS.md` and `docs/status/HANDOFF.md` for the exact gap.

## License

MIT. See `LICENSE`.
