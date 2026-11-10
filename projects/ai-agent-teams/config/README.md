# Configuration

The canonical config is JSON. `config/schema.json` is an editor/reference schema; the executable validator is `src/config.mjs`, which applies documented defaults before checking. A fully specified config (like the examples) satisfies both. `config/example.v06.json` is the default for `npm start`; `config/example.two-teams.json` is the legacy 6/3-3 example. `config/example.minimal.json` is a worktree-only minimal example. `config/schema.json` is the JSON Schema; `src/config.mjs` enforces the semantic constraints the schema cannot express.

## Top-level fields

| Field | Default | Constraints |
| --- | --- | --- |
| `version` | 1 | must be `1` |
| `captain.name` | `captain` | non-empty |
| `captain.model` | `null` | string or null |
| `captain.maxTeams` | 2 | `1` or `2` |
| `automation.mode` | `standard` | `standard`, `full-access` |
| `shadow.enabled` | `true` | boolean; enables the idle auto-stop clock |
| `shadow.idleStopMinutes` | `30` | 1..1440; an active shadow auto-stops only after this window and only when no team has unfinished work and no contractor is running |
| `teams` | 2 teams | 1 or 2 entries |
| `scheduler.preset` | `null` | `null`, `conservative`, `balanced` |
| `scheduler.memoryGb` | `null` | 8..1024; used by preset |
| `scheduler.activeWorkerSlots` | 6 (legacy) or preset | 1..64; >32 needs `allowAboveDesignCap`; values above the 32-worker design cap are not a single-host guarantee |
| `scheduler.maxActivePerTeam` | 3 (legacy) or preset | 1..activeWorkerSlots |
| `scheduler.minActivePerTeam` | 1 (legacy) or 6 (dual preset) | 1..maxActivePerTeam |
| `scheduler.maxControlSessions` | 5 | 1..128 |
| `scheduler.maxTotalSessions` | 32 | >= activeWorkerSlots |
| `scheduler.allowAboveDesignCap` | `false` | boolean |
| `scheduler.fairness` | `equal` | `equal` or `priority` |
| `scheduler.dynamicTeams` | `false` | boolean; total cap only, ignores per-team cap |
| `scheduler.maxTurnsPerTask` | 30 | > 0 |
| `scheduler.taskTimeoutMinutes` | 120 | > 0 |
| `scheduler.idleSessionMinutes` | 30 | > 0 |
| `scheduler.worktreeTtlHours` | 24 | 0..720; a terminal task's checkout is reclaimed after this many hours |
| `scheduler.maxConcurrentWorktrees` | 6 | 1..64; soft ceiling on task checkouts kept on disk |
| `scheduler.worktreeReclaimMinutes` | 30 | 0..1440; periodic reclaim interval, 0 disables it |

A task checkout is removed only when the task is terminal (merged, cancelled, failed, or completed with its commit already published) **and** the directory has no uncommitted or untracked changes. A dirty checkout is kept and reported as `task.worktree_reclaim_skipped`; the reclaimer never uses `--force`. Directories that no task references are swept only by the daemon, never by a test harness.

## Team fields

| Field | Default | Constraints |
| --- | --- | --- |
| `id` | - | unique, file-safe |
| `name` | - | non-empty |
| `lead` | - | unique member name |
| `defaultMembers` | 16 | 8..maxMembers |
| `maxMembers` | 32 | 8..32 |
| `baseBranch` | `main` | non-empty |

The validator rejects `defaultMembers > maxMembers`, `maxMembers > 32`, either field below 8, duplicate team ids, and duplicate lead names. The 8–32 range is the employee roster budget; it is independent of worker concurrency.

## Isolation

| Field | Default | Values |
| --- | --- | --- |
| `mode` | `worktree` | `worktree`, `container`, `microvm`, `none` |
| `containerRuntime` | `docker` | `docker`, `podman` |
| `image` | `ai-agent-teams-worker:latest` | local image or trusted registry reference |
| `imagePullPolicy` | `never` | `never`, `if-missing`, `always` |
| `network` | `gateway-only` | `gateway-only`, `none` |
| `readOnlyRoot` | `true` | boolean |
| `nonRoot` | `true` | boolean |
| `cpuLimit` | 2 | > 0 |
| `memoryMb` | 2048 | > 0 |
| `pidsLimit` | 512 | > 0 |

`worktree` gives each task its own working folder/branch: team members do not overwrite each other's files. It is **file separation, not a security boundary** and needs only git. 中文：worktree 就是每个任务一个独立工作目录，像复制一份项目，队员各改各的，但防不了恶意代码。

`imagePullPolicy=never` uses the local image only. `if-missing` pulls the configured image when it is absent; `always` pulls it at each daemon startup. Pulls require a reachable, trusted registry reference; a pull failure aborts container-mode startup without using a stale image. This only updates the selected worker image tag, not the pinned ZCode CLI source revision used to build it. Change that revision and rebuild the image to upgrade the CLI. The default `ai-agent-teams-worker:latest` is a local-build tag and is not a published registry image.

`none` is for local development only; it is not isolation. `container` requires Docker/Podman and is the standard stronger tier. `microvm` requires Kata/gVisor/Firecracker and is for advanced deployments.

## Interruption

| Field | Default | Values |
| --- | --- | --- |
| `defaultDelivery` | `queue` | `queue`, `guide` |
| `urgentDelivery` | `guide` | `guide`, `stop` |
| `hardStop` | `stop` | `stop`, `kill` |
| `cancelBackgroundTasks` | `true` | boolean |

`guide` may fall back to queue; the daemon should then use `stop` + `send` if the message is truly urgent.

## ZCode

| Field | Default | Values |
| --- | --- | --- |
| `cliPath` | `auto` | `auto` or path |
| `protocol` | `app-server` | `app-server`, `cli` |
| `mode` | `build` | `build`, `edit`, `plan`, `yolo`, `guarded` |
| `locale` | `auto` | `auto`, `zh-CN`, `ja-JP`, `ko-KR`, `en-US`; `auto` resolves `AGENT_TEAMS_LOCALE` > `ZCODE_LOCALE` > `LC_ALL` > `LC_MESSAGES` > `LANG` > platform locale > `en-US`, and `loadConfig` returns the resolved concrete value. Internal prompts, MCP descriptions and agent templates stay English |
| `timezone` | `auto` | `auto` or a valid IANA name (for example `Asia/Shanghai`); `auto` resolves `AGENT_TEAMS_TIMEZONE` > `TZ` > platform time zone > `UTC`; invalid explicit values are rejected by validation, and `loadConfig` returns the resolved concrete zone |
| `defaultModel` | `null` | string or null; `providerId/modelId` |
| `defaultReasoning` | `null` | string or null; passed to `session/setModel`, e.g. `max` |
| `modelPolicy` | `follow-host` | `follow-host`, `fixed`; `follow-host` resolves each member spawn from the captain session (`session.model.updated` in `~/.zcode/cli/log`, hot-switched every 3s); a real host value wins, then a member's explicit `model`/`reasoning`, then `defaultModel`/`defaultReasoning`; `fixed` pins `defaultModel` at startup or whatever `agent_teams_model set` pinned at runtime; `fixed` without `defaultModel` warns until `set` is called; `follow-host` with `isolation.mode=container` warns that hot switching is unsupported |
| `maxRequestsPerMinute` | 0 | 0..1000; spaces provider-facing member/contractor dispatch starts; 0 disables pacing; does not cap model turns/tool-loop requests |
| `maxConcurrentSessions` | max(6, `activeWorkerSlots`) | 1..64; must be >= `activeWorkerSlots` |
| `memberMcpServers` | `minimal` | a member-scoped `agent-teams-member` server is mounted; the plugin admin server is denied by exact tool name, and the full host MCP catalog is intentionally unsupported to preserve the member token boundary |
| `turnWatchIntervalMs` | 2000 | 500..60000; `session/events` poll interval for `turn.failed` |
| `turnFailureRetry` | enabled, 3 normal / 3 capacity retries | `enabled`, `maxAttempts`, `capacityMaxAttempts`, `baseDelayMs`, `maxDelayMs`, `capacityRecoveryMs`, `capacityRecoverySuccesses`; capacity/429 errors also reduce `activeWorkerSlots` before retrying; a provider `retryAfterMs` overrides `baseDelayMs` |
| `redAutoReview` | enabled, 3 continues | `enabled`, `maxContinues` (0..10), `retryDelayMs`, `maxAttempts`; when a task turns `failed` the daemon creates one hidden review that only sends `继续` to the same task/session (no worker slot, no model session, no code review); after `maxContinues` automatic continues per task/session it sends one urgent message to the captain and stops; `retryDelayMs`/`maxAttempts` bound the retry of a review that cannot send yet (for example the member still owns another open task); `enabled=false` disables the layer |

There is no `--model` flag. Per-member models use protocol `session/setModel`; for legacy configuration without a native worker pin, an unavailable protocol leaves the adapter default and emits a warning. An explicit native `team-worker` selection is stricter: an incapable adapter refuses model work rather than falling back. `defaultReasoning` is required by some providers (for example `provider-b/model-x`); the CLI adapter ignores it and `zcode.protocol=cli` emits a warning if model defaults are set. The daemon automatically selects app-server when `defaultModel` or `defaultReasoning` is set, even if `zcode.protocol` is `cli`; use `cli` only when the CLI's own default provider is already working.

With `modelPolicy=follow-host` the SessionStart hook writes the captain's session id to `<workspace>/.ai-agent-teams/host-session.json` (0600) because the daemon process does not inherit `ZCODE_SESSION_ID`. It only does this for a workspace that already has team state (`.ai-agent-teams/` or a valid `config/local.json`). The daemon reads that file (env fallback) and follows `session.model.updated` / `session.reasoning_effort.updated` from the host log; `agent_teams_model status|set|follow` inspects or overrides it. Hot switching needs an adapter with `supportsModelSwitch` (app-server); CLI/container spawns still receive the resolved model but report `unsupported` and are not retried. An all-failed switch retries with backoff, then emits one `model.follow_abandoned` and seals the value; member/contractor sessions cannot call the model tool.

In source version 0.2.2, native **Settings / Subagents / team-worker** provides one shared worker-model preference without adding a config key. An explicit selection overrides both `fixed` and `follow-host` for ordinary workers, leads and model-backed contractors, never the captain conversation or shadow. Removing it restores the original policy. The daemon only reads the host's installed-identity-bound state; no credentials or personal subagents are rewritten. Native pins require a protocol-capable adapter. Invalid state or an unhonored pin is visible and fails closed, not an implicit fallback. The full plugin must be manually updated to register the new native entry; a runtime-only update is insufficient. See `docs/guides/MIGRATION.md` for update and trial boundaries.

`memberMcpServers=minimal` is the default to keep worker context bounded. `turnFailureRetry` applies to the Protocol adapter: a `turn.failed` event closes the failed attempt and opens the next attempt on the **same task and session**, so the task stays `in_progress` and `继续` is sent after the backoff; it does not wait for `scheduler.taskTimeoutMinutes` (default 120) and never returns the task to `pending` unless the session is gone. The CLI adapter has no live event stream, but its send call is synchronous: provider JSON errors and JSON error payloads from nonzero exits are returned from `send` and use the same retry budget immediately; plain-text stderr yields the message and known codes but no retry hint. Mid-turn events and `guide` are unavailable; it fails closed without a member token.

When the turn budget is exhausted the task turns `failed` and `redAutoReview` takes over: one hidden review per failure event sends `继续` (max `maxContinues` per task/session) and then messages the captain. It uses no worker slot and no model session; a `purpose: red_auto_review` contractor can execute it instead. Set `redAutoReview.enabled=false` to keep failed tasks purely manual. Design: `docs/decisions.md` (ADR-0025, ADR-0032).

A provider `retryAfterMs`/`retryAfterSeconds`/HTTP-date hint overrides `baseDelayMs` for the next attempt, even when it is longer than `maxDelayMs`; it is capped at one hour. Dispatch-time `adapter.create`/`send` errors use the same retry budget, so a 429 cannot trigger a one-second retry loop.

Capacity reductions are persisted in `.ai-agent-teams/runtime-capacity.json` (relative to the workspace), so a daemon restart keeps the lower slot count. After `capacityRecoveryMs` (default 60000) and `capacityRecoverySuccesses` (default 3) consecutive successful turns, one slot is restored; the cycle repeats up to the configured `activeWorkerSlots`. A persisted value above the configured ceiling, a corrupt file, a different `version`, or a `configuredWorkerSlots` mismatch is ignored; persisted `successes` and `nextRecoveryAt` are clamped on load. A workspace is expected to run one daemon instance.

`maxConcurrentSessions` counts **worker sessions only**. Control sessions are outside this budget and use `scheduler.maxControlSessions` instead: one captain session per team (up to `captain.maxTeams: 2`), one lead per team, and the optional single workspace shadow, but only while that control seat has a live session. The effective worker limit is `min(activeWorkerSlots, maxConcurrentSessions)`. Contractor slots are separate: `contractors.slots.merge.cap` + `contractors.slots.patrol.cap`, each 0 or 1, no borrowing. `main` is a legacy alias for `patrol`; a config should use `patrol`. A `null` slot means "unset", not "disabled": it is removed before defaults are applied, so the slot comes back as `cap: 1`. Set an explicit `cap: 0` to disable a slot.

### Optional review pool configuration

`contractors.reviewPool` reserves a configuration shape for the reviewer pool.
It defaults to `{ "enabled": false, "capacity": 0 }`; the legacy `merge` and
`patrol` (or `main`) slots remain one each by default. The scheduler does not
yet implement the pool, so validation rejects `enabled: true` instead of
silently accepting an ineffective setting.

Capacity must be 0..10, and must be 1..10 when enabled. A disabled pool must
have capacity 0; enabling it requires `contractors.enabled: true`. The sum of
the legacy slot caps and enabled review pool capacity must fit within
`contractors.maxConcurrent`. When the pool is enabled,
`scheduler.maxTotalSessions` must cover active worker slots plus the review
pool capacity. The pool does not change the meaning of
`zcode.maxConcurrentSessions`, which continues to count worker sessions only.
`applyDefaults(raw)` materializes the defaults and `validateConfig(config)`
returns `{ ok, errors, warnings }`; `loadConfig(path)` applies both and throws
on validation errors. No scheduler API or reviewer dispatch behavior is added.

For the default **6 workers + 2 contractors** shape, use `activeWorkerSlots: 6`, `maxActivePerTeam: 6`, `maxConcurrentSessions: 6`, `contractors.slots.merge.cap: 1`, `contractors.slots.patrol.cap: 1`, and start with `maxRequestsPerMinute: 8`. The installer plan writes `maxRequestsPerMinute: 8`; reduce it if the provider's group RPM budget is lower, or raise it only after measuring the provider. Capacity/429 failures reduce `activeWorkerSlots` before retrying, so the next task waits for a real free slot instead of immediately hitting the same wall.

## Quality

| Field | Default | Notes |
| --- | --- | --- |
| `kinds` | all six quality kinds | subset allowed |
| `requireIndependentReview` | `true` | reviewer != implementer |
| `maxReviewRounds` | 3 | > 0 |
| `verifyCommands` | `[]` | template defaults; task contracts may override |
| `reviewPolicy.requirementsMinRounds` | 1 | >= 1 |
| `reviewPolicy.requirementsMaxRounds` | 2 | >= min |
| `reviewPolicy.codeMaxRounds` | 3 | >= 1 |
| `reviewPolicy.maxRepairAttempts` | 2 | >= 1 |
| `reviewPolicy.requiredReviewers` | `[]` | member names; must not be implementers |

## v0.6 settings

These settings are implemented in `src/config.mjs`, `src/domain/lifecycle.mjs`, and `config/example.v06.json`. Legacy configs without `features` still run 6 slots / 3 per team. The v0.6 config is the daemon/install default.

```json
{
  "features": {
    "lazyMembers": true,
    "licenses": true,
    "compression": true,
    "contractors": true,
    "patrol": true,
    "postMergeReview": true
  },
  "shadow": {
    "enabled": true,
    "idleStopMinutes": 30
  },
  "scheduler": {
    "preset": "balanced",
    "memoryGb": 32,
    "maxControlSessions": 5,
    "maxTotalSessions": 26,
    "allowAboveDesignCap": false
  },
  "contractors": {
    "enabled": true,
    "maxConcurrent": 2,
    "maxLifetimeMinutes": 15,
    "defaultPermission": "read-only",
    "allowBorrow": false,
    "slots": {
      "merge": { "cap": 1, "kinds": ["post_merge_review", "merge_verify", "merge_review", "merge"] },
      "patrol": { "cap": 1, "kinds": ["*"] }
    }
  },
  "patrol": {
    "enabled": true,
    "captainSelfWake": true,
    "intervalMinutes": 15,
    "whenCaptainBusy": "queue",
    "maxContractorPerCycle": 1,
    "timeoutMinutes": 30
  },
  "memory": {
    "highWatermarkPercent": 80,
    "lowWatermarkPercent": 65,
    "budgetMb": 24576,
    "availableIdleMinutes": 10,
    "waitingWarmMinutes": 3,
    "waitingColdMinutes": 10
  },
  "quality": {
    "postMergeReview": "contractor",
    "mergeBranch": "integration"
  }
}
```

### Shadow (小队长 / 影子主代理)

The shadow is an optional **control** seat, not a delivery worker. There is at most one per workspace. It has captain-level authority on both teams but acts under its own `memberId` and license; every non-GET action is audited as `shadow.action`.

| Item | Value |
| --- | --- |
| Seat | at most 1 per workspace; reused across restarts |
| Role name | `shadow` (aliases: `deputy`, `secretary`, `captain-delegate`, `小队长`) |
| Capabilities | `captain:delegate`, `task:continue` |
| Delivery kinds | `[]` — never auto-assigned a delivery task |
| Lifecycle | `stopped → starting → active → stopping → stopped`; failures land in `stop_failed` / `lastError` |
| Control sessions | counts against `scheduler.maxControlSessions` (default 5 = 2 per-team captain sessions + 2 per-team leads + 1 shadow, only counting seats with a live session) |
| Start / stop | `POST /api/v1/shadow/start` (captain/admin only); `POST /api/v1/shadow/stop` (captain/admin or the shadow itself); status at `GET /api/v1/shadow` |

Start it when the captain is overloaded or working on a long-running problem; stop it as soon as the delegated scope is closed. Starting is manual. A daemon clock auto-stops an active shadow after `shadow.idleStopMinutes` (default 30) **only** when no team has unfinished work and no contractor is running; a stop keeps the seat so the next start does not create a second shadow. If a stop fails with a live session, the state is `stop_failed`; retry stop before starting again. The single-seat invariant spans archived teams: if the seat itself belongs to an archived/staged team, retire that member with `DELETE /api/v1/teams/:team/members/:member` before starting a shadow on a running team. The shadow cannot relicense or delete its own seat; only the captain can retire it. It cannot review its own implementation or bypass attempts, leases, or quality gates. Product-code write tools (`Edit`, `Write`, `MultiEdit`, `ApplyPatch`, `NotebookEdit`) are denied to the shadow: it coordinates, while code changes go through normal tasks and gates. The full shadow coordination catalog requires the app-server/protocol adapter; the CLI adapter does not mount the member MCP server, so use app-server for a working shadow.

### Patrol

The daemon is the patrol clock. Every minute it checks each team; a team gets an
English-language inspection report at most once per `intervalMinutes` window.
The report text remains English; timestamps use the workspace's resolved locale
and time zone.

| Field | Default | Constraints | Notes |
| --- | --- | --- | --- |
| `patrol.enabled` | `features.patrol` | boolean | master switch for the scheduled report |
| `patrol.captainSelfWake` | `true` | boolean | create/wake the captain session before sending |
| `patrol.intervalMinutes` | `15` | integer >= 1 | fixed report window; one report per team per window |
| `patrol.whenCaptainBusy` | `queue` | `queue`, `one-shot-contractor`, `wait` | `queue` sends with `delivery=queue`, so a busy captain never loses the report; `one-shot-contractor` is the legacy patrol-contractor fallback; `wait` defers |
| `patrol.maxContractorPerCycle` | `1` | 0..2 | legacy contractor fallback only |
| `patrol.timeoutMinutes` | `30` | 1..1440 | record `patrol.stalled` and cancel a patrol that has been in flight longer than this |

Trigger: the team is `running`/`active`, has at least one unfinished task
(`pending`, `claimed`, `in_progress`), and at least one member is
`working`/`busy`. A fully idle team, an empty team, or a paused/archived team is
skipped and no report is sent.

`lastPatrolAt` is persisted on the team row. The daemon hydrates its per-team
cursor from that value at startup, so a restart inside the same window does not
send a duplicate report. A send failure writes `patrol.report_failed`; the
window is still consumed and the next window retries. `config/local.json` may
override any patrol field (workspace config wins over defaults).

An existing `config/example.v06.json` or `config/local.json` that still pins
`intervalMinutes: 10` and `whenCaptainBusy: "one-shot-contractor"` keeps the
legacy patrol; set those fields to `15` and `"queue"` to adopt the report
schedule described here.

The report format is fixed by the patrol contract in `docs/decisions.md`; the daemon only
reads team state and never edits code, creates tasks, or merges.

Preset guidance:

| Memory | Conservative single | Conservative dual | Balanced single | Balanced dual |
| --- | --- | --- | --- | --- |
| 16GB | 8 | 6+6 (max 8+8) | 16 | 6+6 (max 8+8) |
| 32GB | 16 | 8+8 | 16 | 10+10 |
| 64GB | 24 | 12+12 | 32 | 16+16 |

`allowAboveDesignCap: true` is the explicit override for users who need more than the design cap; it requires a warning and a hard cap check. Presets are recommendations, not platform guarantees.

## Precedence

CLI/env override > workspace config > user config > defaults. Do not put secrets in config; use environment variables.

## Migration

Every config has `version`. A migration script must be added when the shape changes; never silently reinterpret an old config. The validator must reject unknown versions.

## Examples

```bash
node src/cli.mjs validate-config config/example.two-teams.json
node src/cli.mjs validate-config config/example.v06.json
node src/cli.mjs plan config/example.two-teams.json examples/tasks.sample.json
npm run recommend
```


## Roster

`config/roster.two-teams.json` is the starting roster: 16 members per team, one lead per team. Each member has `name`, `role`, optional `model`, and optional `tool_policy`. The roster is separate from the config because it is data, not policy.

Rules:

- Member names are unique across both teams.
- Each team's `lead` in the config must appear in that team's roster.
- Each team starts with 16 members; the employee roster range is 8–32.
- Every task `assignee` must exist in the roster and belong to the task's team.
- A required reviewer must exist in the roster and must not be the implementer.

The roster is a starting point. A profile may replace it for a specific team template; the same validation rules apply.

### Member home reclamation

`scheduler.memberHomeReclaimMinutes` accepts null (default, disabled), 0 (startup only),
or 1..1440 (startup and periodic minutes). Only homes marked as owned by the current workspace
and missing from its members table are swept. Unmarked legacy homes require a reviewed inventory.
