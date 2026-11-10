# Roadmap

Current formal release: `0.1.8`. Current source/package metadata: `0.2.2` (unreleased; not an installed-plugin or production-readiness claim). The entries below preserve the original v0.5/v0.6/v0.7/v0.8 planning snapshots and their historical acceptance criteria; they are not a current implementation-status ledger. See `docs/status/STATUS.md` and `docs/status/HANDOFF.md` for the current source checkpoint (2026-11-10).

Historical baseline summary: M0-M6 were described as implemented at the tested-logic level. M7 was later verified for worktree isolation plus container dispatch (`ContainerCliSessionAdapter`, self-test gate): a writable `work` task completed through a real Podman container and model turn on 2026-10-30, and a read-only analyst `verification` task completed through member MCP with `plan` mode and Bash disabled. M8's HTTP/SSE API exists; host-owned conversation-header integration remains unavailable. Historical real-model evidence includes six-worker smoke, paced 16-way 16/16, 2026-10-29 32-way 32/32 paced and unthrottled, and 48-way 48/48 unthrottled on the backup `provider-a` endpoint; multi-host load remains unverified. v0.6 was implemented behind feature flags, while legacy configs retain their behavior.

## Current source checkpoint - 2026-11-10

The current `0.2.2` working source includes scheduler decomposition, native `team-worker` model-selection wiring, archive relocation, and recovery corrections. The latest recorded full suite and coverage pass is 1378/1378 with zero skips (90.80% lines / 78.68% branches / 90.33% functions; `.tmp/2026-11-10-scheduler-final-acceptance/current-doc-audit-coverage.log`); lint, structure, i18n, asset syntax, validate, plan, dependency audit and diff-check also passed at that checkpoint. These are local source/package checks, not installed-plugin, real-provider, public-release or production acceptance. Scheduler decomposition is bounded, not complete. Do not treat the historical milestone table below as evidence that all current acceptance tests are covered.

| Milestone | Deliverable | Acceptance |
| --- | --- | --- |
| M0 | Spec, config schema, pure logic, tests, prompts, docs | `npm test` and `npm run check` pass |
| M1 | Complete pure domain logic: attempt/lease/parked, deps/causal edges, gates, artifact/delivery | Every T-01..T-25 row in `docs/test-matrix.md` is covered or explicitly waived |
| M2 | Daemon + SQLite + HTTP/SSE + discovery | health/teams/tasks/events endpoints; tests |
| M3 | ZCode Protocol adapter (CLI fallback) | create/send/stop/setModel/resume; context and cwd verified |
| M4 | Scheduler + 6 slots + 2 teams + lazy spawn + warm pool | T-29..T-35 |
| M5 | Mailbox + plan approval + halt/resume + interruption | T-36..T-50 |
| M6 | Gate executor + verify runner + merge queue | T-09..T-25 + merge |
| M7 | Container pool + worktrees + isolation | two workers cannot see each other |
| M8 | Native tab API + SSE + member session viewer | host team integration |
| M9 | Token gateway + budgets + usage reconciliation | **Retired by ADR-0027**; the cost gateway and budget state were removed. `isolation.network=gateway-only` remains a separate container network mode. |
| M10 | Six-worker e2e, 16 load, multi-host 32, release | all acceptance tests |

Historical status snapshot (2026-10-26): worktrees and merge queue were tested; container args/Dockerfile existed but actual container execution had not been verified on that host. Later container E2E evidence is summarized above and in `docs/verification.md` sections 23-26.

## Historical milestone detail (v0.5 plan; preserve as a planning snapshot)

The milestone rows and detail below retain the original roadmap acceptance criteria. Current completion evidence is in `docs/status/STATUS.md`, `docs/test-matrix.md` and dated sections of `docs/verification.md`; historical M7/M8/M10 wording is not a live gap/status report.

## M1 details

- `beginTaskAttempt` / `invalidateTaskAttempt` / `activateTaskAttempt` equivalents.
- Parked attempt and lease expiry.
- Dependency validation and causal edges.
- Quality completion rules and repair/review planning.
- Artifact digest/scope/drift helpers.
- Delivery audit (blockers/warnings).
- Tests T-01..T-25.

## M2 details

- SQLite schema from `SPEC.md` section 13.4.
- HTTP `/api/v1`, SSE, discovery file.
- Health, teams, members, tasks, messages, usage, events.
- Idempotency keys and stable error codes.

## M3 details

- Protocol client: `session/create`, `send`, `stop`, `setModel`, `setThoughtLevel`, `events`.
- CLI fallback: `zcode -p --json`, `--resume`, `--cwd`, `--disallowed-tools`.
- Capability probe and degradation warnings.

## v0.6 first version

Historical first implementation note: [docs/design-v0.6-roster-and-licenses.md](design-v0.6-roster-and-licenses.md) was implemented in `0.7.0-alpha.1` behind feature flags. Legacy configs keep 6/3-3. The alpha version is an implementation-history reference, not the current package version.

- Conservative/balanced presets; 16GB dual-team 6+6 (max 8+8); 32GB 8+8/10+10; 64GB 12+12/16+16.
- Zero workers at team creation; materialize on demand; shared worker pool with fairness debt; no permanent team leads for one or two teams.
- Immutable `memberId`, hidden `licenseId`, visible license label; name changes are license changes issued by the captain/human; members may only request.
- Re-license only when `settled`; always archive the old transcript and start a fresh session.
- Merger executes a signed merge order and never edits; post-merge review is a one-shot contractor on an integration branch; reject routes to merger/engineer by reason code, max two rounds.
- Captain self-wake patrol is the default: the daemon wakes an idle captain; if the captain is busy, a one-shot patrol contractor scans once and is killed. No persistent rover.
- Waiting or quota-pressured members go warm (compacted) then cold (session closed, summary persisted) and resume without duplicating attempts. Memory watermarks drive eviction.
- Implementation order: config/schema presets -> member state machine/lazy creation -> compression/cold lifecycle -> licenses/settled -> contractors/post-merge review -> captain patrol -> installer/adaptive throttle -> real-model E2E.
- Group leaders are deferred until more than two teams exist.
- Installer recommends presets from RAM/CPU and records that ZCode 0.17.0 does not expose a max-subagent setting.

Historical v0.6 alpha checkpoint: fake-adapter tests and a six-worker real-model smoke had passed; 16/32 real-model load, container execution, multi-host load and web/native UI were then open. Later recorded single-host load and container evidence supersedes those open items; multi-host load remains unverified, and see the current source checkpoint above for present scope.

## Historical v0.8 UI design snapshot (GPT final baseline)

The packaged UI reference is `../assets/team-view.html`; the design and DAG
algorithm are recorded in the current status and verification records: see
[STATUS.md](status/STATUS.md) and [verification.md](verification.md). Current revision:
Codex 2026-10-28 comments/labels/counters, SHA-256 `823e907a…`. The packaged
copy `assets/team-view.html` is served at `GET /ui` and opened by `/team-view`;
it renders a read-only live snapshot from `/api/v1/ui/snapshot` and refreshes over `/api/v1/ui/stream` SSE, with a static fallback.

- 24-task two-team example (12 blue + 12 green), visible stage labels T1–T8,
  seven cross-team exchanges.
- Back-to-back dual tree: blue grows up, green grows down, both left-to-right;
  cross-team lanes use the gap.
- One left rail, one workbench, no permanent right inspector.
- Compact dependency DAG on the Tasks page: depth columns, orthogonal edges (no cubic flying lines), draggable nodes, full
  connected-flow hover focus, unrelated tasks dimmed, one detail strip below.
- Active tasks show a six-dot pulsing run indicator; drag uses anchor-relative
  grid snapping so nodes can always be dragged back.
- Pages: overview, tasks, members, review/merge, patrol, audit, install,
  settings.
- Installer shows host evidence, WSL vs soft recommendation, Podman/Docker
  resource estimate, single/dual team and preset.
- First wired version is a daemon-served `/ui`; a native side-pane UI surface is packaged; a conversation-header tab remains host-owned.

Acceptance: no dead navigation, no overlapping text at 1280/1440, 50-task DAG
without recursion errors, cycle produces a banner, no hidden ids or tokens in
the DOM.

## Historical v0.7 collaboration snapshot

- `scheduler.dynamicTeams`: one total worker cap; teams get a first worker when ready, remaining slots follow complexity-weighted demand; no fixed 3+3.
- `automation.mode=standard|full-access`: standard only asks for merge-to-main and cross-team mail; full access locks settings and auto-approves (typed confirmation).
- Cross-team mail A↔B is captain-gated; target team cannot read/use pending messages; approve/reject is audited.
- UI: dual-root blue/green task tree, green B→A handoff into a blue frame, wheel zoom and canvas pan; settings reduced to mode/pool/isolation/advanced.
- Historical prototype acceptance note: the UI read-only lock, backend settings-write endpoint and merge user-approval enforcement were open at this design snapshot. The packaged live console is now read-only; this old bullet does not describe current source acceptance.

## Non-goals for v1

- Cross-team task dependencies.
- 32 concurrent workers on one machine.
- Absolute security with plain containers.
- Native tab implementation (host team owns it).

## Release gates

- Six-worker e2e passes with real models.
- 16-worker load test passes or is explicitly downgraded.
- Capability probe passes on the pinned ZCode version.
- No open P0 invariant violations.
- Pre-alpha label remains until M10.
