# Install

The release ships two ZIPs:

| ZIP | Use |
| --- | --- |
| `ai-agent-teams-marketplace-v<version>.zip` | Recommended. A ready-to-add local plugin marketplace containing the plugin. |
| `ai-agent-teams-v<version>.zip` | The full source tree: tests, docs, daemon, Dockerfile. |

Release ZIP names use the version recorded by that release; the current checkout is package `0.2.2` but that version is unreleased, while `0.1.8` remains the latest formal release. The bundle is self-contained: no `npm install` is required at runtime. Node.js 22.5+ is required because state uses the built-in `node:sqlite`. Docker/Podman and git are optional for the default worktree mode; container mode requires the host runtime and a passing image self-test.

## Option 0: paste the GitHub link to an AI (required flow)

The supported remote handoff is: the user copies the GitHub URL into ZCode and the AI follows [INSTALL-WITH-AI.md](INSTALL-WITH-AI.md). The AI must:

1. Inspect the computer against the ZIP/runtime requirements and report whether hard isolation is genuinely available.
2. Ask the user to choose hard or soft isolation. Never choose silently.
3. Install the plugin marketplace, ask the user to reboot manually, then run `node src/install-wizard.mjs --verify --restart-confirmed`.
4. Only after verification, show the conservative and balanced presets, ask the user to choose, and run `--apply`.

Success is `phase=complete`; stopping after installation is not success. Hard isolation requires WSL2/Podman or Docker plus a worker image with ZCode; the wizard reports what is missing instead of pretending. The installer never reboots the computer.

## Option A: install the plugin from a ZIP (recommended local path)

1. Extract `ai-agent-teams-marketplace-v<version>.zip`. The extracted folder contains `marketplace.json` and the plugin folder.
2. In ZCode open **Plugin Marketplace -> Add -> Add Plugin Marketplace** and select that extracted folder (the folder containing `marketplace.json`, not the plugin subfolder).
3. Open **Personal -> AI Agent Teams -> Install**.
4. Start a new task. The `agent-teams` MCP server is started by the plugin. If the current workspace has team config, its first tool call auto-starts the team daemon; a folder with no team config falls back to the newest live daemon instead. The source tree currently identifies as `0.2.2` (unreleased); a release ZIP or installed plugin may be a different version, so verify its reported version and `contentOk` rather than inferring parity from the source checkout.

Try:

```text
/agent-teams
```

or ask: "Create a two-team plan for this repository. Start with zero members and materialize roles on demand."

To open the packaged visual team view:

```text
/team-view
```

or say "查看团队". A plugin `SessionStart` hook asks a new captain/UI session to call `agent_teams_view` once; its `surface + fullscreen` result opens the panel in the ZCode side pane. This is model-mediated, not a host popup, and it fires in a team workspace or when a live team daemon exists (the default-workspace fallback); it is skipped in worker sessions and when `AI_AGENT_TEAMS_AUTO_PANEL=0`. If the side pane does not open, the tool text still contains the keyed Markdown `/ui` link. The view receives a read-only live snapshot from the daemon and refreshes over SSE; if the daemon is unavailable it falls back to the built-in static example. Picture-in-picture (`pip`) is not implemented by this host and is not requested.

You can also open the panel directly from the program:

```powershell
npm run panel          # print the live URL and instructions
npm run panel:open     # check the daemon health, then open Edge -> Chrome -> default browser
```

`node src/cli.mjs panel` reads the workspace-specific discovery under `~\.ai-agent-teams\workspaces\<hash>\runtime.json` (legacy `runtime.json` is a mirror), checks `/api/v1/health` version/workspace/identity, and refuses to open a dead or different-workspace daemon. The panel is loopback-only and never puts the bearer token in the URL. The daemon prints the same URL/hint at startup, and the MCP `initialize` response includes it in `instructions`.

State is stored in `<workspace>/.ai-agent-teams/state.db`; it is never written into the plugin folder.

## What "worktree" means

A **worktree** is a separate working folder for one task, created from your git repository. Think of it as giving each task its own copy of the project on its own branch: the engineer edits there, the reviewer reads there, and the merger brings the approved commit back.

中文：**worktree 就是给每个任务开一个独立的工作目录**，像从你的 git 仓库复制一份项目出来，队员各改各的，不会互相覆盖文件。它只隔离文件，不是安全隔离，也不防恶意代码。

- `worktree`: file separation only. No WSL/Docker required.
- `container`: one container per active worker; needs WSL2 + Docker/Podman. Stronger, but still shares the host kernel.
- `microvm`: stronger boundary; advanced/not bundled.
- `none`: no isolation; local debugging only.

## Option B: run from source

```bash
# Node 22.5+
node --version
npm test
npm run check
npm run install:detect # check host, virtualization, WSL, Docker/Podman, memory/disk
npm run install:plan -- --team-mode single --preset balanced
npm run recommend      # memory-based presets; records that ZCode does not expose a max-subagent value
npm run setup          # checks prerequisites and starts the daemon (v0.6 config)
node src/daemon.mjs --fake --db :memory: --port 43123 --no-loop
```

`npm run setup` is optional: the MCP server calls the same bootstrap automatically. It requires a git workspace because the example config uses worktree isolation; non-git workspaces fail fast with an explicit error. Use `npm run package` to regenerate both release ZIPs under `dist/`.

## Real model configuration

The ZCode CLI has no `--model` flag. For real model sessions, use the app-server protocol and set both a model and its reasoning level:

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

Lazy members created by dispatch, `agent_teams_add_member`, and `agent_teams_create` inherit these defaults unless the member overrides `model`/`reasoning`. The daemon automatically selects app-server when either default is set, even if `zcode.protocol` is `cli`; use `cli` only when the CLI's own default provider is already working. Set `maxRequestsPerMinute` to space dispatch starts (for example 8); this is a start pacer, not a hard cap on model turns/tool-loop requests, so a strict provider quota still needs a lower active-session count or provider-side rate limiting. `0` disables pacing. `mode=yolo` is for explicit unattended testing only; it bypasses interactive tool approval.

`zcode.memberMcpServers` is fixed to `minimal`: each member session receives a member-scoped `agent-teams-member` MCP server, not every MCP configured in ZCode. The plugin's admin-token server may still be discovered by ZCode 0.17, so its exact tool names are denied; the full host catalog is intentionally unsupported because it would bypass the member token boundary and add large context cost. `zcode.turnFailureRetry` controls same-process retries for a `turn.failed` event: `maxAttempts` (default 3 retries; the fourth failure exhausts the normal budget), `capacityMaxAttempts` (default 3 retries for 429/rate-limit/capacity errors, which also reduce `activeWorkerSlots` before retrying), `baseDelayMs` (3000), `maxDelayMs` (60000), `capacityRecoveryMs` (60000, cooldown before recovery), and `capacityRecoverySuccesses` (3 consecutive successful turns per restored slot). A provider `retryAfterMs` hint overrides the base delay, capped at one hour. Reduced capacity is persisted in `<workspace>/.ai-agent-teams/runtime-capacity.json`. `zcode.turnWatchIntervalMs` controls the `session/events` poll interval (default 2000). This is separate from the 120-minute task lease and lets a provider rate-limit failure return to the queue in seconds.

For manual one-shot prompts, use the app-server wrapper because `zcode -p` has no model selector:

```bash
npm run zcode:real -- \
  --model providerId/modelId \
  --reasoning max \
  --prompt "Reply with exactly OK" \
  --cwd D:\path\to\workspace
```

## Optional: merge queue

Completed tasks that live in a git worktree can be committed and cherry-picked through:

```text
POST /api/v1/teams/:teamId/tasks/:taskId/merge
```

The merge queue commits to an integration branch, runs the configured post-merge review, and fast-forwards the base branch only after approval. A rejection discards the integration branch and creates an internal repair task; it never force-merges.

## Optional: container image

`deploy/worker.Dockerfile` is configured to build a Linux ZCode CLI/runtime from pinned upstream tag `v3.17.2` (commit `a9fe401eede6e6e5e01be9048679c206fe6f02d9`) as part of the hardened image build (non-root uid 10001, read-only root, dropped capabilities). It does not use desktop AppImage/DEB/RPM packages. Changing the CLI requires changing the pinned source revision and rebuilding the image. The Dockerfile and daemon each fail closed if `zcode --version` does not run as the worker user; this source's build has not yet passed runtime verification.

The optional `isolation.imagePullPolicy` applies at daemon startup before that self-test: `never` (default) uses only the local image, `if-missing` pulls the configured image only when it is not present, and `always` pulls it every startup. Use a trusted registry reference to enable pulling; pulling a tag updates that image only and does not discover or guarantee the latest ZCode CLI. Under `if-missing`, if inspection cannot confirm that the image is absent because of a runtime, permission, or transport error, preparation aborts without pulling. Pull errors abort startup; the daemon never falls back to a stale local image. The package does not publish a worker image.

```bash
docker build -f worker.Dockerfile -t ai-agent-teams-worker deploy
```

Container dispatch is wired through `src/session/container-cli.mjs` and gated by a real image/CLI self-test. A real container completed a workspace-write `work` task on 2026-10-30 with WSL2 + Podman. Hard isolation also needs a worker login/model profile:

- `isolation.homeSeed`: host ZCode profile directory (normally `~/.zcode/v2`). Only `credentials.json`, `provider_config.json` and `setting.json` are copied into each member home.
- `isolation.workerModel`: `{providerId, modelId, reasoningLevel}`; injected as `defaultModelSelection`.
- `isolation.workerMode`: defaults to `yolo` for non-plan container turns because headless CLI has no permission client; read-only roles use `plan`. This is warned about because it auto-approves tools inside the container.
- `isolation.bindHost` defaults to `0.0.0.0` in container mode; the API uses bearer auth and `/ui` is loopback-only. `isolation.hostAddress` overrides the detected WSL vEthernet address; `containerUrl` is derived unless explicitly set.
- `gateway-only` uses a Podman bridge/NAT, not host networking; outbound egress is not filtered. Worker homes contain a copy of host ZCode credentials, so only use this on a trusted host; removing/archiving a member purges its home.

See `deploy/README.md` and `docs/known-limits.md` for the remaining read-only and multi-host limits.

## Installer flow

The required AI/GitHub flow is four stages, not a single install switch:

1. **Inspect**: run `node src/install-wizard.mjs --inspect --workspace "<workspace>" --github "<url>"`. It checks Windows, Node >= 22.5, `node:sqlite`, git, memory, disk, admin, virtualization, WSL2, Podman/Docker and ZCode; it reports host prerequisites for hard isolation; the worker-image/CLI self-test runs when the user actually chooses hard.
2. **Choose isolation and install**: ask the user to choose hard or soft. `--choose-isolation soft` continues; `--choose-isolation hard` requires an explicit `--runtime podman|docker`; the wizard asks the user to choose Podman Desktop or Docker Desktop, then checks the runtime and worker image. Missing prerequisites or a failed self-test return a structured error with repair steps. Install the plugin marketplace, then ask the user to reboot manually.
3. **Verify after restart**: `node src/install-wizard.mjs --verify --restart-confirmed --workspace "<workspace>"`. Success is `phase=awaiting-preset-choice`; failed checks must be fixed and re-verified.
4. **Choose a preset**: `node src/install-wizard.mjs --presets`, show both conservative and balanced options, then `node src/install-wizard.mjs --apply --preset conservative --workspace "<workspace>" --write "<workspace>/config/local.json"`. Only `phase=complete` is success.

```bash
npm run install:inspect -- --workspace "<workspace>"
npm run install:choose -- --isolation soft --workspace "<workspace>"
# user reboots manually
npm run install:verify -- --restart-confirmed --workspace "<workspace>"
npm run install:presets -- --workspace "<workspace>"
npm run install:apply -- --preset balanced --workspace "<workspace>" --write "<workspace>/config/local.json"
```

`buildInstallPlan` writes `isolation.mode=container` only when the user chose hard; container mode still requires the runtime, worker image and self-test to pass. The older `install:detect` / `install:plan` commands remain available for host diagnostics and direct plan generation. For a direct plan, `node src/installer.mjs --plan --image-pull-policy <never|if-missing|always>` overrides the generated config's worker-image pull policy; the default remains `never`.

### Container runtime options shown to the user

| Option | Price | Recommendation |
| --- | --- | --- |
| **Podman Desktop** | 免费 / open source (Apache-2.0) | **Recommended.** Free, provides a Windows `podman` command. |
| Docker Desktop | 个人/小规模通常免费，商用可能付费 | Easiest, but the user must confirm Docker's subscription terms for commercial use. |
| WSL2 + Docker Engine | 免费 / open source | Advanced; needs a `wsl-docker` adapter on Windows. Not a normal installer option in this version. |

The installer must display the price/free label and the license note; it must not silently choose Docker Desktop for a commercial user. If the user declines both runtimes, fall back to soft isolation.

## v0.6 defaults

New installs use `config/example.v06.json`: zero workers at team creation, role materialization on demand, 16GB 6+6 / 32GB 8+8 or 10+10 / 64GB 12+12 or 16+16 presets, licenses, warm/cold sessions, one-shot contractors, and captain patrol. Legacy `config/example.two-teams.json` keeps the 6/3-3 behavior.

**Soft isolation is the default.** It needs only git: one worktree per task, independent member sessions/homes, read-only tool policy for reviewer/analyst roles, git-derived changed-path checks, and the review/merge queue. It is file separation and mistake containment, not a security boundary. WSL2 + Docker/Podman is an optional stronger tier.

Admin endpoint for a soft-isolation self-check:

```text
GET /api/v1/teams/:teamId/soft-isolation
```

Useful endpoints after startup:

- `GET /api/v1/teams/:id/lifecycle` and `POST /api/v1/teams/:id/lifecycle/tick`
- `POST /api/v1/teams/:id/members/:id/sleep|wake|compact|relicense`
- `GET/POST /api/v1/teams/:id/contractors`
- `POST /api/v1/teams/:id/patrol`

Sleep/wake is available without Docker. A packaged read-only `/ui` team view is included via `/team-view` (live snapshot + SSE), and the plugin declares a native side-pane UI surface that opens the same panel as a tab. ZCode 0.17 has no conversation-header button slot, so this version does not add one.

## Prerequisites

| Requirement | Needed for | If missing |
| --- | --- | --- |
| Node.js >= 22.5 | everything (`node:sqlite`) | setup exits with a clear error |
| git | worktrees, merge queue | the installer reports soft isolation unavailable and provides repair steps; worktree-mode setup fails fast rather than silently downgrading to `none` |
| Docker or Podman | container image experiments | worktree isolation; not an install failure |
| ZCode desktop | plugin host and model sessions | the source tree still runs with `--fake` |

## Reset and upgrade

- Reset state: stop the daemon, delete `<workspace>/.ai-agent-teams/`.
- Upgrade: install the newer marketplace ZIP over the old plugin; workspace state is preserved.
- Uninstall: remove the plugin in **Settings -> Plugins**, then delete the workspace state folder.
- Discovery file: `~/.ai-agent-teams/workspaces/<workspace-hash>/runtime.json` (per workspace) plus the legacy `~/.ai-agent-teams/runtime.json` mirror; both contain the port and bearer token.
- Long-running installs also accumulate stale per-workspace discovery folders and member homes under `~/.ai-agent-teams/`. Do not fix that by reinstalling the plugin or deleting `state.db`; follow the supported cleanup order in `docs/known-limits.md` (AI-facing summary: `skills/agent-teams/SKILL.md`, section "Housekeeping: old session records").

## Troubleshooting

- **`node:sqlite` unavailable**: upgrade to Node 22.5+; Node 20 cannot run the store.
- **MCP tools missing**: confirm the plugin is enabled and its detail view lists the `agent-teams` MCP server, then start a new task so the MCP server is launched.
- **Daemon not starting**: run `npm run setup` from the source tree and read its JSON prerequisite report.
- **No conversation-header team button**: the host does not expose that contribution slot. The packaged plugin does declare a session side-pane surface; `/team-view` and the MCP App remain available, and the daemon exposes the HTTP/SSE API in `docs/contracts.md`.
