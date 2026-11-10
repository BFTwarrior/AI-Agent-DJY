# Handoff prompt

> Project: Ai-Agent-Teams-Zcode · last formal release: 0.1.8; working source may be newer. Read current status before version-specific actions.

You are taking over the current `Ai-Agent-Teams-Zcode` checkout. Version `0.1.8` is the last formal release; the current source version is recorded in `docs/status/STATUS.md` and may be unreleased. This is not a production-ready product.

Read, in order:

1. `AGENTS.md`
2. `docs/status/STATUS.md`
3. `docs/status/HANDOFF.md`
4. `SPEC.md` sections 1-5
5. `config/README.md`
6. `docs/contracts.md`
7. `docs/roadmap.md`

Hard invariants you must preserve:

- 1 captain and 2 teams; each team has 1 lead, with at most 1 optional workspace shadow.
- Employee roster: 8–32 members per team (16 by default, 32 max); v0.6 creates members on demand.
- 6 active workers by default; roster size is not concurrency.
- Every dispatch has an `attempt_id`; stale writes are rejected.
- Every open attempt has a lease; expiry transitions it to `stalled` and is escalated.
- Dependencies unlock only on `completed`; failed gates are causal edges.
- A verdict binds to artifact digests, not just a task id.
- A reviewer cannot review its own implementation.
- Verify commands are run by the daemon.
- Worktree per active task; container per active member.
- `queue` default, `guide` urgent, `stop` hard interruption.
- The captain cannot self-approve a staged plan.
- `halted` and `escalated` are different.

Follow the active next action in `docs/status/HANDOFF.md`; do not assume a historical task list is still current. Do not start the daemon before the pure logic tests pass.

Run:

```bash
npm test
npm run check
npm run validate
npm run plan
```

Do not claim features that are not implemented. Do not change 1/2/16/32/6 without an ADR. Leave `docs/status/STATUS.md` and `docs/status/HANDOFF.md` more accurate than you found them.
