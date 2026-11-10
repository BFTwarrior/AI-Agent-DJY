# Constraints

Last reviewed: 2026-11-10 (current source/package test and quality checkpoint). Final verification belongs in docs/status/STATUS.md; dated measurements below are historical snapshots, except rows explicitly marked as the 2026-11-10 local run.

This file is the quality bar for AI Agent Teams. Read it before changing code and do not weaken it to make a change pass.

## Floor (always enforced)

- No new suppression comments (`@ts-ignore`, `eslint-disable`, `# noqa`) or equivalent.
- No unimplemented stubs (`throw new Error("Not implemented")`) or empty `catch {}` that hides a failure.
- No skipped or deleted tests to make a change pass. The three former Windows-only skips now have platform-equivalent coverage (junction containment and private DACLs); zero skips are required.
- No secrets, API keys, tokens or private URLs in source, tests, docs or logs.
- Tests must not mutate real repository assets or user state; use isolated project-local temporary fixtures or exact in-memory mocks. Restoring a real file after writing it does not make the test isolated.
- No public-surface change without an explicit request: MCP tool names, HTTP routes, CLI commands, config keys, SSE event names and persisted state file names stay compatible.
- Internal prompts, `initialize.instructions`, the shared `PANEL_STARTUP_RULE` (`src/domain/prompt-rules.mjs`), the SessionStart hook payload (`scripts/session-start.mjs`), scheduled message bodies built in `src/domain/scheduler.mjs` (`redReviewEscalationText`), MCP tool descriptions/examples, patrol report text, skill/command files and agent templates are English only; user-visible UI/CLI text may be localized (see `docs/guides/LOCALIZATION.md`). This applies to every future version, including work resumed in a new conversation. `test/prompt-language.test.mjs` checks selected generated prompts and quality-gate source text, not every static model-facing file; review static prompts, skills, commands and MCP descriptions manually. The only tolerated CJK is the `继续` protocol token, the `[自动继续审查上报]` title and real directory names.
- `zcode.locale` and `zcode.timezone` accept `auto`, but every generated `config/local.json` and every `loadConfig` result carries concrete values; a locale/time-zone catalog never changes prompt language.
- Refactors must not change scheduling, retry, audit, merge or isolation behavior. Existing tests must pass without being modified to accept new behavior.

## Enforced with numbers

| Dimension | Rule | Checked by | Runs at |
|-----------|------|-----------|---------|
| Test suite | At least the 1117 tests passing at the pre-correction 2026-11-08 checkpoint, plus all added regressions; zero failures and zero skips. Latest recorded local run (2026-11-11): 1394 pass, 0 fail, 0 skipped. | `npm test` | every batch and task end |
| Lint | Zero errors from the minimal ESLint config | `npm run lint` | every batch and task end |
| Coverage ratchet | Aggregate across loaded source files: lines >= 79%, branches >= 63%, functions >= 79% (not a per-file threshold). Local 2026-11-10 checkpoint (source 0.1.11) run: 90.80% lines, 78.68% branches, 90.33% functions; raw output: `.tmp/2026-11-10-scheduler-final-acceptance/current-doc-audit-coverage.log`. | `npm run test:coverage` (Node built-in coverage; unloaded entry points are not counted) | task end |
| Dependency scan | No high or critical vulnerabilities | `npm run audit:deps` | task end |
| Structural check | `CHECK OK`; all source modules, tests and test helpers explicitly registered, 19 SPEC sections, 14 example tasks (308 required files at the 2026-11-10 local checkpoint; 258 at the recovery checkpoint) | `node scripts/check.mjs` | every batch and task end |
| UI i18n coverage | `I18N COVERAGE OK`; every extracted UI string is translated and the packaged panel carries every locale `name` | `npm run check:i18n` | every batch and task end |
| Public surface | No removed/renamed MCP tool, route, config key, event or CLI command | diff review + existing tool-name/config tests (check verifies file presence, not the full surface) | task end |
| Review | Independent review score >= 4.5/5 overall and >= 4.0/5 code, zero blocking findings | independent review agent | before packaging |
| Package content | Installed tree digest equals the built source tree (`contentOk=true`) | `src/install-wizard.mjs --inspect` | packaging |
| Refactor scope | Each reviewed change states its concern and keeps behavior unchanged | diff review | every batch |

`npm run check:quality` runs lint, asset syntax checks, coverage, the i18n
coverage check and the dependency audit together.

## Measured, not yet enforced

| Metric | Today | Direction |
|--------|-------|-----------|
| Coverage (historical, measured 2026-11-06) | lines 89.5%, branches 76.7%, functions 89.4%; current 2026-11-10 test/coverage result is recorded in the enforced gate above | must not fall below the enforced floor |
| Source lines (`src/**/*.mjs`) | 35,301 across 113 files at the 0.1.10 native-integration checkpoint (34,724 / 111 at the recovery checkpoint); includes earlier worktree changes and the explicitly requested native-model feature, not only extraction | must not grow without a functional reason |
| Largest module (`src/scheduler-service.mjs`) | 3,065 lines at the 2026-11-10 documentation-review source inspection (3,102 at the scheduler-decomposition checkpoint; 6,352 at native integration; 6,326 after earlier merge/patrol extraction; 6,861 before it) | must not grow during cleanup |
| Test files (`test/**/*.test.mjs`) | 84 files at the 2026-11-10 source checkpoint (74 / 32,576 lines at the native-integration checkpoint; 69 / 30,612 at the recovery checkpoint) | must not shrink by deleting assertions |

## Exceptions

None. If an exception is required, add it here with an owner, reason and expiry date (maximum 90 days).

## Autonomy note

The constraint interview was skipped because this is an autonomous run with an existing quality contract. The floor and numbered gates above apply in full, including coverage and dependency scanning. Project-wide mutation, additional static security scanning and performance budgets remain proposals; no new exception or weakened gate is introduced.
