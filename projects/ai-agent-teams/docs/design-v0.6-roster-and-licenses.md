# v0.6 design: on-demand roster, licenses, contractors, and post-merge review

Status: **historical design snapshot (first implementation described as `0.7.0-alpha.1`); not a current release/status record**. Legacy configs
still run the 6/3-3 behavior; the v0.6 design was enabled by
`config/example.v06.json` and the `features` flags. For current implementation and validation, see `docs/contracts.md`, `docs/test-matrix.md`, and `docs/status/STATUS.md`; do not infer present-day UI, real-model, container, or multi-host acceptance from this dated design.

Related decisions: ADR-0010 (licenses and lazy materialization), ADR-0011
(post-merge outsourced review), ADR-0012 (concurrency presets and control
budgets), ADR-0013 (captain self-wake patrol).

## 1. Terms

- **Member**: a durable seat with an immutable hidden `memberId`.
- **License** (Chinese: 牌照): the visible name and the authority attached to
  that name. A member may hold one active license at a time.
- **Worker**: an active member session that executes tasks. Reviewers and
  mergers are workers while they hold an active task.
- **Control session**: captain, optional team lead, or the optional shadow
  (小队长 / shadow delegate). Control sessions do not consume worker slots, but
  they do consume the total session budget. There is at most one shadow per
  workspace.
- **Contractor**: a one-shot, non-member session. It has no mailbox, no seat,
  and no roster entry. It is killed after returning a result.
- **Captain patrol** (Chinese: 队长自醒巡检): the captain is woken by the daemon
  on a timer or drift event and inspects the team. This is the default patrol
  path and creates no additional session.
- **Patrol contractor** (Chinese: 临时巡检工): a one-shot contractor created only
  when the captain is busy. It scans once, returns findings, and is killed. It
  replaces the persistent rover; there is no long-lived rover by default.
- **Settled**: all of a member's tasks are terminal, all attempts and reviews
  are closed, merges and post-merge reviews are finished, worktrees are clean or
  archived, and no actionable message remains.

## 2. Concurrency presets

These numbers are **active workers**, not roster entries. The employee roster
range is 8–32 per team, 16 by default and 32 maximum. Single-team and dual-team
totals may differ.

| Memory | Conservative single | Conservative dual | Balanced single | Balanced dual |
| --- | --- | --- | --- | --- |
| 16GB | 8 | 6+6 (max 8+8) | 16 | 6+6 (max 8+8) |
| 32GB | 16 | 8+8 | 16 | 10+10 |
| 64GB | 24 | 12+12 | 32 | 16+16 |

Rules:

- 16GB dual-team starts at **6+6**, not 8+8. Each team needs at least six
  workers to schedule work without starving dependencies.
- 16GB dual-team is not recommended below 6+6. Prefer one team of 8.
- 64GB is the performance tier: single-team may reach the design maximum of 32.
- 16GB and 32GB single-team design cap remains 16.
- Dual-team per-team floor is 6. Dual-team ceiling is 10 for 16/32GB and 16 for
  64GB.
- Global default active-worker cap is 32. A user may opt into a larger custom
  cap (up to 64 total) with `allowAboveDesignCap: true`.
- The effective cap is the minimum of the preset, the memory recommendation,
  the runtime/platform cap, and the provider concurrency limit.
- On `429` or a session-cap error, the scheduler reduces active slots and
  records the reduction. It must not retry-storm.

Slot accounting:

```
total sessions = worker sessions + control sessions + contractor sessions
worker sessions <= activeWorkerSlots
control sessions <= maxControlSessions
contractor sessions <= maxContractors
total sessions <= maxTotalSessions
```

Contractor slots:

```
merge slot   = 1 active + FIFO queue   (post-merge review / merge verification only)
patrol slot  = 1 active + FIFO queue   (research/review/test/patrol)
allowBorrow  = false                   (a full slot never borrows the other)
```

The two slots are reserved. A patrol contractor cannot consume the merge slot,
and a merge contractor cannot consume the patrol slot. A queued item waits in
its own slot even when the other slot is idle; this protects merge review from
being starved by long patrol work. `main` is a legacy alias for `patrol` and is
still readable for old configs/rows; new configs should use `patrol`.
`submitContractor` returns after enqueueing/starting; `spawnContractor` is the
blocking internal helper used by merge review and patrol, not by the main
conversation.

A contractor runner retries a retryable provider/network failure by sending
`继续` to its **own** session (max 3, exponential backoff, bounded by the
contractor lifetime and cancellation checks) before marking `contractor.failed`
and cleaning the session. A running protocol contractor also receives a
contractor-scoped token whose only allowed HTTP route is
`POST /teams/:id/tasks/:taskId/continue`; its minimal member server exposes only
`agent_teams_continue_task`. Every other team tool and route stays denied, and
the token is invalid once the contractor is no longer running.

A team lead is optional. For one or two teams the captain coordinates directly
by default so the worker slots are not silently consumed by two lead sessions.
If a lead is created, the UI must show it as a control session, never as a
worker.

### Shadow (小队长)

The shadow is a single, optional **control** seat for the whole workspace. It is
the captain's secretary/delegate: start it when the captain is overloaded or is
working on a long-running problem, stop it as soon as the delegated scope is
closed. It has captain-level authority on both teams but keeps its own
`memberId` and license, and writes every non-GET action as `shadow.action`; it
never impersonates the captain.

- Role key `shadow` (aliases `deputy`, `secretary`, `captain-delegate`, `小队长`).
- Capabilities `captain:delegate` and `task:continue`; `allowedTaskKinds: []`,
  so the scheduler never assigns it delivery work.
- At most one seat per workspace; a second shadow is rejected with
  `E_SHADOW_EXISTS`. A restart reuses the same seat.
- The shadow cannot relicense or delete its own seat; only the captain can
  retire it. It cannot review its own implementation or bypass attempts,
  leases, review gates, or delivery audit. Product-code write tools are denied;
  it coordinates, while code changes go through normal tasks and gates.
- Lifecycle is explicit: `stopped → starting → active → stopping → stopped`;
  a failed stop is `stop_failed` with `lastError`, not a silent success.

The worker pool is shared across teams:

- Per-team minimum 6 and maximum 10 (or 16 on 64GB).
- A team with no ready work lends its idle slot to the other team.
- Fairness debt is recorded so the lending team gets priority later.
- Do not hard-code 3/3 when one team has no work. The old 3/3 rule is a
  fairness baseline, not a reason to leave two slots idle.

## 3. Lazy materialization

Team creation creates only the captain, the team records, and the role quotas.
It creates **zero worker members**.

On a ready task:

1. Reuse an `available` member whose active license covers the task.
2. Otherwise create a member from a role template and issue a license.
3. Otherwise if the caps are full, queue the task.

Member states:

| State | Meaning | Can take new work? | Can re-license? |
| --- | --- | --- | --- |
| `busy` | Running a turn | No | No |
| `waiting` | Idle between turns but owns an open task/attempt | No | No |
| `available` | No open task; same-license work allowed | Yes | No, unless also `settled` |
| `settled` | Every task/review/merge is closed | Yes, or archive | Yes |
| `archived` | No longer active | No | No |

`idle` is **not** a synonym for `settled`. A member waiting for a dependency,
review, merge, post-merge review, or repair is still `waiting`. It must not be
re-licensed just because its current turn is not running.

When a member has no tasks at all, it may stay as a cold seat with its license.
If it is not expected to be reused, archive it. If no tasks exist, create no
members.

## 4. License model

A license is more than a display string. It is the authority envelope:

```json
{
  "licenseId": "lic_...",
  "label": "Frontend Engineer 01",
  "roleKey": "engineer.frontend",
  "allowedTaskKinds": ["implementation", "repair"],
  "pathScope": ["src/web/**"],
  "toolPolicy": "workspace-write",
  "capabilities": [],
  "expiresAt": "2026-11-01T00:00:00Z",
  "issuedBy": "captain",
  "issuedAt": "2026-10-26T00:00:00Z"
}
```

Rules:

- `memberId` and `licenseId` are immutable, hidden from normal UI, and used by
  the scheduler, API, audit, and task history.
- The visible label is the license name. It is unique per team; duplicates get
  an automatic numeric suffix.
- Authorization checks use `licenseId` and `roleKey`, never the label string.
  A member that renames itself must not gain authority.
- `capabilities` lists declared extra authorities beyond `allowedTaskKinds` and
  `toolPolicy`. `task:continue` lets a license call
  `agent_teams_continue_task`; reviewer/auditor roles get it by default.
  Control capabilities are role-bound: `team:lead` exists only on a lead,
  `captain:delegate` only on the shadow. A relicense cannot inject either
  capability into another role, and a role=lead/shadow license always carries
  its control capability. A plain engineer cannot continue a failed task.
  Captain authority comes from the admin token, while the shadow gets
  captain-level delegated authority from `captain:delegate` under its own
  `memberId`/license.
- A member cannot change its own license. It may send a `license_request` with
  the intended task, scope, and reason.
- The captain (or a human) issues, revokes, and replaces licenses. Every change
  is audited.
- A task records the `licenseId` that was active at assignment. License changes
  never rewrite task history.
- Reviewer independence is checked by `memberId` and task history, not by the
  current label. A former engineer who becomes a reviewer still cannot review
  its own work.
- If a member is `waiting`, a license change is rejected. The task must first be
  completed, failed, or cancelled and all reviews/merges closed. Pausing alone
  is not enough.
- Re-licensing always stops the old session, archives the old transcript,
  revokes the old license, issues the new license, and starts a **fresh**
  session. Old conversation context is not inherited. An approved handoff
  summary may be supplied explicitly; it is not a transcript replay.
- Same-license reuse may resume a session for a related task or start a fresh
  one. Default is a fresh session per task. License changes always use a fresh
  session.

Settled guard for re-licensing:

- all tasks terminal (`completed`, `failed`, `cancelled`);
- all attempts closed and no active lease;
- code review closed, no pending rework;
- merge closed, including post-merge review;
- worktree merged, archived, or verified clean;
- no actionable mailbox message;
- no open patrol finding.

If any check fails, the API returns a conflict with the blocking items.

## 5. Post-merge outsourced review

The internal code reviewer approves an exact commit/patch. The merger executes
only the approved merge order and never edits code.

Recommended flow:

```text
engineer -> internal code reviewer -> merger
                                     |
                                     v
                            integration branch
                                     |
                                     v
                         outsourced post-merge reviewer
                          / approve              \ reject
                    fast-forward main       discard/revert
                                                   |
                                             internal repair
```

The contractor checks only:

1. the merged patch is the approved commit/patch;
2. no extra files or commits were added;
3. the required tests/build pass;
4. no obvious semantic drift;
5. no obvious security or dependency regression.

It does not re-review the whole codebase and does not edit or merge. It returns
a structured verdict with evidence, then is killed.

Failure routing:

- `merge_mechanics` -> merger retries once; the code reviewer is not involved.
- `code_defect` -> discard/revert, create an internal repair task, then code
  review again.
- `test_flake` -> rerun once; it is not a code rejection.
- `conflict` -> stop; return to the original engineer; the merger must not
  resolve conflicts.
- `no_evidence` rejection -> internal reviewer confirms before rollback.

The integration-branch step is preferred: main never receives rejected work.
If a repository cannot use an integration branch, merge to main and auto-revert
the merge commit on rejection.

A separate internal merge reviewer B is optional for high-risk changes. B must
differ from the code reviewer A and the merger, only approves/rejects the merge
result, and never edits code. Low-risk changes may let A sign the merge result
instead of creating a third session. At most two merge-review rounds before
captain/human escalation.

## 6. Captain self-wake patrol and one-shot fallback

The captain is the default patrol agent. The daemon is the alarm clock: the
captain cannot originate a wake-up by itself. After the plan is approved, the
daemon may wake the captain on a timer or a drift event, send a compact patrol
prompt, and let it inspect the team.

Wake path:

1. If the captain session is live and idle, send the patrol prompt.
2. If the session is closed but known, resume it (`session/resume` in the
   protocol; CLI `--resume` is already verified) and send the prompt.
3. If the session is lost, create a new captain session from the persisted team
   state and a compact summary.
4. If the captain is busy with a task, do not interrupt it for patrol. Create a
   one-shot **patrol contractor** instead: it scans once, returns findings, and
   is closed and killed.

The patrol contractor is not a member, has no mailbox or seat, and never
persists. It has a read-only snapshot, a per-cycle timeout and budget, and the
same standing orders as the captain. It may send a nudge and report; it may not
edit code, merge, reassign members, approve plans, or halt the team. If a
critical deterministic rule fires (for example, destructive out-of-scope work),
the daemon pauses the task itself and then notifies the captain/human; the
contractor does not receive broad pause authority.

Two layers of detection:

- **Deterministic watchdog** (no model cost): timeouts, missing heartbeat,
  out-of-scope paths, no progress, failed tests, stale lease, merge conflict.
- **LLM patrol** (event-driven, or every 5-10 minutes only when work is active):
  reads task contracts, diffs, test evidence, review records, and messages;
  looks for semantic drift.

Line of authority:

- Captain patrol uses the captain's normal authority, but the captain must not
  audit or approve its own implementation.
- Patrol contractor is a sensor: it reports to the captain/human and is killed
  after one cycle.
- Neither patrol path may edit code, merge, or claim a normal task. A repair is
  a new task that goes through the normal engineer -> review -> merge flow.
- No active work means no patrol. The daemon sleeps instead of burning tokens.

Context hygiene: repeated captain patrols must not flood the captain's main
conversation. Use a compact structured patrol prompt and a short report; if the
protocol fork is available, run the patrol in a fork and merge only the
findings. Otherwise compact the captain session on a schedule. This choice must
be tested before claiming context safety.

## 7. Group leader deferred

Group leaders are **not** part of the current design. They are revisited only
when more than two teams exist. If enabled later:

- one group leader per 3-4 teams;
- may assign/reassign within its group, send messages, pause a task, and
  escalate;
- may not approve plans, change budgets/config, merge, delete teams, halt a
  team, bypass review, or read another group;
- lazy-created and shown as a control session.

## 8. Installer detection and recommendations

ZCode 0.17.0 does not expose a maximum-subagent setting:

- `runtime/capabilities` returns only `independentPlanState`, `historyFirst`,
  and `sessionDirectorySource`;
- neither the config nor `zcode doctor` exposes a limit.

The installer must therefore:

1. query the ZCode version and capabilities and record "not exposed";
2. detect RAM, CPU, disk, and Docker memory;
3. propose conservative/balanced presets from the table in section 2;
4. show detected, recommended, and hard-cap values;
5. let the user adjust and confirm;
6. use a platform limit automatically only if ZCode later exposes one;
7. downgrade on `429` or session-cap errors and record the event.

The installer must not invent a maximum-subagent number. Recommendations are
hardware guidance, not a guarantee.

## 9. Compression and cold lifecycle

Goal: when a member is waiting, or the session/subagent budget is exhausted,
release memory without losing task state or corrupting an attempt.

Work state and residency are separate:

| Residency | Meaning | Memory |
| --- | --- | --- |
| `hot` | Session running a turn | Full |
| `warm` | Session alive but idle; context compacted | Medium |
| `cold` | Session closed; structured summary and task/attempt persisted | Minimal |
| `archived` | Transcript compressed on disk; no live session | None until rehydrated |

A member can be `waiting` and `warm`/`cold` at the same time. Cold never
changes the work state or the license; it only changes residency.

Triggers:

- **Idle TTL**: an `available` member goes cold after 10 minutes by default. A
  `waiting` member on a dependency/human/contractor goes warm after 2-5 minutes,
  then cold.
- **Quota pressure**: when total sessions reach 80% of `maxTotalSessions`, or a
  `429`/session-cap error occurs, cold idle sessions first, then queue new work.
- **Memory pressure**: above the high watermark (80% of the memory budget),
  evict lowest-priority idle sessions until below the low watermark (65%).
- **No ready tasks**: cold available workers; keep the captain hot only while
  active work exists.
- **Manual sleep**: the user or captain can put a member to sleep.

Never cold:

- a running turn or tool call;
- an active lease/attempt without a successful checkpoint;
- a merge critical section or an uncommitted worktree;
- a reviewer/merger while a verdict is being written.

Warm compression:

- compact the session context (`session/compact` when available, otherwise a
  structured summarization prompt);
- persist a summary with: `memberId`, `licenseId`, task IDs, attempt IDs,
  status, changed paths, decisions, open findings, commit hashes, next step,
  and timestamp;
- archive the raw transcript; mark the summary as potentially stale and require
  a file re-read before editing.

Cold transition:

1. wait for the turn boundary; stop only if the session is still running;
2. checkpoint the worktree (commit to the task branch or stash with a recovery
   record);
3. close the session and release its memory;
4. persist the summary and keep the attempt fencing token;
5. leave the license and task ownership unchanged.

Resume:

- prefer `session/resume` when the session is still valid and the checkpoint
  matches;
- otherwise create a fresh session, attach the summary as historical context,
  re-read the worktree, and reuse the same attempt token only after fencing
  checks;
- never create a duplicate attempt or approve stale work after a cold resume.

Quota exhaustion:

- cold idle sessions first; never kill a running turn just to create a new one;
- queue new tasks and resume by fairness debt, deadline, and dependency depth;
- on `429`, reduce active slots and back off; do not retry-storm;
- record every residency transition and the reason.

Storage and UI:

- tables for `member_summaries`, `residency_events`, and archived transcripts;
- summaries must not contain credentials or secrets;
- show hot/warm/cold counts, estimated memory saved, and resume latency in the
  team view.

Acceptance tests:

- idle -> warm -> cold -> resume for an `available` member;
- quota full -> idle cold, queued task resumes after a slot frees;
- refusal to cold during a running turn, an uncheckpointed attempt, or an
  uncommitted worktree;
- resume does not duplicate an attempt;
- summary contains no secrets and is marked stale;
- 80%/65% memory watermarks trigger and stop eviction correctly.

## 10. Implementation order

Start with **Phase 0 and Phase 1**, then **Phase 2**. Everything else depends on
the configuration model and the member state machine. Compression is Phase 3 so
there is a reliable state to cold and resume.

| Phase | Work | Acceptance |
| --- | --- | --- |
| 0 | Baseline and feature flags. No behavior change. | Existing 101 tests and check still pass. |
| 1 | Config/schema presets, worker caps, control/contractor caps, `allowAboveDesignCap`, memory thresholds. Installer detection interface (report only). | Validator accepts old configs; presets resolve correctly for 16/32/64GB; old 6/3-3 behavior remains the default until explicitly enabled. |
| 2 | Member state machine, lazy creation, shared worker pool with fairness debt, zero members at team creation. | No member created with no tasks; 16GB 6+6 and 32/64GB presets schedule correctly; no fixed 3/3 idle starvation. |
| 3 | Compression and cold lifecycle: warm summary, cold close, resume, quota/memory watermarks. | Section 9 tests pass; no cold during active work; resume no duplicate attempt. |
| 4 | License model and settled guard: hidden IDs, visible license label, captain-only issue/revoke, fresh-session re-license. | Name cannot grant authority; waiting member cannot re-license; settled member can; old transcript is not inherited. |
| 5 | Contractor lifecycle and post-merge review: one-shot session, integration branch, signed merge order, verdict routing, kill. | Contractor is not a member; post-merge reject rolls back/discards and creates a repair task; max two rounds. |
| 6 | Captain self-wake patrol and one-shot fallback: resume/rehydrate, patrol lease, findings, no self-audit. | Idle captain wakes; busy captain triggers one patrol contractor; no patrol with no work; contractor has no edit/merge authority. |
| 7 | Installer recommendations and adaptive throttle: memory-based presets, ZCode version/capability report, 429 downgrade. | No invented platform maximum; recommendation is adjustable; downgrade is recorded. |
| 8 | Real-model E2E and docs/STATUS/matrix updates. | At least one real single-team and one dual-team run; matrix rows move honestly. |

Phase 1 must keep the current 6/3-3 defaults unless the user selects a preset.
Do not switch production defaults while adding the schema.

## 11. Implementation checklist

- Config: presets, `activeWorkerSlots`, per-team floor/ceiling, control and
  contractor caps, `allowAboveDesignCap`, post-merge review policy, patrol mode.
- Store: member states, licenses, license history, contractors, settlements,
  patrol findings, merge-review records, member summaries, residency events.
- Scheduler: lazy materialization, shared pool with fairness debt, settled
  guard, control/worker/contractor budgets, adaptive downgrade, patrol lease,
  idle scanner, quota/memory watermarks.
- Sessions: fresh-session re-licensing, one-shot contractor lifecycle, process
  tree kill, transcript archive, captain resume/rehydrate, context compaction,
  cold close and resume.
- Merge: integration branch, signed merge order, post-merge contractor verdict,
  rollback/repair routing, optional reviewer B.
- MCP/API: `license_request`, `relicense`, `list_licenses`, `spawn_contractor`,
  `contractor_result`, `kill_contractor`, `patrol_tick`,
  `spawn_patrol_contractor`, `pause_task`, `rollback_task`, `sleep_member`,
  `wake_member`.
- Installer/doctor: detection report and preset writer.
- Tests: 16GB 6+6 scheduling, settled guard, no context inheritance, contractor
  kill, post-merge rejection routing, max-two-round escalation, no member
  creation when idle, captain wake/resume, no patrol when no work, warm/cold/
  resume transitions, quota/memory eviction, no duplicate attempt after resume.

## 12. Open questions

- Exact provider concurrency limits are provider-specific and must be measured
  or supplied by the user.
- 64GB single-team 32 and dual 16+16 need real-model load validation before
  being called verified.
- Whether same-license reuse should default to fresh sessions for every task or
  only for role changes; the initial implementation should default to fresh.
- Captain patrol context growth is untested. Prefer a fork or a compact patrol
  prompt plus scheduled compaction; do not assume the captain's main context
  stays clean until verified.
- Protocol `session/resume` is live-verified together with `session/compact`
  by `npm run zcode:lifecycle`; captain wake-up after a daemon restart still
  needs a recovery test or explicit rehydration from persisted state.
- Closing a protocol session may free its context but not return app-server RSS
  to the OS. Measure this; when no active session remains, a controlled
  app-server restart may be needed to actually reduce process memory.

## 13. Soft isolation default

The default v0.6 installation is `worktree` isolation. It requires only git and no virtualization. Safety measures: one worktree per task, independent member sessions/homes, read-only tool policy for reviewer/analyst licenses, member-scoped tokens, git-derived changed paths, license path-scope checks, and the review/merge queue. `GET /teams/:id/soft-isolation` verifies these checks. WSL2 + Docker/Podman remains an optional stronger tier; it is not a prerequisite.

## 14. Host-aware installer

`src/installer.mjs` detects Windows build, virtualization (`HypervisorPresent` / `VirtualMachinePlatform`), WSL2, Docker/Podman, memory, disk, admin rights and pending reboot. If virtualization and the system are ready, it recommends WSL2 + Podman/Docker; otherwise it recommends soft isolation. The wizard then asks single/dual team and conservative/balanced preset. `install:plan` writes worktree config until container dispatch is wired; `CONTAINER_DISPATCH_READY` must be flipped only after the container self-test exists. The installer only reminds the user to reboot; it never reboots automatically.

Runtime options must be shown with price/license labels: Podman Desktop is free/open source and is the default recommendation; Docker Desktop is free for personal/small-scale use but may require a paid subscription for larger commercial use; WSL2 + Docker Engine is free but advanced. The installer must not silently choose Docker Desktop for a commercial user.
