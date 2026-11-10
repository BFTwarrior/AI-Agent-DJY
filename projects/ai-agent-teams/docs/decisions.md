# Decisions (ADRs)

Append new decisions; do not rewrite history. Supersede an old ADR with a new one.

## ADR-0001: External daemon + independent ZCode sessions

**Context:** ZCode's plugin model exposes skills, commands, hooks, MCP servers, and agents, but no host-plane subagent orchestration API. The team needs auto-wake, persistent members, per-member models, worktrees, and a native tab.

**Decision:** Build a daemon outside the chat session. Each member is an independent ZCode session managed through the ZCode Protocol (preferred) or CLI (`--resume`, `--cwd`, `--json`).

**Consequences:** No in-chat team panel; the native tab is the UI. The daemon is an extra process and a single point of failure. Sessions are heavier than in-host subagents. We gain true wake, worktree cwd, per-member model, and crash recovery.

## ADR-0002: 1 captain / 2 teams / 16 default / 32 max / 6 active

**Context:** The user requires one captain commanding two teams, each default 16 and max 32 members, with six members actually working by default.

**Decision:** Model roster size and concurrency separately. 32/64 are database rows; six global worker slots are the concurrency limit. Captain and two leads are control sessions outside the six unless they personally execute a task.

**Consequences:** Most members queue most of the time. Scheduling fairness, lazy spawn, and session volumes are required. 32 concurrent workers is not a single-machine default.

## ADR-0003: SQLite as the team state store

**Context:** The original project uses `team.json` plus JSONL mailboxes and an in-process lock. That is simple but single-process and hard to query.

**Decision:** Use SQLite with WAL, `busy_timeout`, per-team logical locks, and append-only events. The daemon is the only writer.

**Consequences:** Better concurrency, recovery, and analytics; a migration layer is required. Members must use the API/CLI, never direct DB writes.

**Retention update (ADR-0028):** the log stays append-only during operation, but the daemon applies a bounded retention sweep at startup. Non-archived events beyond the newest 50,000 are deleted; archived-team events are exempt.

## ADR-0004: Worktree per active task, container per active member

**Context:** Parallel members editing the same checkout conflict. Worktree alone is not a security boundary.

**Decision:** Every active task gets a git worktree. Every active member gets a container that mounts only that worktree and its home volume. Containers are non-root, read-only root, network-restricted. MicroVM is an optional stronger tier.

**Consequences:** Isolation against model mistakes; shared kernel remains a limit. Six containers consume resources. Windows needs WSL2/Docker or a remote Linux host.

## ADR-0005: queue / guide / stop interruption

**Context:** The ZCode Protocol supports delivery modes and a session stop. A running tool call cannot be edited.

**Decision:** Default to `queue`; urgent guidance uses `guide` (next model step); hard interruption uses `stop` then a new `send`. Long commands run as cancellable background tasks.

**Consequences:** "Real-time" means next model step, not mid-tool. `guide` may fall back to queue; `stop` loses in-flight tool progress but preserves files and session context.

## ADR-0006: Token gateway for budgets

**Status: Superseded by ADR-0027.** The gateway and all cost-budget fields were removed; this entry is kept as history.

**Context:** Client-side usage accounting arrives after each model request; exact mid-response hard stop is impossible.

**Decision:** Put LiteLLM/Portkey/Cloudflare AI Gateway in front of the provider. Each member/team gets a virtual key with budgets and concurrency limits. Budget exhaustion pauses new dispatch (`budget_paused`).

**Consequences:** An extra hop and a dependency; hard stop happens at request boundaries. Gateway logs reconcile with per-turn usage.

**0.1.8 multi-session follow-up:** Several ZCode sessions may call the same local gateway. The default policy is `maxConcurrent=8`, `maxQueue=32`, `queueTimeoutMs=30000`, `upstreamTimeoutMs=120000`: excess chat requests wait in FIFO order and return `429` with `Retry-After` when the queue is full or the wait times out. A client disconnect aborts the in-flight upstream call and releases its slot/reservation; an upstream timeout returns `504`. The budget is global to the gateway (one provider key), not per session. Each in-flight request reserves a small slice (capped at half the budget) so overlapping sessions cannot all pass the same exhausted-budget check; the reservation is replaced by the reported usage on completion. This is still a request-boundary limit: actual usage is unknown until the provider responds, so a single very expensive request can overshoot. Missing or non-numeric usage is charged at the reservation amount (`usageFallbacks`), and invalid prices are rejected at construction. `GET /v1/gateway/status` exposes `spent`, `reservedUsd`, `remainingUsd`, `spendableForNewRequestUsd`, `reservePerRequestUsd`, `active`, `queued`, `accepted`, `rejected`, `failed`, `usageFallbacks`, `upstreamTimeoutMs`, and per-session counters with the same bearer token.

## ADR-0007: Native tab owns the UI; daemon exposes HTTP/SSE

**Context:** The host team can build a native tab; the daemon should not depend on host UI slots.

**Decision:** The daemon exposes `/api/v1` REST + SSE with a discovery file and bearer token. The native tab consumes it. Read-only SQLite access is optional; writes go through the API.

**Consequences:** Clean separation and testability; two processes to run. API versioning is required.

## ADR-0008: No cross-team task dependencies in v1

**Context:** Two teams sharing a global DAG complicates fairness, deadlock detection, and ownership.

**Decision:** v1 allows cross-team messages only. Tasks and dependencies stay within a team.

**Consequences:** Simpler scheduler and fairness. Cross-team work must be represented as separate tasks linked by messages or a captain-created integration task within one team.

## ADR-0009: No `--model` flag; use protocol `session/setModel`

**Context:** ZCode CLI 0.17.0 has no `--model` option.

**Decision:** Create/resume sessions first, then call protocol `session/setModel` and `session/setThoughtLevel`. If the protocol is unavailable, use the session default and emit a warning.

**Consequences:** Per-member model requires the protocol adapter. CLI-only fallback cannot guarantee per-member models; this must be visible in capabilities and status.

## ADR-0010: On-demand members and license-based authority

**Context:** Pre-creating 16 members per team wastes sessions and produces random generated names. Idle members also cannot be safely reused across duties if their old conversation leaks into the new role.

**Decision:** Create zero workers at team creation. Materialize a member only when a ready task needs it. Separate the immutable hidden `memberId` from the visible license label. A license carries role, task kinds, path scope, tool policy, budget, and expiry. Only the captain or a human may issue, revoke, or replace a license; members may only request a change. System checks use `licenseId`/`roleKey`, never the label string. Re-license only when the member is `settled`, and always start a fresh session.

**Consequences:** Team starts cheap and grows on demand. The name is the visible badge, not an authorization key. Idle-between-turns is not settled; a member waiting on review or merge cannot change duty. License history and task attribution are required.

## ADR-0011: Post-merge outsourced review on an integration branch

**Context:** The merger also needs an independent check, but a full second code review creates bureaucratic ping-pong. The merged patch is expected to be good because code review and tests already passed.

**Decision:** The merger executes only a signed merge order and never edits code. Merge into an integration branch first. A one-shot non-member contractor checks the merged result for exact patch, no extra changes, tests, semantic drift, and obvious security/dependency issues. Pass fast-forwards main; reject discards or reverts and creates an internal repair task. Optional reviewer B handles high-risk merges and never edits code. Rejections are reason-coded and routed to the owner, with at most two merge-review rounds before captain/human escalation.

**Consequences:** The merger is audited without a recursive review loop. Main never receives rejected work when an integration branch is available. Contractors must be read-only, time-boxed, budgeted, and killed after the verdict. They are not roster members.

## ADR-0012: Concurrency presets, control budgets, and deferred group leaders

**Context:** Earlier defaults mixed worker concurrency with roster size and total sessions. With two teams, permanent lead sessions can consume worker slots and leave members idle. ZCode does not expose a maximum-subagent setting to read at install time.

**Decision:** Use separate conservative/balanced presets by memory. 16GB dual-team starts at 6+6 (max 8+8); 32GB at 8+8 or 10+10; 64GB at 12+12 or 16+16. Single-team default cap is 16 for 16/32GB and 24-32 for 64GB. Use a shared worker pool with fairness debt and per-team floor 6 / ceiling 10 (16 for 64GB). For one or two teams, no permanent team lead by default; the captain coordinates. Group leaders are deferred until more than two teams exist. Contractors have a separate cap. Enforce worker, control, contractor, and total-session budgets separately.

**Consequences:** 16GB users get a small safe profile; 64GB users can scale. No fixed 3/3 split when one team has no work. The installer recommends from memory but must not claim a platform maximum. ZCode 0.17.0 exposes no max-subagent value; adaptive downgrade on 429 or session-cap errors is required.

## ADR-0013: Captain self-wake patrol; one-shot fallback contractor

**Context:** A persistent rover adds a control session and may duplicate the captain's supervisory role. The captain already owns the team state and should be the primary patrol agent. The captain cannot originate a wake-up by itself, and must not be interrupted while it is executing a task.

**Decision:** The daemon is the patrol clock. When the captain is idle, the daemon wakes it (send to a live session, resume a closed session, or rehydrate from persisted state) and sends a compact patrol prompt. When the captain is busy, the daemon may create one one-shot patrol contractor, read-only and time-boxed, which scans once, returns findings, and is killed. No persistent rover is created by default. The captain must not audit its own implementation. Critical deterministic violations are paused by the daemon, not by the contractor. Patrol findings are persisted and the settled guard includes open findings.

**Consequences:** Fewer sessions and no idle rover cost. Protocol `session/resume` and captain context hygiene must be implemented/tested. Patrol can grow the captain's context; use a fork or compact prompt plus scheduled compaction. The fallback contractor has no broad authority and cannot edit, merge, reassign, or halt.



## ADR-0014: Visible immutable member code plus editable badge

**Context:** The visible license label is editable, so it cannot serve as a stable
human reference. The hidden `memberId` is stable but must not be shown. Users also
want to give each subagent a custom name, and that name is the badge (Chinese:
号牌). Without a stable public code, audit logs, task attribution and member
search cannot refer to a member safely after a re-license.

**Decision:** Give every member a public `code` in addition to the hidden
`memberId` and `licenseId`. The code is short, human-readable, generated once per
member, unique within the team, never reused, and immutable through every API.
Example: `A-01` for the first member of team Alpha. The badge (号牌) is the
editable custom display name; changing it is a re-license, archives the old
transcript and starts a fresh session. The role is a separate duty tag. The UI
shows the badge as the primary label and the code as a monospace secondary
identifier; the code has no edit affordance. The server rejects any attempt to
change a code. Internal ids remain hidden.

**Consequences:** The store needs a `code` column and a migration for existing
databases; the member API and MCP summaries expose `code`; tests must cover code
stability across re-license, uniqueness, and rejection of code edits. Badge
uniqueness within a team remains required so humans can still talk about members
by name. The captain has role `队长` and needs no personal human profile in the
UI.

## ADR-0015: Reserved contractor slots for merge and main-agent work

**Context:** A shared contractor cap lets a main-agent research or patrol contractor occupy both outsourced positions. Merge review is then starved and the merge queue waits behind unrelated work. The main agent must also be able to submit a contractor and stop its own turn instead of waiting for the result.

**Decision:** Split the two default contractors into reserved slots: `merge` cap 1 and `main` cap 1. Each slot has its own FIFO queue; a task can only run in its declared slot. Merge review/verification purposes (`post_merge_review`, `merge_verify`, `merge_review`, `merge`) may only use the `merge` slot; everything else may only use the `main` slot. Slots are never borrowed by default (`allowBorrow=false`). `submitContractor` writes a queued record, pumps the slot queues, and returns immediately; the blocking `spawnContractor` helper submits and waits only for internal merge review/patrol. A killed or completed contractor releases exactly its own slot and the next queued item starts.

**Consequences:** Merge review always retains one reserved capacity, at the cost of one potentially idle slot. A main-agent contractor cannot occupy both positions. Existing configs without `slots` default to merge 1 + main 1 when `maxConcurrent=2`; if `maxConcurrent` is lower, the main slot is reduced first. The store needs `contractors.slot`, a partial unique index for active slot holders, and crash reconciliation for orphaned sessions.

## ADR-0016: Dynamic dual-team worker allocation

**Context:** Fixed 3+3 or 6+6 splits leave workers idle on one team while the other team has a queue. Users want only a total cap and allocation by task difficulty.

**Decision:** `scheduler.dynamicTeams=true` ignores the per-team cap for normal allocation. The scheduler gives every team with ready work one starter worker, then assigns remaining slots to the team with the highest remaining complexity-weighted demand (`S=1`, `M=2`, `L=4`, `XL=8`; kind/priority fallback). Allocation happens at task boundaries only. A large indivisible task still needs one worker; the captain must split it into subtasks to use more workers in parallel. The total active worker count remains bounded by `scheduler.activeWorkerSlots`.

**Consequences:** The current split is shown as `Alpha 4 / Beta 2` and can change between ticks. Per-team caps are ignored when dynamic mode is on; legacy configs keep the fixed split. The UI reads the current split from the daemon, not a hard-coded 3+3.

## ADR-0017: Cross-team mail is captain-gated both ways

**Context:** A and B teams communicate by mailbox, but A-team messages must not reach B until the captain permits them. A one-way rule would allow B→A to bypass the gate.

**Decision:** Any message whose `toTeam` differs from the sender team is stored in the target team's inbox with `approvalState='pending_captain'` and `fromTeamId`. The target team's delivery pump skips it. The captain/admin lists pending messages and approves or rejects. Approved messages are delivered on the next tick; rejected messages are never delivered. The rule is symmetric A↔B. `automation.mode='full-access'` auto-approves cross-team messages and records `approvedBy='full-access'`. Direct cross-team delivery and client-side hiding are not sufficient.

**Consequences:** Mailboxes need approval state, approver, timestamps and rejection reason. The UI shows a captain approval panel and the target team cannot see pending content. Approval is auditable and independent of the contractor slots.

## ADR-0018: Standard vs full-access automation mode

**Context:** Per-action approval settings burden the user. Routine work should be automatic; only high-risk operations need consent.

**Decision:** Settings expose two modes. `standard` auto-approves team creation, task dispatch, badge changes and low-risk work; only merge-to-main, cross-team mail and budget overrun ask. `full-access` requires a typed `FULL` confirmation, auto-approves all approval gates, locks settings read-only, and shows a persistent marker. Audit, budget hard stop and hard stop remain active. The daemon enforces the mode; the UI reflects it.

**Consequences:** The four per-action approval selects are removed. A full-access session cannot change settings until it exits. The continuous-action cap is an advanced circuit breaker and is ignored in full access; it is not a token limit.

**Update (ADR-0027):** the budget overrun approval and budget hard stop were removed together with the cost gateway. Routine approval now covers merge-to-main and cross-team mail; audit and explicit halt/resume remain active.

## ADR-0019: Follow the host model through a persisted session id

**Context:** Members should inherit the captain's model and reasoning, and a mid-session model change should reach already-running members. The daemon process does not receive `ZCODE_SESSION_ID` from ZCode; only hook subprocesses do. ZCode's `model.request.started` event has `queryId`/`turnNumber`/`iteration` in its context but no model or thought level, so it cannot be a fallback source.

**Decision:** The plugin `SessionStart` hook writes the host session id to `<workspace>/.ai-agent-teams/host-session.json` (0600, atomic temp+rename), skips worker sessions, and writes nothing into a workspace without team state. `HostModelReader` re-resolves the id every read (file first, `ZCODE_SESSION_ID` fallback), reads today's and yesterday's `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`, and accepts only `session.model.updated` (`context.model`) and `session.reasoning_effort.updated` (`context.thoughtLevel`). It tails files by offset, keeps a trailing half line pending, compares a prefix anchor so truncate-and-regrow is rescanned, and keeps the resolved session id in status even when no model event exists. `zcode.modelPolicy` defaults to `follow-host`; `fixed` pins a model. Spawn precedence is a real host value (or the fixed pin), then the member's explicit model/reasoning (stored as `modelOverride`/`reasoningOverride`), then config defaults. `ModelWatcher` polls every 3s, hot-applies changes through `adapter.setModel` to every member with a live session, records `model.followed`/`model.follow_failed`/`model.policy_changed`, never throws into the daemon loop, reports `unsupported` for adapters that cannot switch, and seals a permanently failing signature after bounded backoff with one `model.follow_abandoned`. Applications are serialized behind a policy epoch so an in-flight host tick cannot overwrite `set`. `agent_teams_model` (`status`/`set`/`follow`) and `GET|POST /api/v1/model` are captain/admin only; member and contractor sessions deny all four tool-name shapes.

**Consequences:** The daemon still works without a hook or log by falling back to `defaultModel`/`defaultReasoning`. Model changes are eventually consistent with a 3s poll and are not applied to a member whose `setModel` fails; a partial failure is retried only when the host value changes again, while an all-failed signature retries with exponential backoff and is abandoned after 5 attempts (one event, then no further attempts until the host value changes). CLI/container deployments get the resolved value at spawn but no hot switch; validation warns for `follow-host` with `isolation.mode=container`, and spawn ignores the value inside the container. `set`/`follow` are runtime overrides and are not persisted to the config file, so a restart returns to `zcode.modelPolicy`. A stale `host-session.json` means the daemon follows the most recent captain session in that workspace; a new SessionStart replaces it. The state file must stay inside git-ignored `.ai-agent-teams/`.

## ADR-0020: Manifest-bound runtime packages with an atomic, recoverable pointer

**Context:** The stable shell can swap its runtime when `runtime/current.json` changes, but switching by writing arbitrary directories would let an incomplete, tampered or unstartable package take the host session down. A previous packaging attempt excluded `runtime` by directory name at any depth, silently dropping `src/runtime/`, so the packaged daemon failed with `ERR_MODULE_NOT_FOUND` after an otherwise successful `initialize` + `tools/list` probe. Concurrent installs could also overwrite each other's `previous` chain, and a crash between the two renames of a forced replacement left no version behind.

**Decision:** A runtime package is a directory under `runtime/versions/<version>-<shortsha>/` with a `manifest.json` binding `version`, `gitCommit`, `apiVersion`, `createdAt` and every packaged file's POSIX path, size and sha256. `build` copies an allow-list (runtime file extensions under `src/`, `assets/`, `config/`; `package.json`; `VERSION`) and fails if any relative import in a packaged module does not resolve inside the package (`HOT_UPDATE_IMPORT_MISSING`). Skipped cache/output directories and non-runtime files are warnings, never silent drops. `install` verifies the source package, copies only `manifest.json` and `manifest.files` (preserving a shell `.runtime-<sha>.mjs` copy only when its digest matches), verifies the staging copy, spawns the entry for `initialize` + `tools/list` with all inherited `AGENT_TEAMS_*` variables cleared and `AGENT_TEAMS_AUTOSTART=0`, and only then renames a temp pointer over `runtime/current.json`. Pointer read-modify-write and version maintenance run under a create-only `runtime/.hot-update.lock` (pid/host/token; stale owners reclaimed). A forced replace writes a `runtime/recovery-*.json` point before the old directory is moved aside; `install` and `status` restore or discard the backup and remove stale staging directories after a crash. `status` runs full `verifyPackage` on the current version; other installed versions are reported by `entryPresent` only. `rollback` re-verifies and health-checks the target before the same locked atomic switch.

**Consequences:** A failed or unhealthy package can never move the pointer, and the shell keeps serving the old runtime while it drains in-flight requests. Package content is reproducible from the recorded commit except for explicitly warned dirty-tree builds. The manifest is not a signature: it detects corruption and accidental edits, not a malicious publisher. `status` verifies only the current version in full; a non-current version may show `entryPresent: true` while its other files are damaged until install/rollback/status-of-current verifies it. Cross-process locking makes concurrent operations fail with a stable `HOT_UPDATE_LOCK_TIMEOUT` instead of corrupting the `previous` chain. The packaging allow-list must be extended when a new runtime asset extension is introduced.

## ADR-0021: The pointer, not the journal, decides a crashed replace

**Context:** Round-2 review of the hot-update work found three ways the package identity and the crash protocol could still betray the pointer. (1) `shortCommit` came straight from `manifest.json` into the version directory name, so a missing field installed as `9.9.9-undefined` and a value such as `/../../../src` let a publish land outside `runtime/versions/` and replace the plugin's own source tree. (2) `install` wrote the pointer before `commit()`, and `commit()` deleted the backup before the journal. A crash after the pointer switch therefore left a live journal whose recovery rule was unconditional ("a surviving journal means the replace did not commit"), so the *old* bytes were restored under a pointer that named the new ones — a pointer whose `sha256` no longer matched the file the shell would spawn. (3) `npm run lint` already had two errors while `docs/verification.md` claimed zero. Smaller gaps were open too: no fsync of published content, a `.runtime-<sha>.mjs` sibling accepted by name only, an explicit `AGENT_TEAMS_AUTOSTART=1` able to re-enable daemon start inside a health probe, build-cache variables leaking into that probe, `rollback` silently picking an arbitrary other version when `previous` was missing or deleted, an `undo` that swallowed every failure, and a `--commit` build that never reported a dirty tree.

**Decision:** Package identity is verified, never trusted: `verifyPackage` requires `shortCommit` to be 7-40 hex characters and to be a prefix of `gitCommit` (normalized to lowercase and returned to callers), and every publish target must be a direct child of the versions directory (`HOT_UPDATE_PACKAGE_INVALID` otherwise) before the filesystem is touched. `commit()` deletes the journal first and the backup second, so a crash between them leaves an orphan `.replaced-*` directory that recovery discards once the target verifies. Each forced publish records a random `swapId` in its journal, and `install` writes that id into the pointer in the same atomic write that switches it; journal recovery treats the swap as committed only when the pointer carries the same `swapId`, its `entry` resolves inside the journal's target with a matching `sha256`, and the package verifies, discarding the backup with `reason: pointer-committed`. A journal without `swapId` (older installer) is read as uncommitted. The id matters because the entry digest cannot separate a genuine switch from a forced re-install of the same version id whose entry bytes did not change: without it, a crash before the pointer write would leave a tree that never passed its health check. Every packaged file, the manifest and the journal are fsynced before the rename; the flush of packaged files and the manifest is injectable (`syncFile`) so a test can prove it happened, while the journal always uses the built-in implementation. A `.runtime-<sha>.mjs` sibling is copied only when its bytes hash to the digest in its name. The health probe drops build-cache variables as well as `AGENT_TEAMS_*` (both compared case-insensitively, with team overrides normalized to upper case), and `AGENT_TEAMS_AUTOSTART=0` cannot be overridden: an explicit non-zero value is reported in `ignoredEnvOverrides` and ignored. `rollback` without an explicit version uses only the pointer's `previous`, failing with `HOT_UPDATE_NO_ROLLBACK_TARGET` when there is none and `HOT_UPDATE_PREVIOUS_MISSING` when that version's directory is gone. A failed `undo` raises `HOT_UPDATE_UNDO_FAILED`, attached to the original error as `details.undoError`, and keeps the journal for the next recovery pass. `build --commit <sha>` still asks git for tree status, warns about uncommitted tracked changes, and warns again when git cannot report at all instead of assuming a clean tree.

**Consequences:** Recovery now has a single authoritative witness — a pointer that names the swap — instead of inferring commit state from a journal the crash window can outlive, and the pointer schema grows one installer-only field (`swapId`) that the shell ignores. A journal left by an older installer is read conservatively, so upgrading needs no manual cleanup; the cost is that such a journal is restored even if its pointer did switch, which leaves a pointer whose digest no longer matches and makes the shell fall back to the packaged runtime (fail closed, `status` reports it). Two behaviours change for operators: `rollback` with no argument can now fail where it previously switched to "some other version" (the error tells them to name one), and a probe that asks for autostart is told it was ignored instead of quietly starting a daemon. The `syncFile` seam is a test hook only; production always uses the fsync implementation. Only file content is flushed — directory entries are not fsynced — so the guarantee is that a published file never contains stale bytes, not that a power loss cannot lose the rename itself on a filesystem that reorders it. Publishing is still a directory rename, so these are local-filesystem guarantees, and the manifest still is not a signature.

## ADR-0022: The daemon owns the task closed loop, not the captain

**Context:** A task graph only guarantees that dependencies unlock; it does not guarantee that a completed implementation is ever reviewed, that a failed review is repaired, or that the captain remembers to create either row. Real runs showed three failures of the manual approach: a completed implementation sat unreviewed until the captain noticed; a review that failed with findings stayed red with nobody to fix it; and when the captain did create the work, a follow-up was assigned back to the original implementer or queued behind them while other members sat idle. Earlier planners also created review and repair only from the failing `completeTask` call, so a crash between closing the task and writing the follow-up lost the chain forever, and a repeated tick could create duplicates. Priority was effectively FIFO, so a low-priority task holding the only qualified member could block the task the whole chain was waiting for.

**Decision:** `applyClosedLoop` runs on every terminal transition and again from a per-tick sweep and `reconcileAfterRestart`. A completed implementation/repair fans out, in one synchronous planner pass, the mandatory review plus (when the task asks) an independent verification plus (when the completion already reports findings) a repair; every row is keyed by a deterministic id (`review-<id>`, `verify-<id>`, `repair-known-<id>`, `repair-<reviewId>`) and an existing row of the same meaning always wins, whether it was created by the loop, by a human, or by a previous daemon process. A failed review creates exactly one repair keyed to the review and its findings; a completed repair creates the next review; the round ceiling (`codeMaxRounds`, default 3) and the repair-attempt ceiling stop the loop and send one `closed-loop` message to the captain with task, round and findings. Assignees come from the role pools by least load, never by "the person who did it before": the review is never the implementer, rows planned together are treated as claimed so they land on different members, and a repair prefers a free alternative engineer unless the source declares `repairContinuity` and the original is free in round 1. Scheduling ranks ready work into critical (explicit critical, has downstream dependents, or a review/repair), normal, and low/independent-retry, keeps FIFO inside a band, and pauses the most recently started lower-band task when a critical task needs its slot or its only eligible member; the paused task keeps its worktree and evidence. A task whose member session is gone or whose lease expired is completed from its recorded evidence (passed acceptance + in-scope changed paths) rather than failed, and only then enters the loop. `taskDeliveryState` gives the UI `queued` (待交付) for ready-but-waiting tasks, so grey is not red.

**Consequences:** The captain never has to create a review or a repair; the loop runs to pass or to an explicit escalation, and a restart, a repeated tick, a manual row or a crashed daemon cannot duplicate a row. The cost is more rows per completion (three for a task that asks for verification and reports findings) and a review/verification fan-out that is not free: every implementation can now occupy a second and third member. Priority and preemption trade some throughput of low-priority work for latency on the critical chain, and a paused low-priority task pays a new attempt/worktree on resume. Evidence recovery can only be as good as the evidence a member wrote before its session died; without evidence the task is requeued, never silently completed. The plan/repair `inScope` is still derived from findings text, so a finding that names no writable file escalates instead of inventing scope, and a review that fails without findings stops the loop rather than creating a repair nobody can act on.
## ADR-0023: The daemon writes the 15-minute patrol report; the captain only reads it

**Context:** The v0.6 patrol woke the captain with a compact prompt and asked it to inspect the team. That produced no reliability guarantee: the report depended on the captain's turn, a busy captain fell back to a patrol contractor, and a team with a working member could go unreported for an arbitrary time. It also left no fixed answer to "is the direction drifting?" or "what should happen next?", and a captain restart lost the interval because the cursor lived only in memory.

**Decision:** The daemon generates the report itself. `buildPatrolReport` (`src/service/patrol-run.mjs`) is a pure function over team state and returns the Chinese text fixed by `docs/decisions.md`: conclusion (正常/注意/风险/方向可能跑偏 with an explicit direction line), task overview, executing tasks (member, elapsed, last activity), waiting tasks and reasons, broken chains (completed without review, failed review without repair, completed repair without re-review, long-unclaimed), schedule/capacity (quota, idle eligible members, queue bottleneck), risks (repeated ECONNRESET/timeout, runtime timeout or no progress, scope drift, consecutive review failures), and suggested actions (继续/换人/返修/暂停/上报主代理). The report is read-only; the patrol path never edits code, creates tasks, or merges. `patrol.intervalMinutes` defaults to 15 and `patrol.whenCaptainBusy` defaults to `queue`: a busy captain gets the report queued in its session, never a substitute contractor and never a dropped message. A missing session is created; a stale persisted session id is cleared, recreated and retried once inside the same window. Other send failures emit `patrol.report_failed`, consume the window, and retry on the next one without blocking `tickAll`. `lastPatrolAt` is persisted on the team row and hydrated into the in-memory cursor at startup, so a restart inside the window does not duplicate a report. Scheduled reports require at least one unfinished task and at least one member with `status=working`/`workState=busy`; idle or empty teams are skipped. The legacy one-shot contractor is opt-in via `whenCaptainBusy=one-shot-contractor`.

**Consequences:** Reporting no longer depends on the captain's availability or willingness to ask, and every report answers the drift and next-action questions in a stable shape. The cost is that the daemon computes the facts it reports, so a fact the state does not record (for example a member's subjective confidence) cannot appear; the captain may still act on the report with its normal authority. Long-unclaimed and bottleneck heuristics use the patrol interval as their threshold, so a short interval makes the report more sensitive. `patrol.report_failed` is a warning, not a state change: the team keeps scheduling, and a persistent provider failure simply produces one failed report per window until delivery recovers. Manual `POST /teams/:id/patrol` stays available and intentionally bypasses the window and the working-member check, but it still refuses an empty team.

## ADR-0024: Continue the same task and session instead of creating retry copies

**Context:** A provider/network turn failure used to return the task to `pending` and re-dispatch a full task prompt. Owners compensated by creating new tasks whose subjects carried a "（重试）" suffix, which fragmented the task tree, dependencies and review history and hid the number of real failures. The requirement is to keep working on the original task: same task id, same subject, same member session, with only the attempt counter advancing.

**Decision:** A turn failure reported by `watchTurn.onFailed` is classified by `isRetryableTurnError`. Explicit `retryable:false`, hard quota and clear invalid/auth/context errors are final. Retryable errors (ECONNRESET, timeout, rate limit, provider 5xx, and unknown transient failures) keep the task `in_progress`, close the failed attempt, open the next attempt on the same task, and after an exponential backoff (default 3s/6s/12s, provider `retryAfterMs` wins) send the literal message `继续` to the same session. At most `zcode.turnFailureRetry.maxAttempts` (3) automatic continues are allowed; the next failure marks the task `failed` and retains `lastTurnError`/`lastSessionId`. A completed turn resets the budget. Dispatch-time send/create errors, watcher-stop errors and cursor failures keep the older pending requeue. If the session is gone, the same task is requeued to `pending` so a fresh session can be created; no new task is ever created and the subject is never rewritten.

Manual takeover is `agent_teams_continue_task` (HTTP `POST /teams/:id/tasks/:taskId/continue`). It accepts only `failed` tasks, restarts the same task id in `in_progress`, sends `继续` immediately and grants a fresh three-continue budget. Permission is the admin/captain token or the declared license capability `task:continue`; reviewer/auditor role defaults include it, plain members do not.

A one-shot contractor is not a member and has no broad team tools, but its runner applies the same `继续` policy to the contractor's **own** session: a retryable `send` error reuses that session for up to three continues, bounded by the contractor lifetime and cancellation checks, and records `contractor.continue_scheduled` before `contractor.failed`. A running protocol contractor is also issued a contractor-scoped token and a minimal member MCP server exposing only `agent_teams_continue_task`; HTTP accepts that token only on `POST /teams/:id/tasks/:taskId/continue`, and only while the contractor is `running`. The contractor record declares `capabilities: ['task:continue']`; all other routes and team tools stay denied, including the plugin admin server's copy of the tool. Plain members without `task:continue` remain denied.

**Consequences:** Attempt rows now represent retry generations of one task and remain the only place where stale updates are rejected. Reviewers must use `continue` rather than creating a "（重试）" task. The automatic path is observable through `task.turn_failed`/`task.continue_scheduled`/`task.continued` and the manual path through `task.continue_requested`. Capacity failures still reduce worker slots while continuing in the same session. Session-death fallback is recorded as `task.continue_session_lost`; it is the only case where the full task prompt is sent again, and it still reuses the task id.

## ADR-0025: Review a red box automatically and escalate after three continues

**Context:** A task that turns `failed` renders as a red branch in the task tree, but nothing acts on it: the member session is still alive and only a human notices the red box. The requirement is autonomous recovery with a hard stop: send `继续`, count, and hand over to the captain after three failed automatic continues. It must not spawn implementation tasks, must not flood the tree with red review nodes, and must not consume implementation worker slots. ADR-0024 already retries a *turn* up to three times on the same task/session, so this review is the next layer, not a replacement.

**Decision:** When any non-review task enters `failed` (`handleTurnFailure` after the turn budget is exhausted, `completeTask` on a self-reported or verify-forced failure), the daemon creates one review task with the dedicated kind `red-auto-review`, `hidden: true`, subject `自动继续审查`, and no assignee, attempt or lease. The review does exactly one thing: `continueTask` on the failed task (the literal message `继续`, same task id/subject/session). It runs on a microtask from the daemon, so the caller and the tick never wait, and it never occupies a worker slot; alternatively a contractor with `purpose: 'red_auto_review'` runs it in its slot without a model session. Idempotency comes from a deterministic id, `redreview_<sha1(taskId + ':' + lastAttemptId)>`; repeated hooks, ticks, sweeps and restarts resolve to the same row. `tick()` sweeps for missed events and deferred reviews, and reopens a review that `halt` cancelled. The count is per task+session (`redContinueCount`, reset by `redContinueSessionId` change, a completed turn, task completion or a manual continue). At `zcode.redAutoReview.maxContinues` (default 3) the daemon sends one urgent message to the captain containing taskId, subject, count, sessionId and the last error, sets `redReviewEscalated`, and stops. Permission is the captain token, a reviewer/auditor license (`task:continue`), a `red_auto_review` contractor, or the daemon's own system actor; a plain member is denied with `403` and `red_review.denied`. Review rows are hidden from `GET /teams/:id`, `GET /teams/:id/tasks`, the panel snapshot and `audit()`, always finish as `completed` with an `outcome`, and are summarized as `redReviews` in the team payload.

**Consequences:** A red box is no longer a terminal human-only state; it is the trigger for one bounded automatic recovery attempt per failure event, and the captain is only involved when the automatic layer is exhausted or cannot act. Because each review `继续` grants a fresh turn budget, one escalation can span up to four red boxes (3 turn continues + 1 review continue each), which is the documented cost of the layered design. The review deliberately does not judge whether a failure is worth continuing: a deterministic failure (for example a failing verify command) is also continued up to the limit and then escalated; `zcode.redAutoReview.enabled=false` disables the layer. Hidden rows mean the live tree stays honest but a captain inspecting only the tree will not see the review history — the `redReviews` summary and post-mortem are the supported views. Unfinished reviews stay `in_progress` when the daemon stops and are re-run by the next start's sweep.

## ADR-0026: Headless contractors review with a write-tool denylist, not plan mode

**Context:** A `read-only` contractor was created with session `mode=plan` and `Bash` in `disallowedTools`. A headless ZCode turn has nobody to answer the permission prompt that plan mode raises for a shell command, so a `post_merge_review` contractor could not run `npm test` or `git diff` at all: every merge review sat until its 15-minute lifetime expired and the merge was marked `review_pending_internal`. Denying Bash by name does not fix the prompt — plan mode raises it before the denylist is consulted for allowed tools. A second failure compounded it: on timeout the runner threw a generic `contractor timed out`, the record kept the session id, and the CLI adapter killed only the Node wrapper, leaving the app-server grandchild as an orphan.

**Decision:** A contractor has three stored modes: `read-only` (default), `review` (derived for review purposes) and `workspace-write` (explicit implementation only). `resolveContractorMode` in `src/domain/team-tools.mjs` rejects unknown modes and rejects `workspace-write` for `post_merge_review`, `merge_verify`, `merge_review`, `merge`, `red_auto_review` and `patrol`; those purposes always resolve to `review` (the merge slot only accepts these purposes, so no merge contractor can write the tree it is merging). Every mode runs the session in the host's headless worker mode (`isolation.workerMode ?? zcode.mode`, `yolo` by default) — never `plan`. `contractorExecutionPolicy` builds the denylist: `read-only` and `review` deny `Edit`, `Write`, `MultiEdit`, `ApplyPatch`, `apply_patch` and `NotebookEdit` while leaving `Bash` available; `workspace-write` omits the write denylist. Every contractor keeps the team-tool denylist (merge/approve/delete/create and every other team tool) and the model-policy denylist, so write protection is not lost — a reviewer can read, run tests and inspect git, but cannot edit the product or merge its own verdict. The lifetime also covers session creation (`runContractor` passes the contractor `lifetimeMs` to `adapter.create` as `timeoutMs`), because a hanging create has no session id for `stop` to clean up and only the adapter's own timer can kill its process tree. A timeout is raised as `E_CONTRACTOR_TIMEOUT` with `contractor (<purpose>) timed out after <ms>ms` (adapter wording is normalised to it; provider retry errors keep their code), and cleanup runs stop-then-close. A successful cleanup clears the session id; a cleanup that cannot prove termination keeps the runner error plus `cleanupError` under `cleanup_error` and retains the session id, so the slot stays occupied. A CLI turn's clean, unsignalled process exit is recorded as termination evidence and each new send invalidates the prior record; an explicit kill retries cleanup and, if termination is still unproven, releases the row as `orphaned` with an audited `releaseReason`. `src/session/process-tree.mjs` kills the whole process tree (`taskkill /T /F` on Windows, a detached process group on POSIX) on CLI timeout, stop and shutdown.

**Consequences:** Post-merge review can actually execute its checks, so the 15-minute stall disappears and a verdict reflects real test output. The write barrier is now the tool denylist plus the worktree/container boundary, not the session permission mode: a shell can still write files (`echo > f`, a build script), and that residual risk is documented in `docs/known-limits.md`; container isolation remains the boundary for untrusted work. `workspace-write` contractors are still allowed for explicit implementation purposes and still cannot merge, approve or delete. The CLI adapter now reports a failed tree kill instead of silently swallowing it, and a killed tree surfaces as the contractor's timeout/cleanup error rather than an orphan process. Because review purposes can never be promoted, a caller that asks for `workspace-write` review gets `400 E_INVALID` before a contractor row is queued.

## ADR-0027: Remove the cost-budget gateway

**Context:** The project shipped an optional OpenAI-compatible token gateway plus per-license `budgetUsd`, `config.cost`, and a `budget_paused` team control. Provider quotas and the existing `turnFailureRetry` capacity handling already cover the practical failure modes; the gateway added a second process, a separate accounting model and a team state that no longer matched how the team is operated. It also kept a second definition of "budget" alongside turn/continue/roster budgets, which made logs and prompts ambiguous.

**Decision:** Delete `src/gateway.mjs` and its tests, the `gateway` script, `config.cost` defaults and validation, all `budgetUsd` inputs, and the `budget_paused` control. `isolation.network=gateway-only` is a network isolation mode and is intentionally kept; it has nothing to do with the removed cost gateway. A persisted legacy `control=budget_paused` is still blocked from scheduling and delivery because every non-`active` control is blocked; operators must explicitly resume such a team. Provider quota/429 handling remains in `turnFailureRetry` and capacity recovery.

**Consequences:** One less process and one less state machine to operate, and "budget" now means only a retry/continue/roster limit. Cost visibility is delegated to the provider's own dashboard/quota, so the daemon no longer reports spend or hard-stops at a dollar boundary. Existing configs that still contain `cost` are rejected by the schema until the section is removed; archived documents and ADR-0006 retain the historical design.

## ADR-0028: Bound non-archived event retention

**Context:** ADR-0003 made events append-only, and the daemon now writes enough scheduler/review/patrol events that an unpruned `state.db` grows without bound. SPEC 11.1 also promises that archives retain their history. A plain "delete the oldest 50,000 rows" rule would silently delete archived-team events, so the cap and the archive promise conflict unless the sweep distinguishes team phase.

**Decision:** Keep events append-only at runtime. At daemon startup, select the cutoff from the non-archived events only: order those rows by id descending, take the row at offset `maxRows` (the (maxRows+1)th newest live row), and delete non-archived rows with id ≤ that cutoff. Archived rows do not consume the live retention window, so the non-archived tail keeps at most `maxRows` events even when newer archived events exist; the physical table may exceed 50,000 because archived rows are exempt. `Store.pruneEvents(maxRows)` implements the sweep and is wired in `src/daemon.mjs`; the limit is not configurable yet.

**Consequences:** Normal operation keeps a bounded event history and startup cost, while archive/audit data is never removed by the automatic sweep. A large archived history can exceed the cap and must be exported or vacuumed by an operator. Deleted events cannot be replayed, so any external audit export must run before the non-archived tail reaches the limit. Tests cover the under-cap no-op, the newest-rows deletion, and archived-team exemption.

## ADR-0029: Localize display with one resolved locale/time zone; keep internal prompts English

**Context:** `zcode.locale` existed as a config key but no code read it, strings were formatted with the host's `Date` methods, and the patrol report was a fixed Chinese document even though it is delivered to the captain model. A user running on a Japanese or Korean host had no way to set a display language, and a workspace on a non-UTC host produced ambiguous report times. At the same time, mixing translated prose into prompts, tool descriptions and agent templates makes model behavior depend on the user's language and makes every prompt change a translation task.

**Decision:** Add `src/i18n.mjs`, a pure module with `SUPPORTED_LOCALES = ['zh-CN','ja-JP','ko-KR','en-US']`, `normalizeLocale`, `detectSystemLocale`, `detectSystemTimeZone`, `resolveLocale`, `resolveTimeZone` and `formatDateTime`, all with injectable `env`/`intl`. Locale detection follows `AGENT_TEAMS_LOCALE` > `ZCODE_LOCALE` > `LC_ALL` > `LC_MESSAGES` > `LANG` > Intl > `en-US`; time-zone detection follows `AGENT_TEAMS_TIMEZONE` > `TZ` > Intl > `UTC`, validating every candidate through `Intl.DateTimeFormat`. `zcode.locale` and the new `zcode.timezone` default to `auto`; validation rejects explicit invalid values, and `loadConfig` resolves `auto` to concrete values after validation without rewriting the user's file or retaining a preference key. The install plan writes concrete values once, `buildUiConsole` exposes `localization: { locale, timeZone }`, and the patrol report formats its timestamps with the resolved values. Internal material — prompts, `initialize.instructions`, MCP descriptions/examples, agent templates, skill and command files — is English only; user-visible installer/CLI/panel strings may be localized through `locales/<locale>.json`.

**Consequences:** Display language and report time zone are explainable and testable from one module, and a bad explicit value fails at config time instead of silently falling back. `config/local.json` never stores `auto`, so a daemon restart resolves the same values the installer saw; changing the language requires editing the file or re-running the wizard. This supersedes the "Chinese text" part of ADR-0023: the patrol report is now English (only its data keeps its original language), while the shape and the read-only contract are unchanged. Translation work moves to a catalog with a source key set, and prompts no longer need a per-language variant. The cost is a second translation surface to keep in sync, and a user-visible string added outside `locales/` is a review finding.

## ADR-0030 - Ownership-scoped storage reclamation

Shared per-user member homes cannot be classified from one workspace database alone. Automatic
reclamation therefore requires explicit scheduler opt-in, a matching workspace owner marker and
an absent member UUID. Existing member rows, including archived and removed history, pin homes.
Legacy unmarked homes require a separately reviewed inventory and human authorization. Session
rebuilds keep the member identity and home. Unconfirmed termination pins a retired home for inspection.

Empty discovery directories are removed with rmdir after seven days, preserving runtime and lock
files and the active-workspace hint. This refuses a racing bootstrap that makes the directory nonempty.
Supervisor logs keep one rotated backup. Database compaction uses the store's committed connection
outside transactions and checkpoints around VACUUM; existing event-retention exemptions stay intact.

## ADR-0031: Record the existing strict-attempt continuation contract

**Context:** The 2026-11-03 handoff and `docs/contracts.md` already require explicit attempt IDs, but SPEC 4.4 still described the superseded omitted-ID shortcut. Comparing a modular extraction against an older Git commit therefore conflates that earlier security change with the extraction.

**Decision:** Align SPEC and migration guidance with the existing implementation: claim, heartbeat and update must carry the current attempt ID, even after `继续`. A missing ID must never be inferred from the assignee. Normal dispatch and task continue include `Attempt id: <new attempt>`; red review delegates to the same task continuation path. Contractor self-turn retries are not task claims and do not grant a task attempt.

**Consequences:** A delayed reply cannot gain authority over a newer attempt. Older clients must read the new ID and explicitly send it. This ADR records the already-documented safety contract; it does not introduce a new scheduling policy as part of modularization. Historical ADRs remain unchanged.

## ADR-0032: Keep extracted service orchestration behind stable entry points

**Context:** Scheduler, MCP and hot-update files combined unrelated lifecycles, making recovery paths hard to inspect. Moving whole blocks without naming their control-flow boundaries would only relocate that complexity.

**Decision:** Keep public entry points and dynamic TeamService delegation, while separating dispatch/worktree preparation, session startup/cursor/failure handling, red-review recovery, post-merge repair, patrol ownership/outbox delivery, MCP transport/access/tool mapping, and hot-update package/lock/pointer/publication responsibilities. Defaults stay in their owning modules; facade methods name their arguments rather than forwarding opaque rest arrays.

**Consequences:** Pure extraction preserves ordering, attempts, leases, merge/isolation checks and test behavior. Independently identified recovery bugs and English-prompt corrections are documented and tested separately from extraction. In particular, capacity deferrals must return to the ready pool, busy deferrals must preserve the current row, and a hidden red review must recover after halt/resume without becoming a normal worker task. Unknown session ownership remains fail-closed. A smaller facade is not a claim that every large service method or production acceptance gap is solved.

## ADR-0033: Bridge the native Subagents worker model selection

**Context:** The user explicitly requested an agent-teams entry in native ZCode Settings / Subagents so workers can use DeepSeek while the captain conversation uses GPT. Plugin-agent registration alone cannot achieve this: daemon-created sessions do not inherit the host's plugin-agent override, and follow-host would overwrite it.

**Decision:** Declare one `team-worker` plugin agent and read the host's stable plugin-agent model selection through a small read-only adapter. Resolve the installed plugin identity by proven paths, not same-name guessing. An explicit selection pins ordinary members, leads and model-backed contractors above fixed/follow-host; inherit preserves prior behavior. Captain and shadow are excluded. Carry structured provider/model/options values through Protocol `session/setModel` so slash-containing identifiers are unambiguous. The watcher observes native selection changes; contractors keep their submission snapshot. An incapable CLI/container adapter or an invalid/ambiguous selection fails visibly rather than falling back to a different model.

**Consequences:** Model choice remains in the user's native Settings UI, with no new credential store or cost gateway. One shared selector is not a per-member native session list. Plugin registration requires a manual install/update and new-session trial; source tests cannot claim native visibility or provider acceptance. Existing roster, concurrency, authorization and attempt isolation remain unchanged. This is a separately authorized feature, not behavior-preserving refactoring.

## ADR-0034: Bound Windows staging publication retries and retain competing targets

**Context:** A frozen full run failed on Windows with `EPERM` in staging-to-target rename. A targeted rerun passed, which did not prove a repair or establish the operating-system cause. Inspection and entry-point tests found no demonstrated local file-handle leak. A retry also creates another opportunity for an outside writer to introduce a target, so recovery cannot assume every target belongs to the failed publication.

**Decision:** Retry only Windows staging-to-target `EPERM`/`EBUSY`, at most five calls with 25/50/75/100 ms delays and a monotonic 1000 ms scheduling budget. Recheck target absence before each attempt. Do not replace rename with copy/remove or broaden backup, rollback, lock or pointer retries. A failed publish does not own a competing target and must preserve it. New forced-swap journals include `stagedIdentity` (device/inode); uncommitted recovery retains an identity-mismatched target, backup and journal and reports the conflict. A verifying pointer committed for the same swap still takes priority; older journals without identity keep their previous semantics.

**Consequences:** This is an explicit bounded publication bug fix, not a behavior-identical extraction. Persistent denials still fail, and the scheduling budget cannot cancel an OS call already executing. The lock coordinates participating writers; target checks are not an atomic no-replace primitive against arbitrary external mutation. The original operating-system cause remains unknown. Deterministic build/install/recovery tests cover retry success, exhaustion, deadline, excluded platform/error cases, target competition and rollback; bypassing the retry fails the success tests.

## ADR-0035: Use bounded unique wire IDs for shell host requests

**Context:** A runtime may reuse a request ID after a timeout, across runtime generations, or while another host-to-runtime request is pending. Serializing by the runtime's original ID leaves late responses and cancellation notifications ambiguous; retaining timeout tombstones also consumes state indefinitely.

**Decision:** The shell assigns every runtime-to-host request a unique `shell:host:<n>` wire ID and stores a bounded mapping to the owning runtime generation and original ID. The deadline begins when the runtime request is accepted. Timeout, runtime exit, cancellation, forwarding failure and shell close remove the mapping; late responses are ignored. Runtime-origin cancellation is rewritten to the wire ID for the host, while host-origin cancellation is looked up by wire ID and rewritten to the runtime's original ID. Generated wire IDs avoid IDs in the host-to-runtime pending table, and a conflicting host-to-runtime request fails closed. The outstanding runtime-to-host map is capped at 1000 entries.

**Consequences:** Same-ID retries and hot switches cannot consume each other's responses, and cancellation releases capacity deterministically. The host sees shell IDs rather than runtime IDs and must return those IDs in responses. This is a protocol-boundary correction, not a scheduler or retry-policy change; a host that discards the wire ID cannot receive a routed response. Focused shell and boundary tests cover deadlines, cancellation, late responses, capacity, invalid IDs, asynchronous forwarding failure and ID collision avoidance.
