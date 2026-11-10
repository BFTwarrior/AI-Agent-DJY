# Contributing

This is a documentation-first project. A change that is not reflected in the specification, configuration schema, and tests is not done.

## Before you start

1. Read `AGENTS.md` and `docs/status/STATUS.md`.
2. Read the section of `SPEC.md` you are changing.
3. Check `docs/decisions.md` for the reason behind the current design.

## Change rules

- Keep the 1 captain / 2 teams / 16 default / 32 max / 6 active invariants unless an ADR changes them.
- Update `config/schema.json` and `config/example.two-teams.json` together.
- Add or update a test in `test/`.
- Update `docs/status/STATUS.md`, `docs/status/HANDOFF.md`, and `CHANGELOG.md`.
- Run `npm test`, `npm run check`, `npm run validate`, `npm run plan`.

## Where test scratch space lives

`npm test` preloads `test/support/tmp-root.mjs`, which honours
`AGENT_TEAMS_TEST_TMP` and points `TMP`/`TEMP`/`TMPDIR` at it before any test
runs. Use it to keep the suite's throwaway directories off a small system drive:

```
AGENT_TEAMS_TEST_TMP=D:/Temp/ai-agent-teams-tests npm test
```

Two constraints on that path:

- **Outside the checkout.** `isGitWorkspace` treats every directory under the
  repository as a git workspace, and several tests assert that a non-git
  directory is reported as non-git. A scratch root inside the checkout fails
  those tests even though the code is correct.
- **ASCII only.** Windows re-encodes non-ASCII path segments in some filesystem
  APIs, and the tree then fails to delete with `EPERM` on a path that no longer
  resolves.

Without the variable the OS default is used, so a fresh clone and CI behave
normally. One `npm test` run leaves no new directories under the system temp
root — verified with a before/after directory count.

## AI-agent contributions

AI agents are welcome. A model-authored PR must:

- State which files it read.
- State which invariants it preserved.
- Include command outputs for the checks.
- Not claim features that are not implemented.
- Update the handoff documents.

## Architecture changes

Append a new ADR to `docs/decisions.md`. Do not rewrite old ADRs; supersede them with a new one.

## Release

1. Bump `package.json` and `VERSION`.
2. Update `CHANGELOG.md`.
3. Update `docs/status/STATUS.md` and `docs/status/HANDOFF.md`.
4. Run all checks.
5. `npm run package`.
6. Publish the ZIP as a GitHub release.
