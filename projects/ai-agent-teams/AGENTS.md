# AGENTS.md - read this first

Project: `Ai-Agent-Teams-Zcode` (directory), current source 0.2.2 (unreleased). Internal package/plugin id: `ai-agent-teams`.

Status: last formal release 0.1.8; v0.8 target-design baseline; current source 0.2.2 is unreleased. Last updated: 2026-11-11.

This file is the onboarding contract for any AI model or human continuing the project. Read it before changing anything. `SPEC.md` describes target design, not runtime status; current behavior is defined by source, `config/schema.json`, tests and `docs/contracts.md`, while `docs/test-matrix.md` and `docs/status/STATUS.md` record coverage and current acceptance.

Read `docs/guides/CONSTRAINTS.md` before writing code. Do not weaken it to make a change pass.

## Mission

Build a team control plane for ZCode: one captain, two teams, 16 members per team by default (max 32), six active workers by default. The system must be understandable, configurable, testable, and recoverable by a model that has never seen this repository.

## Read order

1. `docs/guides/START-HERE.md` if present; otherwise this file.
2. `docs/status/STATUS.md`
3. `docs/status/HANDOFF.md`
4. `SPEC.md` sections 1-5 (product, gap audit, domain, scheduling, quality)
5. `config/README.md`
6. `docs/contracts.md`
7. `docs/decisions.md`
8. `docs/roadmap.md`
9. `docs/guides/LOCALIZATION.md` (locales, time zone, English-prompt rule)

## File placement (hard rule)

`<workspace>` is a shared public root. Never create files or folders directly in it.

- Temporary work, patches, review notes, mutation harnesses, logs: `<project>/.tmp/<YYYY-MM-DD>-<topic>/`.
- Current documents and diagrams: `<project>/docs/` and `<project>/diagrams/`.
- Superseded versions: the project `CHANGELOG.md`, plus tags and Releases; this repository keeps no `history/` directory. A workspace that still uses localized note folders keeps them as data, never as repository layout.
- Reviewer scratch space must also live inside the project's dated `.tmp` folder, never in the public root.

Subagents share this rule. A reviewer that needs to write `review.md` or a mutation script writes it under the same dated `.tmp` folder and reports the path in its result.

## Language policy (hard rule, all future versions)

Internal material is English, always. This applies to every later release and to work resumed in a new conversation:

- `prompts/*.md`, `src/service/prompts.mjs`, the patrol report text (`src/service/patrol-run.mjs`), `initialize.instructions` and the shared `PANEL_STARTUP_RULE` (`src/domain/prompt-rules.mjs`), the SessionStart hook payload (`scripts/session-start.mjs`), scheduled message bodies built in `src/domain/scheduler.mjs` (`redReviewEscalationText`), MCP tool descriptions/examples, skill and command files (`skills/*/SKILL.md`, `commands/*.md`) contain English sentences only. No new Chinese prose.
- `test/prompt-language.test.mjs` checks selected generated prompts and quality-gate source text; it does not scan every static prompt, skill, command, or MCP description listed above. Review those files manually and extend the test when adding model-facing text.
- User-visible surfaces may be localized: installer/CLI messages, panel labels, web-console strings and `locales/<locale>.json`. Supported locales are `zh-CN`, `ja-JP`, `ko-KR`, `en-US`; `auto` is resolved once to a concrete locale and time zone when the install writes `config/local.json`. See `docs/guides/LOCALIZATION.md`.
- Real user directory names (`文档/`, `逻辑图/`, `归档/历史/文档/`, `归档/历史/逻辑图/`) are data, not prompt text: keep them verbatim.
- A literal protocol value sent to a session (the `继续` continue token) or emitted by code as an identifier (for example the `[自动继续审查上报]` escalation title, which prompts and the panel match on) stays quoted as a literal, optionally with an English gloss. It is not a translatable sentence; the surrounding message body is English.
- When touching a prompt file, convert every sentence in it in the same change; do not half-translate.

## Non-negotiable invariants

The numbered requirements are in `SPEC.md` section 3.7 (INV-001..INV-052); their numbering does not imply implementation. INV-046 is an unimplemented target requirement, not a current invariant. The table below highlights the ones most likely to be broken:

| ID | Invariant |
| --- | --- |
| INV-001 | 1 captain, 2 teams, 1 lead per team, optional 1 shadow/workspace. |
| INV-002 | Employee roster 8..32 per team; default 16, max 32. |
| INV-051 | At most one shadow; captain-level authority, own identity/audit, no self-edit or self-review. |
| INV-052 | Shadow starts on demand and stops when done; restart reuses the same seat. |
| INV-003 | `activeWorkerSlots = 6` by default; never assume 32 concurrent. |
| INV-004 | Only active workers get a ZCode session/container. |
| INV-005 | Every dispatch carries `attempt_id`; stale updates are rejected. |
| INV-006 | Every open attempt has a lease; expiry becomes `stalled` and is escalated. |
| INV-007 | A reviewer cannot be the implementer of the same task. |
| INV-008 | Verify commands are executed by the daemon; member self-reports are supplementary. |
| INV-009 | Worktree is the task working directory; container is the isolation boundary. |
| INV-010 | `queue` by default, `guide` for urgent, `stop` for hard interruption. |
| INV-011 | The daemon owns SQLite; members never write the DB directly. |
| INV-012 | There is no `--model` CLI flag; use protocol `session/setModel`. |
| INV-013 | The native tab is owned by the host team; the daemon exposes HTTP/SSE. |
| INV-014 | Do not claim production readiness or absolute security. |
| INV-015 | Dependencies only unlock on `completed`; failed/cancelled never unlock. |
| INV-016 | A failed gate is a causal edge (`findingSourceTaskIds`), not a dependency. |
| INV-017 | A verdict binds to artifact digests, not just a task id. |
| INV-018 | A passing review cannot leave open high/blocker findings. |
| INV-019 | Implementation completion requires acceptance/commands/changedPaths evidence. |
| INV-020 | Repair scope is derived from findings, not copied blindly. |
| INV-021 | Delivery audit is independent of task completion. |
| INV-022 | One member can own only one open task. |
| INV-023 | Removing a member must revoke, requeue, interrupt, and drain. |
| INV-024 | Captain takeover is one unfinished task at a time. |
| INV-025 | Mail has delivery claims and discard rules. |
| INV-026 | A staged plan creates zero sessions and zero tasks. |
| INV-027 | The captain cannot self-approve a plan. |
| INV-028 | Discard must not auto-rebuild the team. |
| INV-029 | `halted` and `escalated` are different states. |
| INV-030 | `toolPolicy` can only select a declared id. |
| INV-031 | Captain-only tools can never be reopened by a policy. |
| INV-032 | The four coordination tools are always available. |
| INV-033 | Profile snapshots freeze at team creation. |
| INV-034 | Route snapshots freeze; fallback does not change the primary snapshot. |
| INV-035 | `memberMaxDepth = 0` by default. |
| INV-036 | 32 roster rows is not 32 concurrent workers. |
| INV-037 | Cross-team task dependencies are forbidden in v1. |
| INV-038 | Containers are non-root, read-only root, network restricted. |
| INV-039 | Merge in dependency order; conflicts are never force-resolved. |
| INV-041 | Incompatible ZCode versions fail closed. |
| INV-042 | Archives are read-only and cannot wake members. |
| INV-043 | Every state change writes an event. |
| INV-044 | Times are epoch ms; paths are POSIX. |
| INV-045 | IDs are globally unique and never reused. |
| INV-047 | Error codes are stable. |
| INV-048 | No silent degradation; degrade with a warning. |
| INV-049 | Never silently drop messages, tasks, or evidence. |
| INV-050 | Docs, schema, tests, and status move together. |

## Repository map

```text
SPEC.md                 target spec (19 numbered sections (0-18), 51 numbered invariant entries including unimplemented INV-046, 55 counted baseline scenarios; supplements are tracked separately)
README.md               overview and quick start
docs/guides/START-HERE.md    one-screen routing (if present)
docs/status/STATUS.md        component status matrix
docs/status/HANDOFF.md       current state, next tasks, verification
CHANGELOG.md     release history
llms.txt                     machine-friendly index
config/                      JSON Schema, examples, field reference
docs/decisions.md       ADRs
docs/contracts.md       HTTP/SSE/SQL/discovery/protocol mapping
docs/roadmap.md         M0-M10 milestones
docs/verification.md    verified ZCode facts and commands
docs/known-limits.md    physical/environmental limits
docs/glossary.md        terms
prompts/                captain, team-lead, member, reviewer, handoff prompts
src/                    backend, MCP server, adapters, domain logic and extracted service modules
.zcode-plugin/          ZCode plugin manifest
skills/ commands/     plugin resources
test/                   Node built-in tests
scripts/                checks and ZIP packaging
examples/               sample task graph
```

## Commands

```bash
npm test                 # node --test test/*.test.mjs
npm run check            # required files, JSON, config invariants, SPEC headings
npm run validate         # validate the canonical config
npm run plan             # print a deterministic dispatch plan
npm run package          # build dist/ai-agent-teams-v<version>.zip
```

## How to make a change

1. Change the contract first: update `SPEC.md` and/or `docs/`.
2. Update `config/schema.json` and `config/example.two-teams.json` if configuration changes.
3. Update `src/` pure logic and `test/`.
4. Update `docs/status/STATUS.md`, `docs/status/HANDOFF.md`, and `CHANGELOG.md`.
5. Run `npm test`, `npm run check`, `npm run validate`, `npm run plan`.
6. If the decision is architectural, append an ADR to `docs/decisions.md`.

## Definition of done

A change is done only when:

- The contract is documented.
- The configuration schema accepts it.
- A test or check covers it.
- `docs/status/STATUS.md` and `docs/status/HANDOFF.md` say what changed.
- `npm test` and `npm run check` pass.

## Do not

- Do not silently change the 1/2/8-32/6 numbers or the single-shadow rule.
- Do not default to 32 concurrent workers.
- Do not use `--model` (it does not exist).
- Do not bypass attempts, leases, or the daemon's SQLite.
- Do not let a reviewer review its own implementation.
- Do not claim absolute security with plain containers.
- Do not remove the handoff files or the read order.
- Do not add Chinese prose to internal prompts, system instructions, MCP descriptions, skill/command files or agent templates; localize only user-visible surfaces.
- Do not rewrite `docs/decisions.md` history; append a new ADR.

## Current handoff

Read the active 2026-11-10 handoff section in `docs/status/HANDOFF.md` and `docs/status/STATUS.md` for current source state, scope and next actions. The `Next three tasks` block in HANDOFF is an older planning snapshot; do not treat its proposed load/recovery/container tasks as current without reconciling against the current matrix and status. `docs/design-v0.6-roster-and-licenses.md` records the historical v0.6 design; current implementation evidence belongs to source, `config/schema.json`, tests and `docs/contracts.md`. Do not claim a milestone complete while its rows in `docs/test-matrix.md` remain `not covered`.
