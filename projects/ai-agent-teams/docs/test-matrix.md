# Test matrix

Target scenarios: `SPEC.md` section 14. This matrix is the current coverage ledger; `SPEC.md` defines target behavior and is not evidence of implementation.

Summary: 24 covered, 15 partial, 16 not covered (of 55). Retired IDs are explained below and are not counted.

| ID | Scenario | Status | Evidence / next milestone |
| --- | --- | --- | --- |
| T-01 | pending -> completed direct | covered | `pending cannot jump directly to completed` |
| T-02 | late attempt update | covered | `stale attempt updates are rejected`; attempts tests |
| T-03 | late result after reassignment | covered | `beginAttempt`/`invalidateAttempt` stale capability test |
| T-04 | idle member with open attempt | partial | `parked attempt keeps its capability and lease can expire` (`test/attempts.test.mjs`) and `lease expiry is detected` (`test/scheduler.test.mjs`) cover the pure attempt/lease transition; service-level idle-to-parked/stalled orchestration is not asserted |
| T-05 | cold restart unobserved attempt | partial | `restart holds active work and retains sessions until termination is proven` (`test/service-v06.test.mjs`); `restart holds evidenced work until the previous session termination is proven` (`test/closed-loop.test.mjs`). Tests assert `restart_session_unknown` holds and no redispatch until termination proof; once-only recovery/failure fallback to park is not implemented/covered |
| T-06 | dispatch failure rollback | covered | `dispatch failure rolls back the attempt` |
| T-07 | captain takeover | not covered | M5 |
| T-08 | one member, two open tasks | partial | one dispatch per allocation; open-attempt check is M1 |
| T-09 | failed/cancelled dependency | covered | `a failed dependency never unlocks downstream work` |
| T-10 | failed gate as causal edge | partial | repair source/finding refs checked; full causal-edge algorithm is M1 |
| T-11 | pass with open high finding | covered | `review pass cannot leave an open high finding`; delivery audit test |
| T-12 | reject escalates | covered | `reject escalates instead of auto-repairing` |
| T-13 | verify failure forces failed | covered | `a failed verify command forces failed` |
| T-14 | changed path outside scope | covered | `changed path outside scope is rejected` |
| T-15 | reviewer == implementer | covered | `self-review is rejected`; `delivery audit rejects self-review` |
| T-16 | completed implementation without pass review | covered | `delivery audit blocks a completed implementation without a passing review` |
| T-17 | failed gate without follow-up | covered | `complete -> review -> needs_revision -> repair -> review -> pass closes the chain`; `manual reviews and manual repairs are not duplicated by the loop` |
| T-18 | all findings default-excluded | covered | `all findings on default-excluded paths escalate` |
| T-19 | max rounds / repair ceiling | covered | `review round ceiling escalates`; `three failed rounds stop automatic repair and report to the captain once` |
| T-20 | artifact changed after review | covered | `delivery audit rejects artifact drift` |
| T-21 | artifact gap / unreadable | partial | reviewedGaps checked; unreadable test is M1 |
| T-22 | required reviewer missing | covered | `required reviewers are enforced per implementation` |
| T-23 | work-order stale | not covered | M1 artifact digest |
| T-24 | all cancelled / no tasks | partial | all-cancelled tested; no-task test is M1 |
| T-25 | amendment after pass | covered | `amendment freezes after a passing review` |
| T-26 | remove member with open task | covered | `remove member requeues its task and stops its session` |
| T-27 | member failure with fallback | not covered | M4 |
| T-28 | fallback failure | not covered | M4 |
| T-29 | 2 teams, 6 slots | covered | dynamic `tickAll` test plus legacy 3/3 test |
| T-30 | 32 roster, 6 active | partial | roster/config checks; session count is M4 |
| T-31 | preemption | covered | `critical-chain work orders first and preempts the low-priority task holding the only member` (pure planner + service tick) |
| T-32 | starvation guard | partial | band FIFO by `createdAt` asserted in `orderReadyTasks`; a long-running starvation simulation is still M4 |
| T-33 | lead lost | not covered | M5 |
| T-34 | captain lost | not covered | M5 |
| T-35 | container crash | not covered | M7 |
| T-36 | staged plan before approval | covered | `staged plan edit, approve and discard` |
| T-37 | plan edit atomic | covered | `plan edit is atomic when one task is invalid` |
| T-38 | running team edits active task | not covered | M5 |
| T-39 | discard does not auto-rebuild | covered | `staged plan edit, approve and discard` |
| T-40 | halt/resume | covered | `halt cancels unfinished work and resume reactivates dispatch` |
| T-41 | escalated vs halted | partial | state model documented; runtime is M5 |
| T-42 | expired mail discarded | not covered | M5 |
| T-43 | cross-team message | not covered | M5 |
| T-44 | toolPolicy invalid id | not covered | M5 |
| T-45 | captain tool reopened by allow | not covered | M5 |
| T-46 | profile snapshot | not covered | M5 |
| T-47 | route snapshot + fallback | not covered | M5 |
| T-48 | queue delivery | partial | protocol send queue; full delivery modes not complete |
| T-49 | guide delivery | partial | protocol guide is stop+send; no soft guide |
| T-50 | stop + send | partial | protocol stop/send individually and guide path tested |
| T-52 | missing capability degrades | not covered | Target acceptance case; no current focused coverage identified |
| T-53 | SSE reconnect | not covered | Target acceptance case; no current reconnect test identified |
| T-54 | six-worker e2e | partial | Historical recorded run: six-worker app-server smoke 6/6 OK; real 16-way 16/16 with pacing; 2026-10-29 real 32-way 32/32 with pacing and 32/32 unthrottled; these dated runs are not current acceptance evidence |
| T-55 | 16-worker load | partial | Historical recorded run: real 16-way 16/16 with `maxRequestsPerMinute=8`; logical load harness also covered; not a current rerun |
| T-56 | 32-worker multi-host | partial | Historical recorded real 32-way 32/32 with pacing and 32/32 unthrottled; multi-host not run |

Retired rows (excluded from the 55-row count): T-51 (gateway 402 pauses dispatch) and T-57 (gateway concurrency/budget behavior) are retired with the cost gateway by ADR-0027. Their former numbers are deliberately not reused or renumbered.

A row is `covered` only when a test asserts the rule. `partial` means part of the rule is tested; the rest is listed. `not covered` is a gap, not a promise. Dated load-test results are historical snapshots, not current test status.

The M1/M2 sequencing rule below is part of the original target plan, not the current project schedule; current implementation and release readiness are tracked in `docs/status/STATUS.md`.

## v0.6 additions (not mapped to the numbered rows yet)

These are tested but deliberately kept outside the v0.5 55-test count until the matrix is renumbered.

- Preset matrix: 16GB 6+6/max 8+8, 32GB 8+8/10+10, 64GB 12+12/16+16.
- Zero members at team creation; role materialization on demand.
- Work states: busy / waiting / available / settled.
- Settled guard blocks waiting, open review, open merge and findings.
- Re-license reuses the member id, revokes the old license, issues a new label/role and clears the session.
- Warm compact -> cold sleep -> wake.
- One-shot contractor lifecycle and ephemeral adapter flag.
- Global reserved contractor slots: merge 1 + main 1, per-slot FIFO queue, no borrowing, kill-during-create, startup orphan reconciliation, cleanup-error slot blocking.
- Post-merge contractor pass, reject/revert/repair, integration branch fast-forward.
- Captain self-wake patrol and one-shot patrol contractor when the captain is busy.
- 429 capacity downgrade; provider `retryAfterMs` overrides backoff; capacity state persistence/cooldown recovery; dispatch-time retry uses the same budget.
- HTTP and MCP endpoints for licenses, lifecycle, sleep/wake, contractors and patrol.
- Soft-isolation default: worktree mode, member homes, member tokens, read-only reviewer launches, git-derived changed paths, license path scope, `/soft-isolation` self-check.

Evidence: `test/lifecycle.test.mjs`, `test/service-v06.test.mjs`, `test/api-v06.test.mjs`, `test/mcp.test.mjs`, `test/merge-queue.test.mjs`.

## 0.1.8 workspace and panel additions

- Workspace precedence: explicit > active > env > session config > saved target > newest live daemon > startup.
- A startup folder with a stale (dead-PID) discovery does not block fallback to a live daemon; a saved target that no longer exists is ignored.
- Discovery dedupe by port+workspace, newest-first ordering, dead-process exclusion, and legacy-mirror cleanup on normal removal.
- `agent_teams_workspace use` rejects a dead discovery; a live one persists to the state file; `auto` clears it.
- Switching from project A to B routes subsequent calls to A's 8801 then B's 8802 daemon in one MCP process.
- A timed-out non-idempotent request is not replayed after `ensureDaemon`; `create_task` strips the routing `workspace` field.
- `agent_teams_view {window:true}` calls the standalone opener; window mode falls back to `tab` when only the OS default handler exists.
- SessionStart injects in a bare folder only while a live daemon exists; dead PID, worker sessions, and an unrelated tool's `config/local.json` stay silent.
- `hasTeamConfig` rejects an unrelated `config/local.json` and accepts one with a `teams` array.
- A stale per-workspace discovery falls back to a live legacy mirror; a timeout does not call `ensureDaemon`; `update_task` strips routing fields.
- Member sessions hide `agent_teams_workspace` (29 tools including `agent_teams_continue_task`) and cannot call it; every captain tool schema has an optional `workspace` outside `required`.

Evidence: `test/workspace-target.test.mjs`, `test/mcp.test.mjs`, `test/panel.test.mjs`, `test/hook.test.mjs`.

## Closed-loop automation additions

Evidence: `test/closed-loop.test.mjs` (17 tests), `test/scheduler.test.mjs`.

- A completed implementation creates exactly one deterministic review; repeated ticks and restarts do not duplicate it (`review-<taskId>`).
- One completion fans out review + verification + known repair in a single pass; all three depend only on the completed task and one tick dispatches them to three different members.
- The review is never assigned to the implementer, even after a reviewer re-license; rows planned together are treated as claimed.
- A review that fails with findings creates exactly one `repair-<reviewId>`; its completion creates the next review; a manual review or repair is linked, not duplicated.
- Three failed rounds stop automatic repair and send one captain message with task, round and findings; repeated ticks do not re-message.
- A busy original implementer is replaced by a free engineer; a second round switches again; with no free engineer the row stays unassigned instead of queueing behind the original.
- Critical-chain work orders before low priority and independent retries, FIFO inside a band; a critical task preempts the low-priority task holding the only member (task back to `pending`, `task.preempted`, never `failed`).
- `taskDeliveryState` renders a ready-but-waiting follow-up as `queued` (待交付) and only `failed`/`cancelled` as red.
- A task with recorded acceptance and in-scope changed-path evidence is completed and reviewed after its session goes idle or the daemon restarts; a task without evidence is still requeued.
- A review pass below overall 4.5 / code 4.0 is rejected; a malformed scores object fails closed.

## 2026-11-01 auto continue / same-task retry

- Retryable turn errors: ECONNRESET, timeout, rate limit, provider 5xx and unknown transient failures; hard quota and `retryable:false` are final.
- Four consecutive ECONNRESET turn failures on one task: exactly three `继续` messages to the same session, exponential backoff 3000/6000/12000 ms, attempt increments, no new task, subject unchanged.
- The fourth failure marks the same task `failed` and retains `lastTurnError`/`lastSessionId`.
- A completed turn resets the failure budget; a manual continue grants a fresh three-continue budget.
- `agent_teams_continue_task` / `POST /teams/:id/tasks/:taskId/continue`: captain token allowed, reviewer license (`task:continue`) allowed, plain engineer 403; only `failed` tasks.
- Session loss during a continue requeues the same task (no new task) and records `task.continue_session_lost`.
- A one-shot contractor retries a retryable `send` failure on its own session with `继续` (max 3, bounded by its lifetime, `contractor.continue_scheduled`); a non-retryable error is not continued and a later success completes the contractor.
- A running contractor with `task:continue` may continue a failed task in its own team over HTTP (contractor token; the member MCP catalog is not filtered, but `contractorContinueDenylist()` denies every other team tool and the contractor token is scoped to the continue route); plain members still get 403 and every other contractor route is denied.
- After an automatic or manual continue, claim, heartbeat and update require the new explicit attempt ID. Missing and stale IDs are rejected, a non-assignee receives 403, and a terminal task or a task without an open attempt cannot be completed.
- The continue prompt carries the new `Attempt id: <uuid>` so a member that reports ids can use the current one.
- Continue deferrals are bounded (exponential backoff, `continueDeferCount` cap) and end in `failed` + `task.continue_abandoned` instead of an event every 5s until the lease expires.
- A failed continue send records `task.continue_failed` (primary) and pairs the derived `task.turn_failed` / `task.continue_scheduled` through one `correlationId` with `causedBy`/`primary:false`.
- Dispatch-time errors, watcher-stop errors and cursor failures keep the previous `pending` + `retryNotBefore` requeue.

Evidence: `test/auto-retry.test.mjs`, `test/service-v06.test.mjs`, `test/mcp.test.mjs`.

## 2026-11-01 mailbox delivery backoff

- A mailbox send rejected while the member prompt is running is deferred with exponential backoff (5s, 10s, 20s ... capped at 5min) instead of writing one `message.delivery_failed` event every tick; the message stays pending and is delivered after the prompt ends.
- A successful delivery clears `deliveryFailures`/`deliveryRetryAt`; `sent.ok === false` follows the same path as a thrown rejection.

Evidence: `test/service.test.mjs`.

## 2026-11-07 worktree reclaim, publication backoff and workspace routing

- A no-config MCP call uses an isolated workspace, explicit loopback-only fake transport, and `ECONNREFUSED`; it returns the no-config guidance without calling `ensureDaemon`. A generic fetch error remains distinct and is not guessed to mean the daemon was never reached.
- Reclaim reports global and per-team `active`, `pinned`, `protected`, and `remaining` counts. A team with only pinned references still receives `worktree.reclaim_summary`; summaries contain counts, not paths.
- `tickAll` defers transient `E_PUBLICATION_HELD`/SQLite busy failures with bounded per-team backoff; other teams continue and no repeated `team.tick_failed` event is written. `missing_unit_inheritance` remains terminal and its block event is idempotent across reconcile.
- Reclaim passes for one canonical repository path are serialized; each queued caller executes its own options, including a later `allowOrphanSweep: true` request.
- Archived teams stay in the reclaim reference map, so an opt-in orphan sweep never deletes a `blocked` checkout owned by history; unregistered directories are reported, never removed.
- `cancelled`/`failed` rows that still carry the dispatch-time `mergeState: 'pending'` are abandoned and become eligible after TTL; `blocked`, `conflict`, `rejected`, `review_pending(_internal)`, `review_stale`, `ff_exhausted`, `revert_failed`, `publication_unknown` and unknown states remain pinned.
- A removal raced by a reopen or re-dispatch preserves the new worktree pointer: the task is re-read in a transaction, a changed path/state records `stale_decision`, and only the deleted snapshot's own field is cleared. Phantom rows create no capacity pressure and young or dirty checkouts survive.
- Concurrent adoption of the same team is serialized, re-reads the task after each async step, and cannot turn a successfully adopted delivery back into `blocked`; success clears only adoption-owned retry/block markers. `team.needsCaptain` is recomputed conservatively, so an unrelated unresolved task keeps it set.
- Adoption retries missing worktree, unavailable fence and generic failures through one 5s→300s exponential backoff, terminal at attempt 6; deferred ticks write no `task.adopt_blocked` or `loop.adoption_sweep`.
- Console language selection persists and covers `zh-CN`, `en-US`, `ja-JP` and `ko-KR`; system team names use A/B expressions in each locale while live task subjects, owners, member names and task ids remain verbatim.
- Language switching persistence (storage key `agent-teams-locale-v1`, `?lang=` preview priority, `zh-TW` rejected instead of mapped to Simplified) and value-level catalog regression (no colour team names, no Han characters in `en-US`/`ko-KR` values, demo-versus-live mutation guard, packaged panel not stale) are asserted by `test/ui-i18n.test.mjs`; the four acceptance resolutions keep room for the locale control and the A/B labels and are checked by `test/ui-task-tree-layout.test.mjs`.
- The Task tree header keeps a flexible title block next to a non-wrapping action block; Flow, legend and icon buttons never wrap into or shrink the graph, verified at 1280×720, 1920×1080, 2560×1440 and 3840×2160.

Evidence: `test/mcp.test.mjs`, `test/process-v15.test.mjs`, `test/service.test.mjs`, `test/service-v06.test.mjs`, `test/worktree-reclaim.test.mjs`, `test/ui-i18n.test.mjs`, `test/ui-task-tree-layout.test.mjs`.

## 2026-11-01 patrol queue fallback

- Historical 2026-11-01 behavior: a `delivery=queue` patrol send rejected with "prompt is already running" was stored as a full captain mailbox message (`patrol.queued`). The current contract supersedes that retry path: every adapter `ok:false` result (including busy text) is ambiguous `unknown` and is never automatically replayed; explicit local pre-send admission rejection remains retryable.

Evidence: `test/patrol.test.mjs`.

## 2026-11-01 patrol visibility

- `hidden` historical tasks are excluded from the patrol overview, chain detection and risk sections; only the visible task tree is inspected.
- Broken-chain/drift checks only consider terminal tasks closed within max(4 windows, 1h); active and waiting tasks are always inspected.

Evidence: `test/patrol.test.mjs`.

## 2026-11-01 red box auto review (three continues, then the captain)

- A task that turns `failed` automatically creates one `red-auto-review` row that is `hidden`, has no assignee/attempt/lease, and finishes `completed`; it only sends `继续` to the same task/session.
- The review never creates an implementation task, never edits the subject, and takes no worker slot (`nextReady`/`allocateSlots` never see it).
- Idempotency: `redreview_<sha1(taskId:lastAttemptId)>` is stable across the direct hook, `tick()` sweep and a restarted service; one failure event produces one row and one `继续`.
- After three automatic continues the fourth red box sends no `继续`, messages the captain with taskId/subject/count/sessionId/last error, sets `redReviewEscalated`, and further red boxes stay silent.
- Layering: with `turnFailureRetry.maxAttempts=3` no review exists during the three turn continues; the fourth failure creates the review.
- Permission: daemon system actor and `purpose=red_auto_review` contractor may continue; a plain engineer cannot (`403`, `red_review.denied`); a `task` contractor is not allowed.
- A `red_auto_review` contractor runs the review without creating a model session (`contractor.completed`, no `create` call).
- Visibility: `GET /teams/:id`, `GET /teams/:id/tasks` and `/ui/snapshot` exclude hidden rows; the team payload adds a `redReviews` summary; admins can read raw rows with `includeHidden=1`; `audit()` ignores hidden rows.
- `zcode.redAutoReview.enabled=false` leaves red tasks untouched.
- A member-reported `failed` (the `completeTask` path) is reviewed exactly like a turn failure.
- A manual captain continue after an escalation clears `redReviewEscalated`/the count, so a later red box starts a new automatic cycle.
- The continue budget is per task+session: a changed session starts the count at zero again.
- A review that cannot send yet (the member still owns another open task, `E_STATE`) is deferred (`red_review.deferred`, no continue consumed) and retried after `retryDelayMs`, then sends exactly one `继续`.
- A `hidden` historical failure (legacy retry copy, smoke task) is never auto-reviewed: the direct hook, the restart `tick()` sweep and `ensureRedReview` all skip it, so a restart cannot revive old work.

Evidence: `test/red-auto-review.test.mjs`, `test/auto-retry.test.mjs`, `test/service-v06.test.mjs`.

## 2026-11-08 modularization and native model selection (source verification)

These focused checks do not change the historical T-01..T-55 milestone verdicts above.

| Concern | Source evidence | Boundary |
| --- | --- | --- |
| Dispatch admission/hold/busy recovery | `test/dispatch-recovery.test.mjs` | Capacity is not a provider failure; latest task/worktree state and unknown session occupancy remain fenced |
| Hidden-review stop/resume and stale continue | `test/red-auto-review.test.mjs`, `test/auto-retry.test.mjs` | No ordinary worker allocation; cursor-await stop/session changes prevent stale sends |
| Patrol button behavior | `test/ui-refresh.test.mjs` | VM click/reentrancy/outcome tests; no new rendered GUI acceptance |
| Hot-update pointer refusal | `test/hot-update.test.mjs` | Nine added safety cases and in-memory guard mutation evidence; not a live installed update |
| Windows staging publication recovery | `test/hot-update.test.mjs` | 28 added test instances: bounded retry success/exhaustion/deadline, excluded platform/errors, closed handles, competing targets, journal identity, rollback and pointer-committed recovery; includes unavailable-identity preservation and committed-pointer precedence. Two retry-bypass and two identity-guard negative controls fail as expected |
| Windows zero-skip equivalents | `test/home-safety.test.mjs`, `test/worker-home.test.mjs`, `test/hot-update.test.mjs` | Private DACL and junction containment on this host; other OS runs remain separate |
| Project-local temporary test isolation | `test/tmp-root.test.mjs`, `test/git-bootstrap.test.mjs` | Host ancestor isolation only; fixture parent/junction rejection and real Git write fencing retained |
| Native installed identity and model-state reader | `test/native-agent-model.test.mjs` | Exact realpath identity, runtime containment, malformed/disabled selection refusal, deletion/inherit, no host-state writes |
| Structured protocol model selection | `test/protocol.test.mjs`, `test/manifest.test.mjs` | Slash-containing IDs, own reasoning, workspace-default isolation, pre-create validation and failure cleanup; fake transport |
| Native worker policy and contractor snapshot | `test/native-model-policy.test.mjs` | Fixed/follow-host priority, watcher changes/removal, uncertain applications, unsupported adapters and visible refusal; independently reviewed |
| Native dispatch send boundary | `test/native-model-dispatch.test.mjs` | Serialized apply/send, stale-attempt/session/control fencing, recoverable native hold, uncertain-application recovery |
| Continue/retry and mail model checks | `test/native-model-send-paths.test.mjs` | No stale-model bypass after watcher refusal, no fabricated mail attempt and no dropped delivery; independent review and negative-control mutation pass |
| Domain-gate module boundaries | `test/gates-module-boundaries.test.mjs`, `test/gates.test.mjs`, `test/closed-loop.test.mjs` | Ten pure policy modules behind direct facade exports; expanded focused tests 75/75, AST/differential checks; independent review 4.7/4.5; final full-suite/coverage pending |
| Session occupancy scan deduplication | `test/session-occupancy.test.mjs`, `test/service-v06.test.mjs`, `test/dispatch-recovery.test.mjs` | Pre-change worktree differential; 214 focused tests, zero skips; independent review 4.7/4.8; structure check passes at 279 registered files; final coverage pending |
| MCP shell module boundaries | `test/mcp-shell-boundaries.test.mjs`, `test/mcp-shell.test.mjs` | Protocol tables, lifecycle supervision, pointer validation, watcher ownership, unique wire IDs, deadlines, cancellation cleanup and fail-closed unknown-ID handling; 36 focused tests, scoped lint and structure registration pass; post-review full-suite and independent re-review pending |
| Task completion phase boundaries | `test/task-completion-boundaries.test.mjs`, `test/service.test.mjs`, `test/service-v06.test.mjs`, `test/closed-loop.test.mjs`, `test/process-v15.test.mjs` | Ordered public flow and dynamic service receiver tests; baseline focused set 236/236 and boundary checks 3/3, zero skips; worktree differential and final frozen checks pending |
| Patrol definite-not-sent recovery | `test/patrol.test.mjs`, `test/protocol.test.mjs`, `test/service-v06.test.mjs` | 163 focused tests, zero skips; only local admission and `session/send` request-limit with `requestWritten=false` requeue; uncertain provider/timeout/write-queue results remain held; independent review pending |
| Installed native Subagents entry | Not verified | Requires a manual full-plugin update and native Settings observation |
| GPT captain with real DeepSeek worker | Not verified | Requires an explicitly authorized provider trial; source/fake tests are not paid-provider acceptance |

Final frozen full-suite and independent acceptance are recorded in the current `docs/status/STATUS.md` section, not inferred from this table.
