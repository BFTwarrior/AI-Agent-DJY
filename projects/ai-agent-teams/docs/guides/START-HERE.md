# START HERE

Project: `Ai-Agent-Teams-Zcode` · latest formal release 0.1.8.

The **last formal release is 0.1.8**. The current working source/package metadata is **0.2.2, unreleased**; neither label asserts production readiness or installed-plugin acceptance.

Read the current sections of STATUS/HANDOFF for the active source state and acceptance boundaries; historical release measurements do not certify the current worktree. `SPEC.md` is a target design, not a runtime-status record. Native agent resources require a full manual plugin update, not a runtime-only hot update.

## If you are an AI model

0. If the user pasted this repository's GitHub link and asked to install, read `docs/guides/INSTALL-WITH-AI.md` first and run the four-stage wizard; do not skip stages.
1. Read `AGENTS.md`.
2. Read `docs/status/STATUS.md`.
3. Read `docs/status/HANDOFF.md`.
4. Read `SPEC.md` sections 1-5.
5. Read `config/README.md` and `docs/contracts.md`.
6. Read `docs/design-v0.6-roster-and-licenses.md` for the historical v0.6 design; use current contracts, tests and status for implementation evidence.
7. Run `npm test` and `npm run check`.
8. Start with the next task in `docs/status/HANDOFF.md`. Do not change 1/2/8-32/6 numbers or the single-shadow rule without an ADR.

## If you are a human

1. `docs/guides/INSTALL.md` to install the plugin (a ready-to-add marketplace ZIP is in `dist/`). For the GitHub-link AI install flow, use `docs/guides/INSTALL-WITH-AI.md`.
2. `README.md` for the overview.
3. `SPEC.md` for the complete design.
4. `docs/roadmap.md` for milestones.
5. `docs/status/HANDOFF.md` for what is done and what is next.

## One-line rule

**1 captain, optional 1 shadow, 1-2 teams, zero members at start in v0.6, 8-32 member roster (16 default), memory-based presets.** Legacy configs use 6 active workers; roster size is not concurrency.
