# Verification record

This file is a chronological evidence log, not a single current verification report. The dated entries preserve their original host, package and test snapshots; do not rewrite those results as current evidence.

## Current local source checkpoint - 0.2.2 (2026-11-11, in progress)

- Source/package/plugin/marketplace metadata is 0.2.2 (unreleased); latest formal release remains 0.1.8.
- Upstream ZCode `v3.17.2` resolves to commit `a9fe401eede6e6e5e01be9048679c206fe6f02d9`. Its supported `apps/zcode-cli` `build:sea` entrypoint rebuilds CLI dependencies and bundle and emits all six documented SEA targets; the Dockerfile uses that existing all-target flow, then selects the Linux x64/arm64 artifact. A separate single-target CI script described by upstream CI documentation is absent from this pinned commit, so no custom single-target dependency graph is claimed. Upstream docs warn that cross-packaging is not target runtime validation. The v3.17.2 GitHub release lists macOS and Windows assets, not Linux binaries.
- Four Podman attempts against the earlier Dockerfile revision (initial plus three exact retries, including one with host proxy variables unset) stopped before build-container creation while pulling `node:24.14.0-bookworm-slim`, because the Podman VM proxy at `<local-proxy>` refused. After the Dockerfile switched to the upstream all-target `build:sea` entrypoint and added `tar`/`xz-utils`, a fifth attempt against the final recipe also exited 125 at the initial base-image pull for the same proxy refusal; no build container started. No upstream source was fetched and `zcode --version` has not run. Linux worker runtime acceptance is pending; do not infer success from the Dockerfile contract test.
- `test/worker-image.test.mjs` provides isolated static checks for source pin, root install and upstream `build:sea` invocation, Linux target mapping, artifact/notice paths, non-root self-test and no entrypoint; it is not a Docker/Podman build or asset-completeness proof. Focused image tests pass 2/2. `npm test` and `npm run test:coverage`: 1394 pass, 0 fail, 0 skipped; coverage 90.67% lines / 78.59% branches / 90.35% functions. `npm run lint`, `npm run check` (313 files), `npm run check:i18n` (1443/1443), `npm run check:assets`, `npm run validate`, `npm run plan`, `npm run audit:deps` (0 vulnerabilities), and targeted `git diff --check` pass. Independent final review is pending.

## Historical local source checkpoint - 0.1.11 (2026-11-10)

- Package/source metadata at that checkpoint: `0.1.11` (unreleased); latest formal release: `0.1.8`. This does not assert installed-plugin parity or publication.
- `npm test`: 1378 tests, 1378 pass, 0 fail, 0 skipped (Windows; the repository's normal test temp isolation).
- `npm run test:coverage`: 1378 pass, 0 fail, 0 skipped; 90.80% lines, 78.68% branches, 90.33% functions (loaded source files). Raw output: `.tmp/2026-11-10-scheduler-final-acceptance/current-doc-audit-coverage.log`.
- `npm run check`: `CHECK OK` (308 files, 19 SPEC sections, 14 example tasks); `npm run lint`, `npm run check:i18n` (1443/1443), `npm run check:assets`, `npm run validate`, `npm run plan`, `npm run audit:deps` (0 vulnerabilities), and `git diff --check` passed.
- Documentation relative links resolve. This check did not repeat real-provider or installed-plugin acceptance.

## Historical local source checkpoint - 0.2.1 (2026-11-11, quality gates and final independent acceptance passed)

- Source/package/plugin metadata at that checkpoint: `0.2.1` (unreleased); formal release remains `0.1.8`.
- Container invocation clears the image entrypoint. A temporary, network-disabled Podman container confirmed that an explicit empty entrypoint allows direct command execution. The local worker image has no `zcode`, and its Node binary is not executable in this Windows-hosted Podman environment; hard-isolation self-test remains fail-closed.
- Focused container/config/installer/install-wizard tests: 95/95 pass, zero failures/skips. `npm test`: 1392/1392 pass, zero failures/skips. `npm run test:coverage`: 1392/1392 pass, zero failures/skips; 90.73% lines, 78.64% branches, 90.35% functions.
- `npm run lint`, `npm run check` (`CHECK OK`, 312 files, 19 SPEC sections, 14 example tasks), `npm run check:i18n` (1443/1443), `npm run check:assets`, `npm run validate`, `npm run plan`, `npm run audit:deps` (0 vulnerabilities), and staged/unstaged `git diff --check` passed. Git emitted only LF-to-CRLF conversion notices.
- Independent reviews scored 4.3/4.3 and then 4.4/4.3; their findings were addressed. Final independent acceptance passed at 4.8/5 overall and 4.7/5 code with no P1–P4 findings. The final reviewer performed a read-only source/test/doc audit and did not rerun commands; the test and gate results above are the implementation agent's actual runs. Official Linux install docs list desktop AppImage/DEB/RPM but do not document headless CLI support or an official worker image/update source. No end-to-end Linux worker acceptance is claimed.

## Historical verification baseline - 2026-10-28 to 2026-10-31

Host: Windows 11, ZCode CLI 0.17.0, Node 24.21.0. Formal package at this checkpoint: 0.1.8. Older observations below apply only to their named baseline.

## Verified facts

### 1. Headless prompt + JSON

Command:

```bash
zcode -p "Reply with exactly OK" --json --mode plan --cwd <workspace>
```

Observed:

- `sessionId`, `turnId`, `response`, `usage`, `projection` returned.
- `usage` included input/output/total tokens.

### 2. Resume retains context

Command:

```bash
zcode -p "What single word did I ask you to reply with?" \
  --resume sess_... --json --mode plan --cwd <workspace>
```

Observed response: `OK`.

### 3. CWD switch on resume

Created `probe-worktree/probe.txt` containing `PROBE123`, then resumed the same session with `--cwd <probe-worktree>` and asked it to read the file.

Observed response: `PROBE123`. This proves a resumed session can run in a different working directory, which is the basis for per-task worktrees.

### 4. Per-run tool restriction

`zcode --help` confirms `--disallowed-tools` / `--disallowedTools` is per run and does not change saved settings.

### 5. No `--model`

`--model` returns `Unknown option '--model'`.

The ZCode Protocol exposes `session/setModel` and `session/setThoughtLevel`, so per-member model selection must use the protocol, not the CLI flag.

### 6. Protocol method map

Observed in the ZCode 0.17.0 application bundle (2026-10-26):

```text
session/create, session/resume, session/send, session/stop,
session/cancelBackgroundTask, session/setModel, session/setThoughtLevel,
session/setMode, session/fork, session/compact, session/goal, session/close,
session/events, session/subscribe, session/messages, session/subagents
```

`session/send` delivery supports `startNow | queue | guide`; `guide` can inject at the next model step and may fall back to queue.

### 7. Environment gaps

At the initial 0.1.0 measurement, Docker/WSL/Hyper-V/Windows Sandbox were not enabled. As of 2026-10-30 this host has WSL2 + Podman and completed real container tasks (sections 24 and 26); the older note is retained only as history.

## 8. Backend smoke (fake adapter)

Command:

```bash
node src/daemon.mjs --fake --db :memory: --port 43123 --no-loop
curl http://127.0.0.1:43123/api/v1/health
```

Observed: `{"ok":true,"data":{"status":"ok","version":"0.8.0-alpha.3"},"error":null}`. The daemon wrote a discovery file and used the fake adapter.

## 9. Test suite

`npm test`: 339 tests, 337 pass, 2 skipped on Windows (symlink test requires privilege).

SSE checks: pending cross-team mail is redacted before approval; member inbox and pending/approve routes are gated.

Dynamic/mail checks: dynamic dual-team allocation uses a total cap and demand weights; A↔B mail stays pending until captain approval; full-access auto-approves.

Contractor slot checks: one active merge slot and one active main slot; a second request queues in its own slot; a saturated main slot does not borrow the idle merge slot; killing a contractor releases only its slot and starts that slot's queue. `npm run check`: 176 required files (updated 2026-11-07; 137 before the git/service split), 19 SPEC sections, 14 example tasks. `npm run lint` uses the minimal ESLint config (unused vars, undefined names, unreachable code) for `src`, `scripts`, `test` and `ui-src`. `npm run test:coverage` enforces loaded-source lines >= 79%, branches >= 63%, functions >= 79%; current measured range is 89.0–89.7/76.4–76.7/88.8–89.4 across runs (unloaded entry points are not counted). `npm run audit:deps` must be re-run on a host that can reach the npm registry; it could not complete on 2026-11-07 because the local proxy refused the connection, so no audit verdict is claimed for that run.

`docs/test-matrix.md`: 23 covered / 14 partial / 19 not covered.

## 10. ZCode Protocol probe

`app-server` accepts `{id, method, params}` messages (no `jsonrpc` field). `runtime/capabilities` and `session/list` worked. `session/create` requires `workspace: { workspacePath, workspaceKey }`. A live session was created, `session/send` returned `{accepted:true}`, `session/stop` returned `{}`, and `session/setModel` accepted `{providerId, modelId, options:{reasoningLevel}}`. The adapter is implemented in `src/session/protocol.mjs`.

## 11. Release bundles

`npm run package` emits the source ZIP and a local marketplace ZIP (`marketplace.json` + plugin folder). Both are extracted and verified independently; the ZIPs contain no state database and no workspace state files (documentation may still contain example handoff paths). The marketplace bundle was loaded from its installed plugin path: MCP initialize reported `ai-agent-teams 0.8.0-alpha.3` (alpha.3 baseline), `tools/list` returned 30 tools at that alpha.3 baseline (current source catalog: 37 captain / 33 shadow / 29 ordinary member; not a fresh installed-plugin probe), and the auto-started daemon wrote state under the workspace, not the plugin folder. `GET /ui` is covered by `test/http.test.mjs`: it serves `assets/team-view.html` as `text/html` for GET and HEAD without API auth. The same test verifies the injected bootstrap, `/api/v1/ui/snapshot` with a read-only `uiToken`, and sanitized output (no `licenseId`).

The `0.8.0-alpha.3` baseline bundles use UTF-8 entry names and forward slashes; Python `zipfile.testzip()` passes. Internal workspace-note and diagram folders are excluded from the release ZIP. Packaged `assets/team-view.html` SHA-256 is `823e907a33ef7d7020d8fbc180f5dcc45d958796b0a1be6ac61ac746f2dc4277`. ZIP hashes are recorded in `dist/*.sha256`.

Additional alpha.3 verification: the installer CLI resolves `--workspace` before host detection; `buildInstallPlan` rejects explicit soft isolation for a non-git workspace and falls back to `isolation.mode=none` when no isolation was chosen; the daemon refuses to start in `worktree` mode outside a git repository; discovery records the workspace so `ensureDaemon` does not reuse a daemon from another workspace; member MCP status omits the admin audit and hides the two panel tools; member/contractor tool denylists cover the plugin server prefix; `turnCursor` failure and watcher terminal errors enter the retry path instead of waiting for the lease. The installed plugin tree digest now covers `package.json`, `src`, `assets`, `config`, `skills`, `commands`, `agents`, and `.zcode-plugin`.

Live UI check: a seeded in-memory daemon was served at `GET /ui`; the page rendered three live tasks/members with the `实时` pill, then adding a fourth task through `POST /api/v1/teams/alpha/tasks` triggered `/api/v1/ui/stream` SSE and the page reloaded to four tasks with updated counts. Empty-task and zero-member live states were also checked (no static 24-task/5-member fallback while a bootstrap is present); live overview/dual headers, member stats, detail context and contractor slot cards are rebuilt from the snapshot. The HTTP test also verifies that the UI token is rejected by team detail and task update routes and that `/api/v1/ui/stream` requires a token.

## 12. v0.6 first version

- `config/example.v06.json` enables lazy members, licenses, compression, contractors, patrol and post-merge review.
- Tests cover zero-member team creation, role materialization, settled-only re-license, warm/cold/wake, one-shot contractor, post-merge pass and reject/repair, captain patrol, 429 downgrade, integration branch fast-forward, HTTP/MCP routes.
- `npm run recommend` reports 16/32/64GB conservative/balanced presets and records that ZCode 0.17.0 does not expose a max-subagent value.
- Verified live protocol lifecycle: `scripts/zcode-lifecycle.mjs` creates a real app-server session with `provider-b/model-x`, waits for `turn.completed`, calls `session/compact` and waits for the compact turn (`response="Compacted"`), closes the session, calls `session/resume`, then sends a second prompt and receives `RESUMED`. This also verifies that a resumed session retains its member/token record in the adapter. Not verified: multi-host load, app-server RSS release after close, and a conversation-header button (the packaged `/ui` live snapshot and native side-pane surface are tested above). Hard container execution is verified for writable work tasks in section 24; read-only MCP completion is verified in section 26. The 2026-10-29 32-way retest is recorded in section 19.

## 13. Soft isolation default

- Default `isolation.mode=worktree`; no virtualization needed.
- Reviewer/analyst sessions are launched with `mode=plan` and disabled Edit/Write/ApplyPatch/Bash in the CLI adapter; the daemon uses a fake adapter in tests to verify the contract.
- Changed paths are derived from `git status` + `git diff` rather than self-reported; license `pathScope` and task `inScope` are checked before completion.
- `GET /api/v1/teams/:id/soft-isolation` verifies worktree mode, member homes, member-scoped tokens, read-only policy and distinct worktrees.
- This is mistake containment, not a security boundary; a malicious same-user agent can still read host files/network.

## 14. Load harness

`node scripts/load-test.mjs --workers 6|16|32` uses the fake adapter, 2 teams, 16-member rosters, and 6 active slots. Observed: 6/6, 16/16, 32/32 tasks dispatched and completed; audits `ok: true` for both teams. This is orchestration load, not real-model load.

`node scripts/load-test.mjs --workers 6|16|32 --v06` uses `config/example.v06.json` and lazy members. Observed: 3, 8, and 16 members per team materialized on demand; all tasks dispatched and completed; audits `ok: true`. This verifies lazy materialization and slot allocation, not real model concurrency.

## 15. Host-aware installer

`node src/installer.mjs` on this host detects Windows build 26200, 32GB RAM, 563GB free, admin, `HypervisorPresent=true`, `VirtualMachinePlatform=1`, WSL absent, Docker/Podman absent. Recommendation: `wsl / install-wsl`, effective isolation `worktree`, with `canChooseSoft=true`. `install:plan --team-mode single|dual --preset conservative|balanced` produces a validated config; 16/32/64GB single/dual presets are covered by `test/installer.test.mjs`.

`CONTAINER_DISPATCH_READY` is `true` now that the adapter, daemon wiring and self-test exist; the installer refuses hard isolation until the runtime, worker image, seed home/model and self-test pass. Hard container execution is verified for writable work tasks (section 24).

## 16. Real model six-way smoke (2026-10-28)

The local plugin marketplace was installed in ZCode and the `ai-agent-teams` plugin loaded its 30 MCP tools. A real app-server test used two teams, three members and three tasks per team, `provider-b/model-x`, `reasoning=max`, and explicit `yolo` for unattended tool execution. All six tasks dispatched and completed with `output=OK`; both delivery audits returned `ok: true`; elapsed about 64.5 seconds. A second six-way run using only `zcode.defaultModel`/`zcode.defaultReasoning` (no explicit member model) also completed 6/6 with both audits `ok` in about 93.4 seconds. A real one-shot contractor inherited the default model/reasoning, returned `result=OK`, and recorded token usage. The manual `scripts/zcode-real.mjs` wrapper also returned exactly `OK` through app-server. The CLI adapter's default provider returned `PROVIDER_CREDENTIALS_UNAVAILABLE`; use the app-server protocol and explicit model/reasoning for real runs.

## 17. Real 16/32 load (2026-10-28)

Real app-server runs used 2 teams and 16/32 tasks, `provider-b/model-x`, `reasoning=max`, `mode=yolo`. An unthrottled 16-way run completed 14/16 tasks (2 stuck, 12.5%) in 466,767 ms with 14,207,522 reported tokens; Alpha audit failed, Beta passed. An unthrottled 32-way run completed 27/32 (5 stuck, 15.6%) in 676,428 ms with 12,919,045 readable tokens; both audits failed. Logs show provider `group requests-per-minute limit exceeded`. With `zcode.maxRequestsPerMinute=8`, the 16-way run completed 16/16 with both audits `ok` in 217,600 ms and 16,165,247 tokens; the 32-way run completed 28/32 (4 stuck, 12.5%) in 834,764 ms and 11,302,796 tokens. A clean 32-way run still needed a lower QPS or a higher provider quota at that time (superseded by section 19). A persistent-SQLite restart test stopped service with 8/16 tasks `in_progress`, recovered 8 tasks and 16 member sessions, then completed all 16 tasks with both audits `ok`. Details: `docs/verification.md`.

## 18. MCP App, member MCP scoping, turn retry and install wizard (2026-10-28)

- `agent_teams_view` is registered with `_meta.ui.resourceUri=ui://ai-agent-teams/panel.html`, surface `ai-agent-teams`, visibility `model+app`, and `preferredDisplayMode=fullscreen` (a later 0.1.7 change; this bullet records the original 0.1.0 metadata). `resources/list` and `resources/read` serve the 673 KB self-contained panel. The panel has a header `打开任务` button and a footer link, both opening `/ui#tasks`; the tool also returns a Markdown link fallback. The two view tool results include `structuredContent` plus `viewUrl`; the other tools return text content.
- The daemon prefers port `8779`; `listenWithFallback` retries on `EADDRINUSE` with an OS-assigned free port and publishes it in discovery. `agent_teams_view`/`viewSnapshot` retries once through `ensureDaemon` when discovery is missing or the daemon connection is refused. `test/port.test.mjs` verifies the occupied-port fallback.
- ZCode 0.17's MCP App renderer hard-codes `availableDisplayModes` to `inline|fullscreen`; it does not expose `pip`. This 0.1.0 entry requested pip as forward-compatible metadata; 0.1.7 declares `fullscreen` instead and makes no pip request. Whether the host opens the side pane from that declaration is a fresh-session observation (see section 28), not a code-level guarantee.
- `ProtocolSessionAdapter.create` sends an explicit `mcpServers` array containing the member-scoped server `agent-teams-member`; unit tests assert the server name and member token/team/member environment. ZCode 0.17 may still discover the plugin admin server, so member sessions deny `mcp__plugin_ai-agent-teams_agent-teams__*`, and contractor sessions deny every name shape (`agent_teams_*`, `mcp__agent-teams__*`, `mcp__agent-teams-member__*`, and the plugin prefix) with the single documented exception of `agent_teams_continue_task` on the member server (`contractorContinueDenylist`, see `docs/contracts.md`). Unit tests assert all 34 captain tools across these prefixes (member catalog: 29; the count was 31/28 before `agent_teams_continue_task` and the two view tools were added — updated 2026-11-01, review-A-AUTO-RETRY F7); an empty mcpServers array alone is not treated as an MCP-disable guarantee.
- Tool-denylist evidence (2026-11-01, review-A-AUTO-RETRY F3): the denylist reaches the adapter as `toolDenylist` (protocol) / `--disallowed-tools` (CLI) and that payload is covered by `test/protocol.test.mjs` and `test/cli.test.mjs`. The member/contractor catalogs themselves are **not** filtered server-side, so `tools/list` still lists the member catalog; the effective contractor surface is the denylist plus the contractor-token HTTP scope (`403 E_FORBIDDEN` outside `tasks/:id/continue`, covered by `test/auto-retry.test.mjs`). Host-side enforcement of `toolDenylist` belongs to the ZCode session contract and was not re-verified end-to-end in the repair run (no real member session was spawned), so it is not claimed as verified here.
- `session/events` polling for `turn.failed` is unit-tested; the scheduler forwards `error.message`, `error.code`, `error.type`, `retryable`, and the normalized `retryAfterMs` to its retry path. Capacity classification prefers structured codes/types, suppresses keyword matches for clear non-capacity codes and filesystem messages such as `EMFILE`/`ENOSPC`, and treats a positive retry hint as capacity; unit tests cover those branches. `retryable: false` is terminal immediately. A four-failure test verifies normal retry then terminal failure at `maxAttempts=3`; a capacity-failure test verifies both message-only and structured-code errors reduce `activeWorkerSlots`, retry under `capacityMaxAttempts=3`, then fail, close the attempt, and return the member to idle. A retry-hint test verifies `retryAfterMs` sets `retryNotBefore` and is preserved in task events; a dispatch-error test verifies one retry slot is consumed and the next tick does not immediately resend. CLI tests verify JSON provider errors expose `code`/`type`/`retryAfterMs`, nonzero exits preserve JSON fields from stdout, plain-text stderr preserves the message and known codes (including non-retryable `insufficient_quota`), and the scheduler keeps structured fields from a failed send. Cursor tests verify three transient `session/events` failures are retried without failing the task. A dead-session test verifies `Session is not active` clears the member session and the next attempt creates a fresh app-server session. Persistence tests verify the reduced slot count survives a service restart, is restored only after the cooldown plus the configured consecutive-success count (including a zero-cooldown configuration), is ignored when it exceeds the ceiling or was written for a different configured slot count, clamps untrusted success/recovery fields, and rejects corrupt JSON. The scheduler watcher uses a one-shot latch so a completed callback cannot be replayed after a failure, and the protocol watcher returns after the first terminal event.
- `src/install-wizard.mjs` is unit-tested for: hard isolation unavailable, soft choice -> restart-verification phase, preset gating, conservative/balanced generation, and complete config write. The `--inspect` question now always includes both isolation options with `requirements` and `repairSteps`; choosing hard while unavailable returns `HARD_ISOLATION_UNAVAILABLE` plus the WSL2/Podman/Docker repair steps instead of silently falling back to soft. Hard container dispatch is verified for writable work tasks and read-only MCP completion (`src/session/container-cli.mjs`, daemon self-test, seeded home/model, member MCP config).

## 19. Real 32-way retest (2026-10-29)

`npm run real:load` (`scripts/real-load.mjs`) starts an in-process HTTP API bridge, creates 2 teams x 16 lazy members, dispatches 32 work tasks, and lets the members claim/complete them through the member MCP server. The run uses `provider-a/model-x`, `reasoning=max`, `mode=yolo`, `isolation.mode=none`.

- Paced (`maxRequestsPerMinute=8`): 32/32 completed, 0 failed, 0 unfinished, 32 attempts, 0 failed attempts, 355,491 ms, readable tokens 427,667 (lower bound), both audits `ok`.
- Unthrottled (`maxRequestsPerMinute=0`): 32/32 completed, 0 failed, 0 unfinished, 34 attempts, 2 failed attempts, 394,123 ms, readable tokens 460,514 (lower bound), both audits `ok`. Both failed attempts were on task `beta-4` with `session/events` cursor timeouts, not provider RPM; `member.session_reset` ran twice and the task completed on a fresh app-server session.

The primary `provider-b` endpoint failed a connectivity probe during this run, so both results use the backup `provider-a` endpoint. Details: `docs/verification.md`; raw JSON: `docs/verification.md`, `docs/verification.md`.

## 20. Provider quota, 48-way load and quality gates (2026-10-29)

- Provider probe: `provider-b` returns 403 `PROVIDER_CREDENTIALS_UNAVAILABLE` for both `/models` and `/chat/completions`; `provider-a` returns 200. All real-load results below use the backup `provider-a` endpoint.
- 48-way unthrottled (`maxRequestsPerMinute=0`, 24 tasks per team): 48/48 completed, 0 failed, 0 unfinished, 66 attempts, 13 failed attempts, 999,831 ms, audits `ok`. The provider returned `model_rate_limited` (`status=429`, `retryable=true`, 21 requests/minute); the scheduler emitted one `concurrency.reduced` and one `concurrency.recovered`, 13 `task.turn_failed`/`task.retry_scheduled`, 11 `member.session_reset`, and 5 `task.stalled`; every task eventually completed.
- Real CLI: `zcode -p ... --json` follows the default provider order and hits the same `provider-b` 403 (`Turn execution failed`). `CliSessionAdapter` preserves the failure message and enters the retry path, but a successful real CLI model call is not verified because the default provider has no active subscription.
- Multi-daemon (updated 0.1.4): two daemons on ports 43901/43902 with separate workspaces, tokens and in-memory databases both returned health 200 and kept separate teams. Discovery is now workspace-specific, so each workspace reads its own record; the legacy `runtime.json` mirror follows the most recent daemon and is not used by workspace-aware consumers. Multi-host load was not run (no second host, WSL/Docker unavailable).
- Post-split regression: 2-way real smoke 2/2; 16-way paced 16/16 with audits `ok` in 225,152 ms. Unit tests at that point were 262 (260 pass, 2 skip); coverage thresholds enforced at loaded-source lines 79% / branches 63% / functions 79% (measured 79.80% / 64.27% / 80.90%); `npm run lint` has zero errors; `npm run audit:deps` reports zero high/critical vulnerabilities.

## 21. Persistent 8779 daemon (2026-10-29)

- `config/local.json` is generated for this workspace with `isolation.mode=none` and the backup model (`provider-a/model-x`), because the project is not a git repository and the default example config requests worktree isolation. This file is gitignored and explicitly removed from release ZIPs.
- `scripts/daemon-supervisor.mjs` calls `ensureDaemon` every 30 seconds; the daemon is detached, so a supervisor restart does not kill it. `npm run daemon:supervise` starts it manually.
- `scripts/register-daemon-task.ps1` registers a per-user logon scheduled task (`AI Agent Teams Daemon`) that runs the supervisor hidden. `Start-ScheduledTask` was used to verify the task; `GET /api/v1/health` and `GET /ui` both returned 200 on `127.0.0.1:8779`.
- Crash recovery was verified by force-killing the daemon PID: the supervisor detected the stale discovery within one 30-second interval, started a fresh daemon on 8779, and health/UI returned 200 again.
- This removes the earlier "browser tab cannot start the daemon" failure: after the task starts, the stable 8779 URL is served even when the user has not clicked the MCP card.

## 22. Native side-pane UI surface (2026-10-29)

- ZCode 0.17 has no `conversationHeader`/`uiSlots`/`statusBar` contribution. It does expose `ui.surfaces` in a plugin manifest: each surface needs an `id`, a title (string or locale map), an icon, a declared `mcpServers` key, a `ui://` resource URI, and `availability: "session"`.
- The plugin now declares one surface (`id=ai-agent-teams`, `server=agent-teams`, `resourceUri=ui://ai-agent-teams/panel.html`). The surface id matches the MCP App metadata `_meta.ui.surface`.
- Verification: `plugins/listUiSurfaces` on a real app-server returned the installed plugin as `{pluginId: "ai-agent-teams@ai-agent-teams-local", id: "ai-agent-teams", icon: "users", server: "plugin:ai-agent-teams:agent-teams", resourceUri: "ui://ai-agent-teams/panel.html", availability: "session"}`. `test/manifest.test.mjs` locks the manifest contract.
- UX: open the side pane, click `+ 新增标签`, choose `智能体团队`. The same panel opens as a side-pane tab, independent of `agent_teams_view`, and can stay open while the conversation continues. It is not a conversation-header button; ZCode 0.17 exposes no such slot.
- Packaging: `npm run package` rebuilt both bundles with the surface; the ZIP manifest contains `ui.surfaces` and the archive excludes `config/local.json`. Current hashes are recorded in `dist/*.sha256`. The local marketplace was repointed to the 0.1.1 directory and the plugin was installed with `zcode plugins install ai-agent-teams@ai-agent-teams-local`; the cache reports `contentOk: true` and its manifest matches the source tree byte-for-byte. Restart ZCode once so the desktop host reloads the plugin manifest and shows the side-pane entry.

## 23. Container dispatch wiring (2026-10-29)

- `src/session/container-cli.mjs` implements `ContainerCliSessionAdapter`. Each create/send runs the configured ZCode CLI inside `docker run --rm` (or Podman) with a per-turn container name; only the task worktree (`/workspace`), member home (`/home/zcode`) and the read-only package `src` (`/opt/agent-teams/src:ro`) are mounted. The container is non-root, read-only root, `--cap-drop ALL`, `no-new-privileges`, pids/CPU/memory limits; `HOME=/home/zcode` is set explicitly; `gateway-only` uses a Podman bridge/NAT and allows outbound egress.
- `src/runtime/container.mjs` adds `containerSelfTest`: it requires the image to exist (`<runtime> image inspect`) and `zcode --version` to run inside it. `ensureContainerRuntime` probes `info`, initializes/starts a missing or stopped Podman machine, and returns `machineStartError` on failure. The daemon refuses `isolation.mode=container` if the runtime, image, self-test, seed/model or a container-reachable URL is missing; it does not silently fall back to worktree.
- Hard fields are `isolation.image`, `isolation.cliPath`, `isolation.containerUrl`, `isolation.hostAddress`, `isolation.bindHost`, `isolation.homeSeed`, `isolation.workerModel` and `isolation.workerMode`. `CONTAINER_DISPATCH_READY` is true; hard availability requires WSL2 + Podman/Docker + a worker image + seed/model + a passing self-test.
- Tests cover hardened args/mounts, secret env names, image/CLI self-test outcomes, machine init/start failures, runtime exactness, URL translation, seed symlink refusal, seed/model updates, member-home purge containment, and `/ui` loopback restriction.

## 24. Hard container E2E (2026-10-30)

- WSL 2.7.14 + Podman 5.8.3; worker image `ai-agent-teams-worker:latest` contains ZCode 0.17.0 and `zcode-builtin.json`.
- `isolation.homeSeed` copies only `credentials.json`, `provider_config.json`, `setting.json` into each member home; `isolation.workerModel` injects `defaultModelSelection`.
- A temporary git repo and temporary daemon on port 8799 logged `adapter zcode-container`; the container reached the daemon via the WSL gateway `<wsl-gateway>`.
- An engineer `work` task was claimed and completed through team-cli with a real model turn (`completed`, attempt 1) on a Podman bridge (not host networking).
- Formal 8779: loopback health 200, WSL-gateway health 200, container health 200, `/ui` loopback 200, `/ui` via <wsl-gateway> 403.
- Read-only analyst roles cannot invoke team-cli in `plan` mode, but the member MCP server is loaded from the worker home; a real analyst `verification` task completed through MCP in section 26. Multi-host load and root-POSIX container execution are not verified (root POSIX fails closed).

## 25. Panel opening, ACL and live render (2026-10-30)

- `src/panel.mjs` centralizes panel URL resolution, health checking, instructions and browser launch. `node src/cli.mjs panel` prints the current URL and instructions; `--open` requires a discovered, healthy, same-workspace daemon (health version + workspace + identity), then launches Edge, then Chrome, then the OS default browser. A missing browser is reported with a non-zero exit instead of a false success.
- The daemon logs `panel http://127.0.0.1:<port>/ui#tasks` and a `panel hint: node src/cli.mjs panel --open` line. The MCP `initialize` result includes the same instructions for captain/UI handlers; member handlers omit panel guidance because they cannot call `agent_teams_view`. `agent_teams_view` returns the `/ui#tasks` link plus the CLI command.
- Discovery is per workspace (`~/.ai-agent-teams/workspaces/<hash>/runtime.json`) with a legacy mirror. A second workspace daemon on 8799 was started while the formal 8779 daemon kept running: both health endpoints stayed 200, `panel --json` reported 8779 for the project and 8799 for the temp workspace, and the formal daemon was unaffected.
- `ensureDaemon` now takes an exclusive per-workspace lock. Two `node src/bootstrap.mjs` processes started concurrently against a stopped daemon produced exactly one daemon on 8779; one reported `started`, the other `already running`.
- A stale daemon is terminated only after `/api/v1/health` matches its `pid`, `instanceId` and `workspace`, **and** `/api/v1/teams` accepts its discovery token. Unverifiable or older daemons produce an error instead of a kill, so the arbitrary-PID path is gone.
- `node src/cli.mjs panel --json` against the formal 8779 daemon returned `discovered=true`, `running=true`, `healthy=true`, `workspaceMatch=true`, `version=0.1.6`.
- Live render: a temporary fake daemon on port 43911 was seeded with Alpha (2 tasks, one completed) and Beta (1 in-progress task); Chrome headless via CDP loaded `/ui#tasks`, rendered the injected bootstrap, showed all three subjects, `1 已完成`, `实时` and `双队`, and kept the subjects after clicking `刷新`. The temporary daemon/profile was removed after the test; no screenshot was retained.
- `GET /ui` requires a per-process access key when `uiAccessKey` is configured: a missing/incorrect key returns 403, the first correct `?key=...` returns 200 and sets an `HttpOnly; SameSite=Strict` cookie, and later requests work with the cookie. The page never receives the admin token; `/ui` injects a read-only UI token. The key is stored in the 0600 discovery record, so another local OS account cannot read it. SSE token comparison is timing-safe.
- `writeDiscovery` writes through a 0600 temp file; POSIX replaces atomically, while a Windows replace failure can briefly remove the old file before the new one is renamed; on Windows it uses the absolute `%SystemRoot%\System32\icacls.exe` with `/inheritance:r /grant:r <current-user>:F` and fails closed if the token file cannot be restricted. Tests cover panel URL validation, discovery schema/workspace isolation, health version/workspace checks, missing-browser failure, Chrome/Edge ordering and the two browser launch paths.

## 26. Read-only container completion through member MCP (2026-10-30)

- `writeMemberMcpConfig` writes only `home/.zcode/cli/config.json` for a persistent container member. It registers one stdio server, `agent-teams-member`, running `/opt/agent-teams/src/mcp-server.mjs` with `AGENT_TEAMS_AUTOSTART=0` and the member-scoped URL/token/team/member environment. The file is written atomically with mode 0600 and never contains the admin token or host discovery path.
- `buildContainerArgs` mounts `<packageRoot>/package.json` read-only at `/opt/agent-teams/package.json` and `<packageRoot>/assets` read-only at `/opt/agent-teams/assets`, because the member MCP server and handler read the package version and panel resources at module load. No additional write mounts are added.
- `ContainerCliSessionAdapter.seedHome` writes the config for persistent members in both `create` and `send`; ephemeral contractors never receive it. A config write failure warns and does not abort the turn.
- Real E2E: a temporary daemon on 8797 with Podman + a real model turn created Alpha with an analyst member. The task was `kind=verification`, `mode=plan`, with Edit/Write/ApplyPatch/Bash/NotebookEdit disabled. The analyst claimed V-T1 and completed it through the member MCP tools in about 90 seconds; the audit returned `blockers=[]`, `warnings=[]`. No file edits were needed.
- Unit coverage: `test/worker-home.test.mjs` verifies the config content, member-only token, missing parameters, symlink refusal and POSIX modes; `test/container.test.mjs` verifies the package.json/assets mounts, persistent member config, ephemeral exclusion, token refresh on `send`, and non-fatal config write failure. The Windows POSIX-mode test is skipped.

## 27. Panel access key, local model bridge and 0.1.6 E2E (2026-10-30)

- The panel now uses a per-process `uiAccessKey` in addition to loopback-only binding. `GET /ui` without the key returns 403; the first `GET /ui?key=...` returns the page and sets `HttpOnly; SameSite=Strict; Path=/ui` under a port-specific cookie name; subsequent requests to that port use the cookie. The key is written to the workspace discovery record (0600) and the legacy mirror, but never to the page. MCP `initialize.instructions` redacts the key and points to `panel --open`.
- `src/runtime/loopback-bridge.mjs` exposes a selected host-loopback TCP service on the WSL gateway. It refuses non-loopback targets, wildcard listen addresses, invalid ports, and closes active sockets on shutdown. The daemon starts it only in `gateway-only` network mode, only for a selected provider whose `api.baseUrl` is loopback HTTP, and only when the listen address is an explicit `hostAddress` or a strict WSL/Hyper-V detection; it never falls back to an arbitrary LAN adapter. `seedWorkerHome` rewrites only that provider in the copied worker `provider_config.json`; the host file is unchanged.
- A fresh temporary workspace on 8797 used the host `provider-a` at `127.0.0.1:8787`; the daemon logged `provider bridge 127.0.0.1:8787 -> <wsl-gateway>:<port>` and the worker home contained `http://<wsl-gateway>:<port>/ap/v1`.
- Read-only E2E: analyst `V-T1`, `plan` mode, Edit/Write/ApplyPatch/Bash/NotebookEdit disabled; claim → in_progress → completed through the member MCP; output explicitly says it used only the member MCP tools; audit `blockers=[]`, `warnings=[]`. After the bridge hardening, `V-T2` was rerun on the same temporary workspace and also completed through member MCP with a clean audit.
- Writable E2E: engineer `W-T1` created `answer.txt` with `OK`; the verify command passed; `changedPaths=["answer.txt"]`; audit `blockers=[]`, `warnings=[]`.
- Panel E2E on the same temporary daemon: `/ui` without the key 403, with the discovery key 200, and a non-loopback Host header 403. The temporary daemon and all temporary Podman containers were stopped/removed; no screenshot was retained.
- This run used the local model proxy through the bridge. Multi-host load remains unverified, and the bridge is not an egress firewall: `gateway-only` still has outbound network access. The bridge is a TCP forwarder without application-level authentication; it is bound only to an explicit `hostAddress` or a strict WSL/Hyper-V address and is documented as trusted-host-only.

## 28. Startup side pane, patrol guard and empty-repo baseline (0.1.7, 2026-10-30)

- Host schema probe: ZCode 0.17's `ui.surfaces` entries accept only `id`, `title`, `icon`, `server`, `resourceUri` and `availability: "session"`; there is no `autoOpen`/`openOnStartup` field. The selected design is therefore a startup first call, not a manifest auto-open claim.
- `initialize.instructions` on the captain/UI MCP handler includes `Session startup rule` and `agent_teams_view`; member handlers still omit panel guidance and hide the panel tools. Host-side consumption of MCP `initialize.instructions` was not found in the ZCode 0.17.1 bundle, so 0.1.7 adds a plugin `SessionStart` hook as the delivery path and keeps the initialize text only as a secondary hint.
- `agent_teams_view` metadata is `surface: "ai-agent-teams"`, `preferredDisplayMode: "fullscreen"`, with no `showInline: true`; the panel JS no longer requests `pip`. The host bundle contains `runSessionStartHooks` and `injectHookAdditionalContextIntoMessageHistory`, confirming the hook delivery path; the exact fullscreen-to-side-pane symbol was not located in 0.17.1, so the end-to-end open remains a fresh-session observation, not a code-level guarantee.
- Patrol regression tests: `lastPatrolAt` is written before a hanging `adapter.send`; a concurrent `patrolTickAll` returns `patrol-in-flight` for the same team and does not call `patrolOnce` twice; a throwing team is isolated (`patrol.failed`) while the other team still patrols; intervals are per team; a hanging send hits the hard deadline and records `patrol.stalled`; cancellation must acknowledge stop AND observe the original patrol settle before releasing the guard. A stop error, missing acknowledgement, cancellation timeout, or unsettled send retains the guard. Retried cancellation is single-flight, and no duplicate patrol starts. An AbortSignal is established before create/submit, checked after each await, and prevents a late send/spawn; contractor cancellation additionally awaits its runner and a terminal status (not `cancelling`); a deferred patrol (no contractor slot) does not consume the interval.
- Worktree regression tests: an empty repository gets a baseline ref; a non-empty repository with a missing base rejects, dispatch is blocked before an attempt (`attempts=0`, no `task.dispatch_failed`, one `worktree.base_missing` event across two ticks), audit names the missing base, and dispatch resumes after the base appears (`worktree.base_recovered`, also via a forced recheck). A second baseline writer is rejected by the create-only `update-ref`; staged/untracked files never enter the baseline; a SHA-256 repository gets a 64-hex commit; `HEAD` is stored as a commit and a committed worktree yields non-empty `changedPaths`; an unborn-but-not-empty branch is rejected.
- Dynamic allocation regression: a team blocked on a missing base is excluded before `allocateSlots`, so a healthy team can use all six slots instead of leaving one idle.
- `SessionStart` hook tests: strict two-key JSON on `startup`/`clear`, silence on `resume`/`compact`, in worker sessions (`AI_AGENT_TEAMS_WORKER=1`) and with `AI_AGENT_TEAMS_AUTO_PANEL=0`; malformed stdin intentionally produces no output.
- Quality gate (0.1.7 measurement): `npm test` 317 tests (315 pass, 2 Windows-only skips); lint 0; `CHECK OK` 131 files, 19 SPEC sections, 14 example tasks; coverage lines 81.61% / branches 67.17% / functions 82.30%; dependency audit 0 vulnerabilities.
- This section records unit/integration evidence; the actual ZCode side-pane open on a fresh captain session is recorded only after the installed 0.1.7 plugin and a restarted MCP process are exercised. The SessionStart hook can be checked directly with a sample stdin payload (malformed input intentionally produces no output); whether the model performs the first call remains model behaviour, not a host guarantee.

## 29. Flexible workspace, daemon fallback and standalone panel (0.1.8, 2026-10-31)

- The MCP server resolves the team workspace per tool call instead of freezing `CLAUDE_PROJECT_DIR` at startup. Precedence: explicit `workspace` argument, session `agent_teams_workspace use`, `AGENT_TEAMS_WORKSPACE`, a startup workspace that owns team config/discovery, the saved target (`~/.ai-agent-teams/active-workspace.json`), the newest live daemon, then the startup workspace. `AsyncLocalStorage` isolates concurrent calls. The saved target never overrides a session with its own team config.
- `agent_teams_workspace` supports `current`, `list`, `use` and `auto`; every tool schema now has an optional `workspace` property outside `required`. `agent_teams_view` also accepts `window: true`.
- Daemon liveness: discovery files are deduped by port+workspace, sorted by `startedAt`, and the resolver only considers records whose PID is alive. This prevents a stopped/deleted test workspace from becoming the fallback target.
- Auto-start: `mcp-server.mjs` only calls `ensureDaemon` when the startup workspace has `.ai-agent-teams/` or a `config/local.json` containing this tool's `teams` array. A tool call in a folder with no discovery/config returns guidance instead of trying to start a daemon there.
- SessionStart hook: injects when the workspace has team state, when `AI_AGENT_TEAMS_AUTO_PANEL=1`, or when a live daemon exists. `=0` and worker sessions stay silent. Directly running the installed hook with the ZCode default workspace payload produced the strict `{hookEventName, additionalContext}` JSON containing `agent_teams_view`.
- Standalone window: `openPanel(..., {mode:'window'})` uses `--app=<url> --window-size=1440,960`; `panel --window`, `npm run panel:window`, `open-panel.cmd` and `agent_teams_view {window:true}` are wired. Browser preference is Edge, then Chrome, then the OS default. `Win32 EnumWindows` showed the app window `Ai-Agent-Teams-Zcode · 双队任务流原型` as a separate visible window under the Edge process.
- Real probes from `<workspace>` using the installed 0.1.8 server: `current` resolved to the project via `recent-daemon` with `fallback:true`; `agent_teams_view` returned the keyed 8779 URL and `alpha/beta`; `agent_teams_status alpha` returned four tasks.
- A/B probe: a temporary git workspace with a second 0.1.8 daemon on 8782 was selected with `use`; `status` on A returned four alpha tasks and on B an empty team list, while `view` pointed at 8782. The temporary daemon/workspace/discovery and saved target were removed afterwards, and the default probe returned to 8779.
- Quality gate: `npm test` 339 tests (337 pass, 2 Windows-only skips); lint 0; `CHECK OK` 134 files; coverage lines 82.16% / branches 68.11% / functions 82.85%; dependency audit 0 vulnerabilities.
- The current ZCode process still holds the pre-upgrade MCP server; the new resolution logic is exercised by direct installed-server probes and needs a ZCode restart/new session for the live conversation. The fresh-session side-pane open remains an observation item.

## 30. Host model following (repair round 2, 2026-10-31)

- `~/.zcode/cli/log/zcode-2026-10-31.jsonl` contains `session.model.updated` with `context.model` and `session.reasoning_effort.updated` with `context.thoughtLevel` for the desktop session (`sess_f21c4510-...`). `model.request.started` context in the same log contains `queryId`, `turnNumber`, `telemetry.inputOrigin`, `messageCount` and `iteration` — no model or thought level, so it is not a model source.
- Simulated SessionStart hook: running `scripts/session-start.mjs` with `ZCODE_SESSION_ID` and a `{source:'startup', cwd}` payload wrote `<workspace>/.ai-agent-teams/host-session.json` containing the session id (mode 0600 is set on POSIX; Windows has no POSIX mode bits) and emitted no panel instruction.
- A daemon started from this worktree (`--fake --cwd <temp git workspace> --db :memory: --port 0`) read that file; `GET /api/v1/model` returned `policy.mode=follow-host`, a non-empty `host.sessionId`, and `host.model=provider-a/model-x` from the real log.
- Not yet verified: the desktop daemon does not run this code until the change is merged/installed and a new session runs the hook; a real `agent_teams_model status` call against that install is the merge gate. No `session.reasoning_effort.updated` was found for the current session, so the reasoning hot-switch path is covered by tests only.
- `npm test` 400 tests (398 pass, 2 Windows-only skips); lint 0; `CHECK OK` 134 files. The hook-to-status path is also covered by an automated test that runs the real `scripts/session-start.mjs` and asserts a non-empty `host.sessionId`.

## 31. Hot-update packaging and installer (repair round 2, 2026-11-01)

- `node --test test/hot-update.test.mjs`: 31 tests, 31 pass, 0 fail. Coverage includes allow-list packaging with `src/runtime/` present and `src/node_modules`/`assets/build` skip warnings, relative-import closure rejection, same-length digest tampering, symlink and `files[].path` traversal rejection, manifest-only external install with skip warnings, recovery journals and orphan backups, cross-process lock timeout/stale reclaim, health-check environment isolation, CLI path-intent errors, and a real package boot through the stable shell.
- Historical 2026-11-01 real-repository build probe on a temporary plugin root: 61 files, 33 tools (these are that probe's counts, not the current source catalog). `install` health check passed (33 tools), `status` reported `entry check: ok` and `package check: ok`, a second build/install set `previous`, and `rollback` returned to the first version with a passing health check.
- A packaged daemon (`node <pkg>/src/daemon.mjs --fake --no-loop --port 0 --cwd <temp git workspace> --config <pkg>/config/example.v06.json --db :memory:`) printed `listening on` and produced no `ERR_MODULE_NOT_FOUND`; this is the regression test for the round-2 P1 where `src/runtime/` was dropped from the package.
- `npm test` 513 tests (511 pass, 2 Windows-only skips, 0 fail); `CHECK OK` 137 files. `docs/guides/INSTALL.md` and ADR-0020 record the operation and design.
- Correction (round 3): this section originally recorded `lint 0`, which was not true at that head. `npm run lint` reported two `no-unused-vars` errors — `src/mcp/shell.mjs:270` (unused `error` in the rename-catch) and `test/model-follow.test.mjs:605` (unused `adapter` in a destructure). Both are fixed in section 32.

## 32. Hot-update packaging and installer (repair round 3, 2026-11-01)

- `node --test test/hot-update.test.mjs`: 47 tests, 47 pass, 0 fail (16 new cases over round 2). New coverage: `shortCommit` must be 7-40 hex and prefix `gitCommit` (missing, `undefined`, POSIX/Windows traversal, too short, non-hex, non-prefix all rejected) and an external draft with such a manifest cannot install; a publish target must be a direct child of the versions directory (`..`, the root itself, a nested path and a sibling directory are rejected); `install` stamps the pointer with a 16-hex `swapId`, a second publish gets a different one, and a journal carrying the pointer's id is recognised as committed; a crashed forced replace whose pointer carries the journal's `swapId` keeps the new version and discards the backup, while a pointer carrying a different id, a stale digest or a journal with no `swapId` at all restores the old bytes; a forced re-install of the same version id with a byte-identical entry never leaves the unverified new tree in place; every packaged file, the manifest and copied install files are flushed through the `syncFile` seam; a `.runtime-<sha>.mjs` copy whose bytes do not match its digest is not installed; an explicit `AGENT_TEAMS_AUTOSTART=1` is ignored (`ignoredEnvOverrides`) and an explicit `0` is honoured; `npm_config_cache`/`CARGO_TARGET_DIR`/`PIP_CACHE_DIR` never reach the probe; lowercase `agent_teams_*` names are dropped, normalized and cannot smuggle autostart back in; `rollback` fails with `HOT_UPDATE_PREVIOUS_MISSING` when the recorded previous version was deleted and with `HOT_UPDATE_NO_ROLLBACK_TARGET` when no previous is recorded (neither moves the pointer); a failed `undo` surfaces as `details.undoError` with `HOT_UPDATE_UNDO_FAILED` and keeps the journal; `build --commit <sha>` still warns about a dirty tree, `gitDirty: true` forces the warning, and a tree git cannot read warns instead of passing as clean.
- Each new case was checked against a reverted fix with a local mutation harness (15 mutations, one per fix): in every run the guarding test failed and the mutation was then restored. The harness lives in `.tmp/2026-11-01-hot-package-r3/mutate.mjs` and is not part of the package.
- `npm run lint` reports zero errors (the two round-2 errors in `src/mcp/shell.mjs` and `test/model-follow.test.mjs` are fixed); `node scripts/check.mjs` prints `CHECK OK (137 files, 19 SPEC sections, 14 example tasks)`; `npm test` runs 531 tests (529 pass, 2 Windows-only skips, 0 fail) on the merged base, which already carried the newer scheduler/worktree cases.
- Two crash paths are only covered by code review: a publish whose staging rename fails *and* whose restore then fails (`details.undoError` on `HOT_UPDATE_BUILD_FAILED`) needs a filesystem fault and has no test; the install-side equivalent is covered by the "undo that could not restore" case.
- Not re-measured in this round: the real-repository build/install/rollback probe and the packaged-daemon boot from section 31. Both are still exercised by tests (`a package built from this repository starts its daemon`, `a real package boots behind the stable shell and survives a rollback`) and by `rollback`/`status` cases, but no manual CLI transcript was taken.
- Known gap in the tests: `publishStaged` is not exported, so its containment check is proven by the unit test on `assertPublishTargetInside` plus every install/build case passing through it; no test can hand it an escaping target directly because manifest identity validation rejects such a package first.

## 33. Worktree reclaim and publication retry (2026-11-07)

- MCP no-config behavior was reproduced in `node --test test/mcp.test.mjs`: the initial fixture threw a generic `Error('fetch failed')`, which is deliberately not classified as a connection that never reached the daemon. The corrected test uses `ECONNREFUSED`, an explicit `127.0.0.1` test URL/token, isolated `statePath` and explicit per-call `workspace`; it passes and makes no real network request. Generic fetch errors retain their existing no-autostart behavior.
- Worktree reports now include global and per-team active/pinned/protected/remaining counts. Even a team whose only worktree is pinned emits `worktree.reclaim_summary`; the event contains numeric counts and no path. Startup and periodic daemon reclaim output only active, remaining, pinned-over-capacity and error counts; error text/path and credentials are not logged.
- `missing_unit_inheritance` is terminal; repeated adoption/reconcile retains one `task.adopt_blocked` event. Recoverable `E_PUBLICATION_HELD` and SQLite busy/locked errors are isolated at the team tick boundary, backed off, and do not generate one `team.tick_failed` event per scheduler tick. Other teams continue ticking.
- Same-repository reclaim calls are serialized by canonical repository path. Each invocation gets a distinct pass with its own options; a queued `allowOrphanSweep: true` executes after an earlier false-option pass rather than inheriting its report.
- Added regressions in `test/service-v06.test.mjs`, `test/service.test.mjs`, `test/process-v15.test.mjs` and `test/worktree-reclaim.test.mjs`; critical worktree/process/service tests and the actual task-tree CSS/HTML inputs are listed in `scripts/check.mjs`.
- Verification pending for this delivery: `node --test test/mcp.test.mjs test/worktree-reclaim.test.mjs test/service.test.mjs test/service-v06.test.mjs test/process-v15.test.mjs` passed (245/245); `npm run lint` passed; changed-file `node --check` passed. Full `npm test`, `npm run check`, and `npm run check:i18n` are still to be run.

## Not verified

- A real model through the CLI adapter (the CLI has no `--model`; app-server is the verified path).
- `session/send guide` mid-turn.
- Multi-host load: all recorded 32/48-way provider runs were on one host. Worktree and merge/publication paths have source and test coverage; a broad real-provider multi-worker worktree acceptance run is not claimed here.
- A conversation-header button (the host owns that row; the supported entry is the side-pane plugin surface, plus the MCP App card and `/ui` view).
- A clean 32-way real-model pass at a provider quota lower than the one used on 2026-10-29 (that run passed 32/32 both paced and unthrottled; see section 19).

## Re-run

The commands above are the minimum probe. Add them to `scripts/check.mjs` only after the protocol adapter exists; do not spend model tokens in CI.

## Three-skill simplification pass (2026-10-31)

- Scope: preserve scheduling, cancellation, retry, audit, merge and isolation behavior. Existing `CONSTRAINTS.md` (now `docs/guides/CONSTRAINTS.md`), dependencies, scripts, lint rules and the original 303 tests are unchanged.
- Consolidate six contractor stop/close cleanup flows (including restart reconciliation) into `cleanupContractorSession`, preserving stop-before-close, optional close and first thrown error. Share the identical post-create/post-send cancellation transition; keep `return await` inside the original catch boundary and retain the captured adapter.
- Share process provider-error extraction between CLI and container adapters, preserving stdout JSON, stderr JSON, stderr text and stdout text precedence; preserve error identity and container cleanup order.
- Add 14 focused regression cases. Removing close or reversing provider JSON precedence makes those tests fail; both mutations were restored. Final test and coverage results are recorded in the local optimization delivery record.
- Scheduler lines: 2705 → 2688; all source lines: 12527 → 12523. These are maintainability changes, with no claimed throughput improvement. Real stop-hang E2E, fresh-session panel observation, M8 full event-schema audit and new 32/48-way load remain outside this pass.

## Deployment fixes (2026-11-01)

- Red-box review skips `hidden` source tasks in the direct hook, tick sweep and `ensureRedReview`; a restart no longer revives legacy retry copies/smoke tasks (`test/red-auto-review.test.mjs`).
- A deferred red-review continue is counted only at the actual send point; a rebuilt member session is detected and the task is requeued with the full prompt (`test/red-auto-review.test.mjs`).
- Mailbox delivery backs off 5s → 5min and does not emit one event per tick (`test/service.test.mjs`); the UI SSE refresh is a throttle, not a debounce (`test/ui-refresh.test.mjs`).
- Historical 2026-11-01 behavior queued and re-sent captain-busy patrol reports. The current contract is conservative: any adapter `ok:false` response (including a busy warning) leaves the report `unknown` and is not automatically replayed; only an explicit local pre-send admission rejection is retryable. Hidden rows and old terminal rows are excluded from report chains/risks.
- Full suite: 614 tests (612 pass, 2 Windows-only skips), lint 0, `CHECK OK` 137 files.
