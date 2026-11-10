# Contracts

The scheduler does not dispatch tasks marked archived, historical, superseded,
or held. Such rows remain available as history and do not become ready merely
because their dependencies have completed.

This file indexes current runtime/API contracts. Current configuration is defined by `config/schema.json`; current storage and runtime behavior are defined by source and tests. `SPEC.md` sections 3 and 13 are target design, not a source of current implementation claims.

## Team view

| Method | Path | Purpose |
| --- | --- | --- |
| GET/HEAD | `/ui` | packaged team view (`assets/team-view.html`) with snapshot and console aggregate; loopback-only, requires the per-process `uiAccessKey` (query key or HttpOnly cookie), sets an HttpOnly `agent_teams_ui_<port>` session cookie scoped to `/api/v1/ui`, no write access and no token in the HTML |
| GET | `/api/v1/ui/snapshot` | read-only team/member/task + contractor slot/status snapshot; accepts a Bearer UI token or the `agent_teams_ui_<port>` cookie; excludes license IDs, member tokens and contractor prompts |
| GET | `/api/v1/ui/console` | read-only aggregate for the web console: team phase/control, capacity, member session/settlement/license summaries, task merge/review/command/hold detail, merge queue, findings, patrol clock, pending mailbox, events, model policy and shadow status; accepts a Bearer UI/admin token or the UI cookie; excludes tokens, license IDs, session IDs, prompts, home directories and absolute drive paths; no workspace/pid/instanceId in its health block |
| GET | `/api/v1/ui/stream` | SSE refresh events for the UI; accepts a Bearer UI/admin token or the UI cookie; the legacy `?token=` query is still accepted for older clients but is no longer used by the page |

`/team-view` uses `node src/cli.mjs panel --open`, which reads the daemon discovery and opens the keyed panel URL. The page renders a live read-only snapshot and reloads on SSE refresh; opening the HTML directly falls back to the static example. The UI token is random per daemon process and cannot mutate teams.

Programmatic entry point: `node src/cli.mjs panel` resolves the current discovery, checks `/api/v1/health`, prints the URL plus instructions, and exits. `--json` returns the same data without the token; `--open` launches Edge, then Chrome, then the OS default browser only when the daemon is healthy and belongs to the requested workspace. `npm run panel` and `npm run panel:open` wrap those two commands. The daemon startup log and MCP `initialize.instructions` carry the same method.

## MCP App team card

| Item | Value |
| --- | --- |
| Tool | `agent_teams_view` (model+app) and `agent_teams_view_snapshot` (app-only) |
| Resource URI | `ui://ai-agent-teams/panel.html` |
| Resource MIME | `text/html;profile=mcp-app` |
| Data | `structuredContent` contains the same sanitized snapshot as `/api/v1/ui/snapshot` plus `viewUrl` |
| Fallback | The card links to the keyed `http://127.0.0.1:<port>/ui?key=...` URL |
| Native surface | `.zcode-plugin/plugin.json` declares `ui.surfaces` with `id=ai-agent-teams`, `server=agent-teams`, `resourceUri=ui://ai-agent-teams/panel.html`, `availability="session"`; the host lists it under the side pane's `+ 新增标签` menu and opens the same resource as a side-pane tab |
| Host note | ZCode 0.17 maps a `fullscreen` result with `surface` to its side-pane opener; `pip` is not implemented and no floating window is promised. ZCode 0.17 has no conversation-header contribution slot. A plugin `SessionStart` hook (`hooks/hooks.json`) injects the one-time startup rule; it is model-mediated, not a host popup. |

The panel is self-contained HTML built from `ui-src/team-panel.js` and `ui-src/team-panel.css` by `scripts/build-ui.mjs`. It refreshes through the app-only snapshot tool; it has no write API.

## HTTP API (v1)

Base: `http://127.0.0.1:<port>/api/v1`  
Auth: `Authorization: Bearer <token>`  
Content: JSON; times are epoch ms; paths are POSIX.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness/version |
| GET/POST | `/teams` | list/create teams |
| GET | `/teams/:id` | team detail |
| POST | `/teams/:id/archive` | archive |
| GET/POST | `/teams/:id/members` | roster |
| DELETE | `/teams/:id/members/:memberId` | remove member |
| GET/POST | `/teams/:id/tasks` | task list/create |
| PATCH | `/teams/:id/tasks/:taskId` | edit pending task via plan/amend where supported |
| POST | `/teams/:id/tasks/:taskId/reassign` | retry/reassign/takeover |
| POST | `/teams/:id/tasks/:taskId/continue` | continue a failed task with "继续" (captain or reviewer license) |
| GET/POST | `/teams/:id/messages` | mailbox |
| GET | `/messages/pending` | cross-team messages awaiting captain approval (admin) |
| POST | `/messages/:id/approve` | approve and deliver a cross-team message (admin) |
| POST | `/messages/:id/reject` | reject without delivery (admin) |
| GET | `/teams/:id/usage` | usage aggregation |
| GET | `/teams/:id/events?since=` | event log; each row returns `id`, `type`, `createdAt` and the event payload |
| GET | `/teams/:id/stream` | SSE |
| POST | `/teams/:id/plan/edit` | atomic plan add/edit |
| POST | `/teams/:id/plan/approve` | explicit human approval |
| POST | `/teams/:id/plan/discard` | archive draft |
| POST | `/teams/:id/halt` | halt one team |
| POST | `/teams/:id/resume` | resume with reason |
| POST | `/teams/:id/captain/message` | human → captain |
| POST | `/teams/:id/tasks/:taskId/claim` | member claim with attempt |
| POST | `/teams/:id/tasks/:taskId/update` | member update |
| POST | `/teams/:id/tasks/:taskId/heartbeat` | lease heartbeat |
| POST | `/teams/:id/tasks/:taskId/reassign` | retry/transfer/takeover |
| POST | `/teams/:id/tasks/:taskId/continue` | continue a failed task, same task id/session; captain or reviewer (`task:continue`) only |
| POST | `/teams/:id/tasks/:taskId/amend` | captain contract amendment |
| POST | `/teams/:id/tasks/:taskId/merge` | commit/merge, integration branch + post-merge review |
| DELETE | `/teams/:id/members/:memberId` | remove member |
| POST | `/teams/:id/members/:memberId/relicense` | settled-only license/name/role change; fresh session |
| POST | `/teams/:id/members/:memberId/sleep` | checkpoint summary and close session |
| POST | `/teams/:id/members/:memberId/wake` | mark a cold member warm; next task creates a session |
| POST | `/teams/:id/members/:memberId/compact` | compact context and store a summary |
| GET | `/teams/:id/members/:memberId/license-history` | license issue/revoke history |
| GET | `/teams/:id/licenses` | licenses for a team |
| GET/POST | `/teams/:id/contractors` | list contractors; POST submits a one-shot contractor (202 queued/running; poll the status endpoint; blocking spawn is internal only) |
| GET | `/teams/:id/contractors/:id` | contractor status/result by id (slot, queue state, terminal state) |
| POST | `/teams/:id/contractors/:id/kill` | cancel a queued/running contractor; may return `cancelling` while an in-flight create/send settles, then poll status |
| POST | `/teams/:id/patrol` | run one patrol now (manual: bypasses the 15-minute window, still requires unfinished work; scheduled patrols additionally require a working member) |
| GET | `/teams/:id/findings` | patrol findings |
| POST | `/teams/:id/findings/:id/close` | close a finding |
| GET | `/teams/:id/lifecycle` | hot/warm/cold counts and session budget |
| GET | `/model` | model policy status for the captain/UI: `policy`, `host` (model, reasoning, sessionId, sessionSource) and every member's model/reasoning/session; admin token only |
| POST | `/model` | `{action:'status'}` reads the status; `{action:'set', model, reasoning?}` pins a model and hot-applies it to live sessions; `{action:'follow'}` resumes following the host session; admin token only |
| GET | `/shadow` | shadow status: `status` (`stopped/starting/active/stopping/stop_failed`), `active`, `memberId`, `teamId`, `sessionId`, `startedAt`, `stoppedAt`, `lastActiveAt`, `transitionAt` and `lastError` |
| POST | `/shadow/start` | start the single workspace shadow; captain/admin only; idempotent when already active; creates the seat on first use |
| POST | `/shadow/stop` | stop the shadow session; captain/admin or the shadow itself; keeps the seat for a later restart |
| GET | `/teams/:id/soft-isolation` | soft-isolation self-check (worktree, homes, tokens, read-only policy) |
| POST | `/teams/:id/lifecycle/tick` | run idle/quota/memory eviction |

Auth: the discovery token is the admin token. Member sessions receive a member-scoped token (`store.getMemberToken`) and may only claim/update/heartbeat their own task, read their team, and send messages. Captain/admin routes return `403 E_FORBIDDEN` for member tokens. There are three exceptions. (1) `POST /teams/:id/tasks/:taskId/continue`: a member token is accepted only when its license carries the declared `task:continue` capability (reviewer/auditor roles get it by default). (2) A member whose license carries `captain:delegate` is the **shadow (小队长)**: it is treated as captain-level on every team, may read the global team list, and may call the captain routes. The shadow still writes actions under its own `memberId`, all of its non-GET actions emit `shadow.action`, and it cannot relicense or delete its own seat (`403 E_FORBIDDEN`) or use the human→captain mailbox. There is at most one shadow per workspace; a second shadow seat/license is rejected with `409 E_SHADOW_EXISTS`. Control capabilities are role-bound: `team:lead` belongs only to `role=lead`, `captain:delegate` only to `role=shadow`. A `POST /teams/:id/members/:memberId/relicense` that tries to add one to another role fails with `400 E_LEAD_CAPABILITY` / `400 E_SHADOW_CAPABILITY` (unknown capabilities fail with `400 E_CAPABILITY_UNKNOWN`), and a role=lead/shadow license always carries its control capability. (3) A member whose license carries `team:lead` may call the lead-managed routes on its own team only (`leadMayManageRoute`). The daemon and members run as the same OS user, so a member that can read the discovery file is not a true security boundary; use a separate OS user/container.

### Turn failure continuation

A member turn that fails with a retryable provider/network error (ECONNRESET, timeout, rate limit, provider 5xx) is continued on the **same task and same member session**: the daemon opens the next attempt on the same task id and sends `继续` after an exponential backoff (default 3s, 6s, 12s; `retryAfterMs` wins, capped at one hour). The prompt also carries `Attempt id: <new attempt>` and says the task id/subject did not change. The task stays `in_progress`; its id, subject and dependencies never change. After `zcode.turnFailureRetry.maxAttempts` (default 3) failed continues the task becomes `failed` and keeps `lastTurnError` plus `lastSessionId`. A successful turn resets the failure budget. Dispatch-time send/create errors, watcher-stop errors and cursor failures keep the older `pending` + `retryNotBefore` requeue. `agent_teams_continue_task` (captain/reviewer) restarts a `failed` task on the same task id, sets it back to `in_progress` and grants a fresh three-continue budget. A one-shot contractor gets the same `继续` retry for its **own** session (max 3, exponential backoff, bounded by the contractor lifetime, event `contractor.continue_scheduled`) before `contractor.failed`. Plain members without `task:continue` still get 403. Full design: `docs/decisions.md`.

**Attempt id after a continue.** A continue opens a new `attemptId` and includes it in the continue message. Claim, heartbeat and update require the caller to provide the current attempt ID; the daemon never infers it from the assignee because a delayed response from an earlier attempt could otherwise be attributed to the new one. Missing and stale IDs are rejected; MCP claim/update require `attempt_id`. HTTP uses `409 E_STALE_ATTEMPT` for a missing or stale ID, `E_STATE` for a terminal task or wrong state, and `403 E_FORBIDDEN` when a member attempts to update another member's task. Older clients that omit the ID must be updated before continuing work.

**Contractor tool surface.** A running protocol contractor receives a contractor-scoped token and the regular member MCP server (`agent-teams-member`). The member catalog is not filtered per session: the effective boundary is (1) `contractorContinueDenylist()` in `src/domain/team-tools.mjs`, which denies every team tool name shape except `agent_teams_continue_task`, and (2) the HTTP token scope, which accepts the contractor token only on `POST /teams/:teamId/tasks/:taskId/continue` and returns `403 E_FORBIDDEN` everywhere else. A queued/completed contractor token is invalid; the contractor record must declare `capabilities: ['task:continue']` (a missing list is fail-closed).

**Contractor permissions and timeout.** A contractor is submitted with `mode: read-only | review | workspace-write` (default `contractors.defaultPermission = read-only`). `resolveContractorMode` rejects any other value with `400 E_INVALID`; purposes `post_merge_review`, `merge_verify`, `merge_review`, `merge`, `red_auto_review` and `patrol` always resolve to `review`, and a review purpose that asks for `workspace-write` is rejected with `400 E_INVALID` before a contractor row is queued. Every contractor session runs in the host's headless worker mode (`isolation.workerMode ?? zcode.mode`, `yolo` by default), never `plan`: a headless turn cannot answer a permission prompt, and plan mode plus a Bash denylist was what stalled every post-merge review until its 15-minute lifetime expired. `contractorExecutionPolicy` builds the denylist: `read-only`/`review` deny file-writing tools (`Edit`, `Write`, `MultiEdit`, `ApplyPatch`, `apply_patch`, `NotebookEdit`) and keep `Bash` available for `npm test`, `node --test`, `git diff/status/log` and file reads; `workspace-write` omits the write denylist. Every mode keeps the team-tool denylist (create/edit-plan/approve/add/remove/reassign/merge/delete/spawn/kill and the rest) and the `agent_teams_model` denylist, so a reviewer can run checks but cannot write the product, merge, approve or delete. Session creation counts against the same lifetime: `runContractor` passes the contractor `lifetimeMs` to `adapter.create` as `timeoutMs` (and to the CLI adapter's `runCli` timer), because a hanging create has no session id for `stop` to clean up. When a turn, the creation or the whole run exceeds `timeoutMs` (capped at `contractors.maxLifetimeMinutes`), the contractor fails with `E_CONTRACTOR_TIMEOUT` and `contractor (<purpose>) timed out after <ms>ms`; adapter wording (`ZCode CLI timed out`, `protocol turn timed out`, `contractor timed out`) is normalised to that one error, a provider retry error keeps its own code, and cleanup runs stop-then-close. A successful cleanup clears the session id; a cleanup that cannot prove termination keeps both the runner error and `cleanupError` under `cleanup_error` and retains the session id, so the slot stays occupied until proof or an explicit operator kill. An explicit kill retries cleanup once; if termination is still unproven it releases the row as `orphaned` with `releaseReason='kill after unproven cleanup'` (or `kill after unproven creation` when no session identity exists). A CLI turn is a single wrapper process; only a clean, unsignalled exit (`exitCode===0 && signalCode===null`) is recorded as termination evidence, and each new send invalidates the previous turn's record. The CLI adapter kills the whole process tree on timeout/stop/shutdown (`taskkill /T /F` on Windows, a detached process group on POSIX), so the ZCode app-server grandchild is never left as an orphan. Design: `docs/decisions.md`; ADR-0026.

### Red box auto review

A task that turns red (`failed`) is reviewed automatically. This is the layer *after* turn retries:

1. `zcode.turnFailureRetry` continues a retryable turn failure up to 3 times on the same task/session.
2. When that budget is exhausted and the task becomes `failed`, the daemon creates one **automatic review task**
   (`kind: 'red-auto-review'`, `hidden: true`, subject `Automatic continue review`, no assignee/attempt/lease). Its only action is
   `agent_teams_continue_task` on the failed task, which sends `继续`, keeps the task id/subject, and grants a fresh
   turn-retry budget. It never reads code, never reviews code, never creates an implementation task and never edits
   the subject. Reviews run asynchronously in the daemon and never take a worker slot.
3. The automatic continue repeats at most `zcode.redAutoReview.maxContinues` (default 3) times per task/session.
   The next red box messages the captain (`to: 'captain'`, urgent) with taskId, subject, count, sessionId and the
   last error, sets `redReviewEscalated`, and stops automatic continues until a human acts. A manual
   `agent_teams_continue_task` clears the counter and escalation flag.

Idempotency: the review id is deterministic — `redreview_<sha1(taskId + ':' + lastAttemptId)>` — so one failure
event can only create one review, across repeated hooks, ticks, sweeps and daemon restarts. `tick()` runs
`sweepRedReviews` to recover missed events and deferred reviews. A review parked as `pending` by `halt`, or cancelled by an older implementation, resumes under the same id after `resume`; while the team is halted it must not send a continue. Hidden review rows never enter ordinary worker allocation, even while parked. Completed review history is not reopened.

Permissions: the daemon (`red-auto-review` system actor), the captain token, a reviewer/auditor license
(`task:continue`), and a contractor with `purpose: 'red_auto_review'` (or `task:continue`) may perform the continue.
A plain member gets `403 E_FORBIDDEN` and the review records `red_review.denied`. A `red_auto_review` contractor runs
the review in its slot with **no model session**; ordinary contractors have no such permission.

Visibility: review rows are `hidden` — excluded from `GET /teams/:id`, `GET /teams/:id/tasks`, the `/ui/snapshot`
panel tree and `audit()` — and always finish as `completed` with an `outcome`
(`continued|escalated|denied|error|source-active|missing-source`), so the tree never accumulates red review nodes.
`GET /teams/:id` returns a `redReviews` summary (`enabled`, `maxContinues`, `total`, `running`, `escalated`,
`byOutcome`, `last`) instead, and the admin can pass `GET /teams/:id/tasks?includeHidden=1` to inspect raw rows.
Config: `zcode.redAutoReview` = `{ enabled, maxContinues, retryDelayMs, maxAttempts }`. Full design:
`docs/decisions.md`; ADR-0025 (historical design), ADR-0032 (current recovery boundaries).

Response envelope: `{ "ok": true, "data": ..., "error": null }` or `{ "ok": false, "data": null, "error": { "code": "...", "message": "..." } }`.

Error codes: `E_AUTH`, `E_NOT_FOUND`, `E_CONFLICT`, `E_INVALID`, `E_CAPABILITY`, `E_STATE`, `E_STALE_ATTEMPT`, `E_UPSTREAM`.

## SSE events

```text
team.updated        member.updated      member.materialized
member.relicensed   member.slept        member.woke
member.compacted    task.updated        message.created
message.cross_team_pending             message.cross_team_approved
message.cross_team_rejected            message.cross_team_auto_approved
gate.updated        usage.recorded      plan.updated
task.merged_to_integration              merge.review_passed
merge.review_rejected                   contractor.queued
contractor.started contractor.cancelling  patrol.captain
contractor.completed contractor.failed     contractor.killed
contractor.orphaned contractor.cleanup_failed
patrol.contractor  concurrency.reduced  concurrency.recovered  team.archived
task.turn_failed   task.retry_scheduled  task.dispatch_failed
task.continue_scheduled  task.continued  task.continue_requested
task.continue_deferred  task.continue_failed  task.continue_session_lost
red_review.created  red_review.continued  red_review.deferred  red_review.failed
red_review.denied  red_review.reopened  red_review.completed  red_review.escalated
red_review.error  red_review.create_failed  red_review.report_failed
task.red_escalated
task.turn_watch_unavailable  task.turn_watch_warning  member.session_reset
worktree.base_created  worktree.base_missing  worktree.base_recovered
patrol.failed  patrol.stalled  patrol.deferred  patrol.report_failed
model.followed  model.follow_failed
gate.repair  gate.repair_warning  gate.repair_deduplicated  gate.repair_failed
```

Each event: `eventId`, `teamId`, `ts`, and the changed entity summary. Support `Last-Event-ID` or `?since=`. The list above is representative; additional entity events are emitted for task/member/team changes.

## Automatic repair contract

A failed review or verification task with open findings plans a repair task that depends on the reviewed implementation; the failing gate is a causal edge (`findingSourceTaskIds`), never a dependency (INV-016). A failed requirements round is different: it plans the next requirements round (`requirements-<id>-rN`) from the same findings, never a repair. The repair contract is derived from the findings and never copied from the source task:

- **Objective.** `deriveRepairObjective` renders one line per open finding with its P-level (an explicit `finding.priority`, an inline `P0/P1/P2` label, else severity blocker→P0 / high→P1 / medium→P2 / low→P3), its `file:line`, the problem and the required fix, plus the source task and the review that produced it. The source implementation objective is not reused.
- **Scope.** `repairScopeReport` extracts paths from `finding.file`, `finding.path`, `problem` and `requiredFix`. Declared `finding.file` and `finding.path` values are authoritative lists: each is split on `, ; |` and brackets/quotes, every fragment must match `[A-Za-z0-9._/-]+` (an unknown or missing extension such as `Makefile` is accepted), and a bare line number left by `src/x.mjs:49,244` is dropped. For `problem` and `requiredFix`, only printable-ASCII runs can be paths, so CJK prose and conjunctions terminate a candidate; each run is split the same way, `:line`, `:line-line`, `:line,line` and `#Lnn` suffixes are stripped, and every fragment must match `[A-Za-z0-9._/-]+` with a known extension or a trailing `/`. Default-excluded paths (`.env`, keys, `.git`) are dropped. If the findings name no path, the scope falls back to the source task's `inScope` and emits `gate.repair_warning`; if that is empty too, no repair is created and the team escalates instead of shipping an invalid contract.
- **Idempotency.** A repair records `findingsFingerprint`, a stable sorted fingerprint of problem/requiredFix/file/line/severity. Each finding is JSON-encoded as a row before sorting, so text containing `|` or the row separator cannot collide across field boundaries; finding order does not matter. The same trigger id or the same fingerprint never creates a second task: an open match is a no-op that emits `gate.repair_deduplicated`, and a completed match whose findings are still open escalates instead of looping.
## Patrol reports

The daemon is the patrol clock. `patrolTickAll` runs every minute; per team it
compares `now - lastPatrolAt` with `patrol.intervalMinutes` (default 15) and
runs at most one patrol per window.

Trigger (scheduled path only): the team is `running` with `control=active`, it
has at least one unfinished task (`pending`, `claimed`, `in_progress`), and at
least one non-captain member has `status=working` or `workState=busy`. An idle
team returns `no-active-execution`; an empty team returns `no-active-work`;
neither creates a captain session or sends a message. The manual
`POST /teams/:id/patrol` route bypasses the window and the member check but
still refuses a team with no unfinished task.

Report: the daemon builds the English text itself with
`buildPatrolReport` (`src/service/patrol-run.mjs`). Sections: conclusion
(`normal`/`attention`/`risk`/`off-course`) with an explicit direction
(`on-track`/`off-course`), task overview, executing tasks (member, elapsed,
last activity), waiting tasks and reasons, broken chains (completed without
review, failed review without repair, completed repair without re-review,
long-unclaimed), schedule/capacity, risks (repeated ECONNRESET/timeout, runtime
timeout, scope drift, consecutive review failures), and suggested actions
(continue/swap/repair/pause/escalate). Timestamps use the resolved
`zcode.locale`/`zcode.timezone`. The text is English because it is delivered to
the captain model; only the report data (task ids, subjects, paths) keeps its
original language. The report is read-only: the patrol path never edits files,
creates tasks, or merges.

Delivery: `patrol.whenCaptainBusy=queue` (default) persists the report and
claims it as `sending` before sending with `delivery=queue`. Captain creation
occurs when `captainSessionId` is absent, subject to its unresolved-creation
and admission guards. A local adapter's unknown/closed-session response is not
proof that the persisted captain session terminated: the identity is retained,
not silently cleared or replaced. Only an explicit local pre-send admission
rejection or a Protocol `session/send` pending-limit error with evidence that
nothing was written requeues the same report after 30 seconds. Every adapter
`ok:false` response, including one whose warning says the captain is busy, is
ambiguous: retain the report and sending claim as `unknown`, set `needsCaptain`,
and do not automatically replay it. Arbitrary exceptions, provider failure
results, timeouts and interrupted claims are likewise not automatically replayed.
An unknown report blocks later backlog delivery. `patrol.report_failed` remains
in the historical event catalog; it is not the current ambiguous-delivery path.
`lastPatrolAt` is persisted on the team row and hydrated at startup, preventing
a restart within the same window from generating an automatic duplicate.
`patrol.whenCaptainBusy=one-shot-contractor` keeps the legacy one-shot patrol
contractor; `wait` defers while the captain is busy. Manual patrol can append a
report, but does not reconcile an existing unknown report.

## Dispatch recovery boundaries

- A failed local session/control admission (`E_SESSION_CAP` or `E_CONTROL_CAP`) defers dispatch; it is not a provider turn failure and must not consume the turn retry budget. The failed attempt is closed, `reassigning` is cleared, and the task becomes eligible again once capacity is available.
- An unknown session creation remains fail-closed: retain the reservation and diagnostic hold until session ownership is reconciled. A hold release alone is not proof that a session has stopped.
- Dispatch holds carry a stable `reason` alongside `class` so the existing compare-and-swap `release-hold` contract can identify the exact hold. Release does not bypass stale delivery binding or unknown-session checks on the next dispatch.
- Busy-session deferral invalidates the current persisted task row, not the pre-dispatch snapshot. It preserves the newest worktree and monotonically increasing attempt number, while keeping the existing five-second delay and same-tick member exclusion.
- Worktree failure, capacity deferral, unavailable event cursor and a stale attempt after send never increment the successful-dispatch count.

These recovery corrections are bug fixes identified during modularization, not behavior-preserving extraction. Existing attempt, lease, merge and isolation gates remain mandatory.

Session occupancy is collected by `src/service/session-occupancy.mjs`; `TeamService.controlSessionCount()` and `workspaceSessionCount()` remain the public admission seams. The shared scan includes archived teams, captain start/conflict reservations and worker reservations, deduplicating known session IDs across owners. Control accounting still filters worker conflicts and members through their existing control classification; workspace accounting counts every member session/shadow reservation regardless of control classification, plus active contractors. Unknown/starting reservations, legacy synthetic-key namespaces, member classification call order and contractor enumeration order are preserved. Collection does not mutate or release reservations and adds no cache, persistence or recovery behavior.

## Container worker image startup

Container mode validates the Git workspace before any optional worker-image pull. `isolation.imagePullPolicy` is `never` by default; `if-missing` pulls only after the runtime confirms that the image is absent; `always` pulls the configured image before the CLI self-test. Under `if-missing`, runtime/permission/transport errors from image inspection fail preparation and are not treated as a missing image. A requested pull failure aborts startup and never falls back to a stale local image. Pulling a configured tag does not discover or guarantee the latest ZCode release; the operator must select a trusted registry image. The bundled `deploy/worker.Dockerfile` builds from an explicitly pinned upstream source revision, so updating the CLI requires changing that pin and rebuilding the image.

Every worker invocation sets an empty image entrypoint so the command built by `ContainerCliSessionAdapter` is executed directly; it cannot be reinterpreted by an image's `bash` entrypoint. The base `deploy/worker.Dockerfile` leaves entrypoint unset. The daemon still requires the configured CLI to pass `containerSelfTest`; a Linux desktop package is not evidence of a usable headless CLI.

## Native Subagents worker model selection (introduced in 0.1.11)

The user-requested native entry is the plugin agent `ai-agent-teams:team-worker`, displayed under the plugin in ZCode Settings / Subagents. It represents a shared model preference for ordinary members, team leads and model-backed contractors, not 32 independent native worker sessions. The captain's conversation and the optional shadow keep their own model policy; daemon-only red reviews create no model session.

Without a target override, the reader returns `inherit`, including for a disabled native entry, to preserve legacy daemon behavior; this is not evidence that the native agent is enabled or invocable. A disabled target with an explicit override is refused.

The bridge reads the host's `v2/agents-state.json` under its configured `storage.dir`. The stable override key is `plugin:<plugin-id>:team-worker`, where `<plugin-id>` is `<manifest-name>@<marketplace>`. Identity must match the running installation, never the first same-named plugin. The plugin reads only structured model selection (`providerId`, `modelId`, optional `reasoningLevel`), never provider credentials, and never writes host settings.

An explicit native selection is a hard worker pin above fixed/follow-host policy, including later host-model changes. Removing that selection (Inherit default) restores the prior policy. A missing selection preserves existing behavior. Invalid state, ambiguous installation identity or an adapter that cannot honor the explicit model is reported and blocks model work rather than silently using the captain's model. Protocol adapters use `session/setModel`; no unsupported `--model` flag is added. Existing CLI/container execution without a native pin is unchanged.

New worker sessions resolve the latest selection before reserving capacity. Worker task dispatch, continue/retry and mail send boundaries re-read the selection and serialize model application with sending; an attempt/session/control change during an asynchronous operation fences a stale task send. Task-free mail uses its actual session/control identity, not a fabricated attempt. A native refusal keeps mail pending for explicit reconciliation rather than discarding or falsely acknowledging delivery. Protocol-backed live members also receive changes through the serialized model watcher, including in fixed mode; the selection signature participates in change detection even when the captain's model is unchanged. `nativeModelSignature` and `nativeModelPrevious` distinguish the effective pin from the member's original preference, so removing a pin cannot accidentally preserve it as a fallback. A contractor freezes the structured selection at submission and does not silently switch midway through its run.

Known native-state, unsupported-adapter or send-boundary model-application refusal closes the current attempt and puts the latest task on a `native_model_selection` hold (both `class` and stable `reason`), without consuming the provider failure budget or dropping the existing session. Correcting Settings and explicitly releasing that hold permits a retry; release never bypasses a fresh selection check. An unknown external create result retains the stronger existing unknown-session hold and occupancy rules. Protocol model changes set `persistAsWorkspaceLastUsed: false`, leaving the captain's workspace default untouched. This feature does not modify roster size, concurrency, leases, permissions or review independence.

Watcher native-state/unsupported failures record a stable-code `model.follow_failed` event and conservatively set `needsCaptain` for the daemon's teams. Duplicate events are suppressed per team and code/selection signature for the watcher lifetime (reader failures use a stable read key). Recovery does not clear captain attention from any source; manually clearing attention does not cause the same watcher fault to emit a second event. Send-boundary checks remain mandatory even after watcher retry abandonment. Native mail refusals retry after five seconds without consuming ordinary delivery failures; the pending message remains visible for reconciliation.

Source validation and fake/protocol-payload tests do not establish that an installed plugin is visible or that a paid provider accepted the model. Install/update and a new-session native UI trial are separate acceptance steps; no automatic plugin installation, personal-agent rewrite or paid test is authorized by implementation alone.

## Model following

`zcode.modelPolicy` is `follow-host` (default) or `fixed`:

- **Host source.** The daemon process does not inherit `ZCODE_SESSION_ID`; only hook subprocesses get it. The plugin `SessionStart` hook (`scripts/session-start.mjs`) writes the host session id to `<workspace>/.ai-agent-teams/host-session.json` (mode 0600, atomic temp+rename), but only when the workspace already has team state (`.ai-agent-teams/` or a valid `config/local.json`), so opening an unrelated repository does not create an untracked directory. Worker sessions are skipped. `HostModelReader` re-reads that file on every tick and falls back to its own `ZCODE_SESSION_ID`. A new session id discards cached values and file offsets. `status.host` keeps the resolved `sessionId`/`sessionSource` even when the log has no model event yet; only model/reasoning fall back.
- **Log source.** `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` for today and yesterday (a session can cross midnight), filtered by `sessionId`. Only two events carry values: `session.model.updated` (`context.model`) and `session.reasoning_effort.updated` (`context.thoughtLevel`). `model.request.started` was checked on ZCode 0.17 and its `context` has `queryId`/`turnNumber`/`iteration` only, so it is not a supported source.
- **Reading.** The first read of a file (or after truncation/rewrite) scans backwards in chunks and records the offset just past the last complete newline. Later reads parse only appended bytes in fixed-size chunks, keeping a trailing half line pending and comparing a 64-byte anchor before the stored offset, so a truncate-and-regrow is rescanned instead of skipped. A new day file is picked up on the next read; deleted files drop their offsets without losing the cached value. A malformed line or missing file is skipped; the reader falls back to `defaultModel`/`defaultReasoning` and never throws.
- **Spawn.** `fixed` resolves `modelPolicy.model` (config `defaultModel` at startup, `agent_teams_model set` at runtime), then the member's explicit `model`/`reasoning`, then config defaults. `follow-host` resolves a real host value first; when the host value is only the config fallback, a member's explicit `model`/`reasoning` wins, then the host/default value. Spawn records `modelOverride`/`reasoningOverride` (the original `agent_teams_add_member` input) so a hot switch rewriting `member.model` does not lose the preference. The resolved values are written to `member.model/reasoning` and passed to `session/create`; CLI/container adapters ignore that field, which is why `fixed`/`follow-host` hot switching warns there.
- **Hot switch.** `ModelWatcher` ticks every 3 seconds. When the host model **or** reasoning changes it calls `adapter.setModel({sessionId, model, reasoning})` for every member with a live session, updates `member.model/reasoning` and emits `model.followed` per member. A per-member failure emits `model.follow_failed` and does not abort the others. When every member fails, the tick does not commit its signature: retries back off exponentially up to `maxFailedTicks` (5 by default), then one `model.follow_abandoned` is emitted and the signature is sealed until the host value changes again. Adapters with `supportsModelSwitch=false` (CLI/container) return `skipped: 'unsupported'` and are never retried. Applications are serialized and tagged with a policy epoch (`expectedEpoch`), so a queued host tick is discarded after `set`/`follow` and cannot overwrite the new pin. The watcher never rejects into the daemon interval.
- **Tool.** `agent_teams_model` accepts captain/admin authority and the delegated shadow member identity (the read-only UI token is limited to UI read routes): `status` (default), `set` with `model` (and optional `reasoning`), `follow`. The shadow may change the workspace-wide runtime model policy under its own audited identity. Ordinary member and contractor sessions get all four name shapes in `disallowedTools` and the ordinary-member catalog filters them out; the shared `CAPTAIN_ONLY_TOOL_NAMES` list also covers `agent_teams_workspace`/`agent_teams_route`. HTTP: `GET /api/v1/model`, `POST /api/v1/model` (admin or authorized shadow token). `set` and `follow` are runtime overrides only; they are not written back to the config file, so a daemon restart returns to the configured `zcode.modelPolicy`; each change emits `model.policy_changed` with `from`/`to`/`actor`.

## Discovery and auth

Each workspace writes `~/.ai-agent-teams/workspaces/<workspace-hash>/runtime.json`; `~/.ai-agent-teams/runtime.json` is retained as a legacy mirror of the most recent daemon. The `version` value below is an illustrative placeholder, not a claim about the current working package; check `package.json` and `VERSION` for current metadata.

```json
{
  "port": 43127,
  "token": "random-32-bytes",
  "pid": 1234,
  "version": "<package-version>",
  "workspace": "D:\\work\\project",
  "instanceId": "16-hex-chars",
  "uiKey": "random-panel-access-key",
  "apiVersion": "v1",
  "startedAt": 1760000000000
}
```

The daemon prefers port `8779`; if that port is occupied it listens on a free loopback port and writes the actual port here. Consumers must read the workspace-specific discovery, not cache an old URL. File mode 0600 on POSIX; on Windows the absolute `%SystemRoot%\System32\icacls.exe` applies `/inheritance:r /grant:r <current-user>:F` so another local account cannot inherit read access. `/api/v1/health` returns `status` and `version`; loopback requests also receive `workspace`, `pid` and `instanceId` (non-loopback callers do not get host paths/PIDs). Bootstrap only kills a stale PID after that identity matches and the discovery token is accepted by an authenticated request. The API binds `127.0.0.1` in worktree mode and `0.0.0.0` in container mode so workers can call back; `/ui` is loopback-only and rejects a non-loopback Host header. The panel also requires the per-process `uiAccessKey`: the first visit carries it as a query parameter and the server sets an HttpOnly cookie scoped to that panel port; later visits to the same port use the cookie. Bearer comparison uses `timingSafeEqual`.

Each workspace also stores a runtime throttle at `.ai-agent-teams/runtime-capacity.json`:

```json
{
  "version": 1,
  "activeWorkerSlots": 5,
  "maxActivePerTeam": 5,
  "configuredWorkerSlots": 6,
  "successes": 0,
  "reducedAt": 1760000000000,
  "nextRecoveryAt": 1760000060000
}
```

It is written whenever a capacity/429 error reduces slots, when a slot is restored, and when the success counter changes. On startup the daemon accepts it only when `version=1`, `configuredWorkerSlots` matches the current configured `activeWorkerSlots`, and `activeWorkerSlots` is an integer within that ceiling; an invalid, corrupt, or configuration-mismatched file is ignored. `successes` and `nextRecoveryAt` are clamped on load. Recovery requires `capacityRecoverySuccesses` consecutive successful turns after `nextRecoveryAt`, then adds one slot and resets the count. A workspace is expected to run one daemon instance; concurrent daemons can overwrite this file.

## Stable MCP shell host-request forwarding

Runtime-to-host JSON-RPC requests receive shell-owned unique `shell:host:<n>` IDs on the host channel; the shell retains a bounded mapping to the originating runtime generation and its original request ID. Responses and `notifications/cancelled` are mapped back to that runtime and ID. Runtime-origin cancellation releases the mapping before forwarding the wire-ID cancellation to the host; host-origin cancellation releases the mapping before forwarding the original-ID cancellation to the owning runtime. This prevents a delayed host response from being mistaken for a later request that reuses a runtime ID, including across runtime generations. Wire IDs also avoid IDs currently used by host-to-runtime pending requests, and a conflicting host-to-runtime request fails closed. The shell permits at most 1000 outstanding runtime-to-host requests; excess requests fail locally with `-32603` and are never forwarded. Each request deadline starts synchronously when it is accepted from the runtime, before the host callback is invoked; timeout, runtime exit, cancellation, and shell close remove the mapping, so there are no persistent timeout tombstones. A late response to a removed mapping is ignored. Host wire IDs are not serialized by the runtime's original ID.

## Session protocol mapping

| Need | Protocol method | CLI fallback |
| --- | --- | --- |
| create member | `session/create` | `zcode -p ... --json` |
| resume member | `session/resume` | `zcode --resume sess_...` |
| send task/message | `session/send` | `zcode --resume ... -p ...` |
| delivery mode | `startNow | queue | guide` | `queue` only; `stop` + send |
| stop turn | `session/stop` | kill process |
| cancel background task | `session/cancelBackgroundTask` | kill child process |
| set model | `session/setModel` | not available; default model + warning |
| set thought level | `session/setThoughtLevel` | not available |
| set mode | `session/setMode` | `--mode` |
| events | `session/events` / `session/subscribe` | poll `--json` result |
| compact | `session/compact` | new session + summary |
| fork | `session/fork` | new session |
| close | `session/close` | stop process |

The CLI has no live event stream; `zcode --resume ... -p ... --json` is synchronous and returns the final JSON, so provider errors are retried from the `send` result. Mid-turn stop/guide and live events require the Protocol app-server adapter.

## Hot-update pointer and package

- The stable shell (`src/mcp/shell.mjs`) reads `runtime/current.json`; a missing pointer means "use packaged `src/mcp/runtime-entry.mjs`". The pointer fields the shell honours are `version`, `entry`, `apiVersion` and `sha256`; `gitCommit`, `installedAt`, `swapId` and `previous` are installer metadata.
- `entry` is POSIX-relative to the plugin root and must resolve inside it; `sha256` binds the entry bytes only. `apiVersion` must equal the shell's `RUNTIME_API_VERSION` (currently 1), otherwise the shell fails closed and falls back to the packaged runtime.
- A runtime package is `runtime/versions/<version>-<shortsha>/` with `manifest.json`: `schemaVersion`, `name`, `version`, `gitCommit`, `shortCommit`, `apiVersion`, `entry`, `createdAt` (epoch ms), `fileCount`, `totalBytes`, `files[{ path, sha256, size }]`. `files[].path` is POSIX and must stay inside the package.
- `shortCommit` is part of the package identity, not metadata: it is the directory name suffix. `verifyPackage` requires 7-40 hex characters and requires it to be a prefix of `gitCommit`; a missing, non-hex or non-prefix value is `HOT_UPDATE_MANIFEST_INVALID` (so a package can never install as `9.9.9-undefined`). A publish target must additionally be a direct child of the versions directory — `versions/../../src` is `HOT_UPDATE_PACKAGE_INVALID` — before any filesystem change.
- Published content is fsynced: every packaged file, the manifest and the journal are flushed before the directory is renamed into place or the pointer is written. The flush of packaged files and the manifest goes through an injectable `syncFile` (a test hook); the journal always uses the built-in implementation. Directory entries themselves are not fsynced, so the guarantee is "the bytes are on disk", not "the rename is durable on every filesystem".
- `build`/`install`/`rollback`/`status` recover in under `runtime/.hot-update.lock`. A forced replace writes `runtime/recovery-*.json` (with a per-swap `swapId`) before the old directory is moved aside. `commit()` deletes the journal *first*, then the backup, so a crash between the two leaves an orphan `.replaced-*` directory that recovery discards once the target verifies — never a live journal over a committed pointer. A surviving journal normally means "not committed, the backup wins"; the single exception is a pointer that carries the same `swapId`, whose `entry` resolves inside the target with a matching `sha256`, and whose package verifies — then the swap committed and the backup is discarded (`reason: pointer-committed`). A journal without `swapId` (written by an older installer) is treated as uncommitted. A failed `undo` is reported as `HOT_UPDATE_UNDO_FAILED` through the original error's `details.undoError`, keeps the journal for the next recovery pass, and a journal that could not be deleted shows up as `details.undoWarnings`.
- `install`/`rollback` only write the pointer after `verifyPackage` and an `initialize` + `tools/list` probe pass. `status` fully verifies the current version and reports `entryPresent` for the others. Stable errors: `HOT_UPDATE_MANIFEST_MISSING`, `HOT_UPDATE_MANIFEST_INVALID`, `HOT_UPDATE_FILE_MISSING`, `HOT_UPDATE_DIGEST_MISMATCH`, `HOT_UPDATE_UNSUPPORTED_API`, `HOT_UPDATE_IMPORT_MISSING`, `HOT_UPDATE_PACKAGE_INVALID`, `HOT_UPDATE_HEALTH_FAILED`, `HOT_UPDATE_UNDO_FAILED`, `HOT_UPDATE_LOCK_TIMEOUT`, `HOT_UPDATE_POINTER_INVALID`, `HOT_UPDATE_NO_ROLLBACK_TARGET`, `HOT_UPDATE_PREVIOUS_MISSING`. Operationally documented in `docs/guides/INSTALL.md`.
- The health probe inherits no `AGENT_TEAMS_*` variable (compared case-insensitively, so a lowercase `agent_teams_url` is dropped too) and no build-cache variable (`npm_config_cache`, `npm_config_prefix`, `npm_config_userconfig`, `npm_config_globalconfig`, `npm_config_tmp`, `CARGO_TARGET_DIR`, `CARGO_HOME`, `GOCACHE`, `GOMODCACHE`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `GRADLE_USER_HOME`, `XDG_CACHE_HOME`). `AGENT_TEAMS_AUTOSTART=0` is forced and cannot be overridden: an explicit non-zero value is ignored (`ignoredEnvOverrides`) because a probe that starts the daemon would run the code it is checking. Explicit `AGENT_TEAMS_*` overrides are normalized to upper case before they are applied.
- Staging-to-target publication retries only `EPERM` and `EBUSY` on Windows, at most five rename calls with 25/50/75/100 ms delays (250 ms total scheduled delay). A monotonic 1000 ms budget prevents starting later retries after expiry; it cannot cancel an OS call already executing. Other platforms and error codes fail immediately. Each attempt rechecks that the destination is absent, including under `force`; a newly observed destination is `HOT_UPDATE_VERSION_EXISTS`, never permission to delete or replace it. This is a bounded publication bug fix, not behavior-identical extraction. Backup moves, rollback renames, pointer writes and locking retain their prior retry behavior.
- A failed staging rename does not own the destination and cannot remove it to restore a backup. New forced-publication journals record `stagedIdentity` (directory device/inode identity); recovery retains an unrelated target, backup and journal and reports an error when the uncommitted target does not match that identity. A verifying target committed by the matching pointer still wins. Journals without the field retain legacy recovery semantics. These checks complement the runtime lock and atomic rename; they are not an atomic no-replace primitive against arbitrary external writers between a check and rename.
- `build` warns when the source tree has uncommitted tracked changes, including when `--commit` names the commit, and also warns when `git status` cannot be read at all (no repository, no git) instead of assuming a clean tree.
- `rollback` never guesses: without an explicit version it uses the pointer's `previous` entry only. A missing `previous` is `HOT_UPDATE_NO_ROLLBACK_TARGET`; a `previous` whose version directory was deleted is `HOT_UPDATE_PREVIOUS_MISSING`. Both leave the pointer untouched.

## Quality-gate module boundaries

`src/domain/gates.mjs` remains the compatible public import surface for completion validation, follow-up planning and delivery audit. Responsibility-based internal modules may separate finding/score validation, deterministic identities, independent assignee selection, completion fan-out, failed-gate repair planning and final audit. Internal modules must import their dependencies directly rather than importing the public facade back, and must remain pure (no I/O or persisted side effects). Reorganization must preserve export names and shared constant identities, result shapes, task ordering, finding causality, dependency rules, review independence, score thresholds and exception behavior. Existing behavioral tests must not be weakened or rewritten to bless a changed planner.

## Closed-loop automation

The task lifecycle is a closed loop owned by the daemon; the captain does not create the follow-up rows. Pure planners: `planCompletionFanOut`, `planFailedReviewFollowUp`, `evidenceBackedCompletion` (`src/domain/gates.mjs`) and `planPreemption`, `priorityBand`, `orderReadyTasks`, `taskDeliveryState` (`src/domain/scheduler.mjs`).

### State machine

```text
implementation/repair: pending -> in_progress -> completed
completed(implementation|repair)
  -> review-<id>              (always)
  -> verify-<id>              (only when requiresVerification/verification, or policy.fanOutVerification)
  -> repair-known-<id>        (only when the completed task reports unresolved findings with a file + requiredFix)
review failed (needs_revision + findings)
  -> repair-<reviewId>        (exactly one per review; round = review.round)
  -> link an already-open manual repair instead of creating another
repair completed
  -> review-<repairId>        (round + 1; another reviewer is preferred, never the implementer)
review completed with pass -> chain ends (loop.passed event)
```

`review.reject`, a failed review without actionable findings, findings that cite no writable workspace file, a missing verify contract, or the round ceiling all stop the loop and escalate to the captain with `taskId`, round and findings (`loop.escalated`, one urgent message from `closed-loop`). The escalation is recorded in `task.closedLoop.state = "escalated"`, so a repeated tick or a restart does not re-message.

### Fan-out and parallelism

Every row created for one completion depends only on the completed task, so `nextReady` makes them ready in the same tick and they dispatch together. The planner pre-assigns each row to a different pool member when one is free: review -> reviewer pool, verification -> analyst (then reviewer) pool, repair -> engineer pool. The review is never assigned to the implementer, even when that member was re-licensed as a reviewer; rows planned in the same pass are treated as claimed so a reviewer who can also verify is not double-booked. One member still runs one task at a time (INV-022): a second row for a busy member waits as `pending`, while different members run in parallel.

### Priority and preemption

- Bands: `critical` (explicit `priority: critical|high`, any task with downstream dependents, and every review/repair) > `normal` > `low`/independent retry. An explicit `priority: low` stays low even when it unblocks other work.
- Inside a band, FIFO by `createdAt` (then id), so an old task cannot starve behind newer tasks of the same band.
- When no slot is free, or the only eligible member is held by lower-priority work, `planPreemption` pauses the most recently started lower-band task: the attempt is cancelled, the task returns to `pending` with `preempted`, `preemptedBy`, `preemptedFrom` and `preemptionCount`, the member is released (lazy mode) and `task.preempted` is recorded. The paused task keeps its worktree and evidence; the next dispatch copies uncommitted changes back (`task.worktree_preserved`). A paused task is never `failed`.

### Delivery semantics

`taskDeliveryState` is exposed as `deliveryState` in the team view snapshot and returns `blocked` (a dependency is not completed), `queued` (ready but waiting for a member or slot — 待交付 grey), `running`, `completed`, `failed` or `cancelled`. Only `failed` (and an explicit `cancelled`) is red; `queued`/`blocked` are never treated as failures, and the task stays `pending` in the store.

### Idempotency keys and caps

| Row | Deterministic id | Duplicate guard |
| --- | --- | --- |
| review of X | `review-<X>` | any review with `reviewedTaskId = X` (manual or automatic) wins |
| verification of X | `verify-<X>` | any closed-loop verification of X |
| known repair of X | `repair-known-<X>` | id, or `closedLoop.role = known-repair` for X |
| repair of review R | `repair-<R>` | id, or a repair whose `findingSourceTaskIds` contains R |
| re-review of repair P | `review-<P>` | id, or any review with `reviewedTaskId = P` |

Ids longer than 128 characters are shortened with a stable FNV-1a suffix (`closedLoopTaskId`). Caps come from `config.quality.reviewPolicy`: `codeMaxRounds` (default 3) and `maxRepairAttempts` (default 2); every repair of the same source counts, including a `repair-known-<id>` fan-out row. `fanOutKnownRepair: false` disables the parallel known-repair row, `fanOutVerification: false` keeps verification only on the per-task flag. A sweep runs at the start of every `tick` and in `reconcileAfterRestart`, so a crash between "task closed" and "follow-up written" heals on the next scan and a restart cannot duplicate a row.

### Repair dispatch and independence

Automatic repair paths must remain within the source task's `inScope` and inherit its `outOfScope`; a finding outside that authorization escalates instead of creating a broader repair. This applies to review follow-up, verification follow-up and completion fan-out. Explicit authorization is required to expand scope.

Captain patrol reports use a persistent team outbox before the first send. The queued report and patrol timestamp commit together; a transaction claims a queued report as `sending` with a unique claim ID before calling the adapter. Only the matching claim may settle it. Only a local pre-send admission rejection or a Protocol `session/send` pending-limit rejection with explicit not-written evidence is queued again; any adapter `ok:false` response, including a busy warning, is ambiguous and retained as `unknown` with captain attention, not automatically replayed. An interrupted `sending` claim remains held until external delivery can be reconciled. Adapters have termination-verification methods, but termination does not prove that an earlier report was not delivered. There is no general report-delivery receipt and no supported HTTP/MCP/CLI or manual patrol reconciliation/release entry for ambiguous reports or captain reservations. Task hold release, publication reconciliation, halt/resume and captain stop/close do not authorize replaying an unknown patrol report.

The worker, contractor, captain and shadow creation paths count known workspace sessions and persisted start reservations across teams before admitting a new session. Each reserves its place transactionally; an unknown worker creation remains held and stale creation results cannot replace a newer reservation. On daemon restart, recorded sessions and interrupted tasks remain held until termination is proven; a missing ID or expired lease is not termination proof. Recovery and trustworthy proof collection are not yet implemented, and other existing cleanup/reset paths still need verification, so `maxTotalSessions` is not yet an independently verified hard workspace-wide ceiling. Post-merge review uses a persisted claim before starting the contractor; an ambiguous claim is held for reconciliation, not automatically stolen. Source review identity and artifact binding are rechecked around Git operations, but there is no atomic lock spanning all review mutations and external Git writes; a concurrent invalidation during the final Git operation remains an unresolved release blocker.

The repair assignee is a free engineer chosen by least load (open-task load, then least-recently-used, residency, id). The original implementer is preferred only when the source task sets `repairContinuity: true`, this is round 1, the fix is not mechanical (all findings low/medium), and the original is free. A busy original, a mechanical fix, or a second round switches to another free engineer; when no engineer is free the row stays unassigned so the pool can materialize one instead of queueing behind a busy person. `repairContinuity: false` (task field or `reviewPolicy`) disables the preference. Independence: `validateTaskGraph` rejects a reviewer who is the implementer, `validateCompletion` re-checks it at completion, and a re-review prefers a reviewer who did not take part in the previous round.

### Evidence recovery

`evidenceBackedCompletion` infers a completion only when every acceptance item has a passed `acceptanceResults` entry and, for implementation/repair, at least one in-scope `changedPaths` entry (plus `commandsRun` when recorded). It runs only when the member session is gone or the task lease has expired, so it never races a live worker. The completion still goes through the daemon-owned verify gate and then the closed loop; the event is `loop.recovered` (`reason: session-gone|lease-expired`), or `loop.recovery_skipped`/`loop.recovery_rejected` with the reason. Work without evidence is requeued/stalled as before.

### Scores

A review that reports `scores` must reach `overall >= 4.5` and `code >= 4.0`; a lower or malformed score object fails the pass. `scores` stay optional for legacy reviews that do not report them.

## Storage

SQLite with WAL. Tables: `teams`, `leads`, `members`, `tasks`, `attempts`, `gates`, `messages`, `plans`, `sessions`, `containers`, `worktrees`, `usage`, `events`, `capabilities`, `schema_migrations`. Full DDL in `SPEC.md` section 13.4.

The daemon is the only writer. Members write through the API/CLI; direct DB writes are forbidden.

## Versioning

- API: `/api/v1`; breaking changes require `/api/v2` and one minor compatibility window.
- DB: independent `schema_version`; forward migrations only; backup before migration.
- Session protocol: capability probe on startup; missing methods degrade with warnings or fail closed.
# Reviewed integration publication

When an integration review supplies `expectedCommit`, fast-forward must publish
that exact commit, rather than a later branch tip containing additional work.
The integration branch must still contain the expected commit; otherwise the
operation fails. Calls without `expectedCommit` retain their existing behavior.
This protects the reviewed commit boundary; complete delivery-unit aggregation
and crash-recovery receipts are separate, not yet implemented requirements.

## Storage maintenance (2026-11-08)

`TeamService.homeRoot` is injectable and defaults to the existing shared user homes directory.
Tests inject disposable roots. Member identity survives session rebuilds, so rebuilding a session
retains that identity's home. Removal/archive reclaim the retired member's managed home, including
legacy rows without a persisted home field. Re-materialization retries retired-home cleanup.

`scheduler.memberHomeReclaimMinutes` defaults to null (disabled). Explicit 0 enables startup-only
orphan reclamation; 1..1440 also enables periodic reclamation. Shared homes carry a workspace owner
marker on creation. Automatic sweeps only remove UUID directories owned by this workspace and absent
from all its member rows, including archived/removed rows. Unmarked legacy homes require the reviewed
one-time inventory. Links and ambiguous ownership are retained. Failures are audited per directory.

Startup reclaims only empty discovery hash directories older than seven days with no runtime or lock,
protecting the active-workspace hint even when its workspace no longer exists. Supervisor logs rotate
at 5 MiB with one backup. Startup event pruning keeps existing archived-history exemptions, then
compacts outside a transaction if at least 1000 rows were pruned or at least 1 MiB of free pages remains
from earlier pruning. Checkpointing brackets VACUUM and failures warn without discarding state.
