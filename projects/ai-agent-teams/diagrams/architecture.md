# Architecture

```text
ZCode host (UI, native panel, MCP client)
        |
        | MCP tools / HTTP + SSE
        v
  ai-agent-teams daemon  ── SQLite (state, attempts, leases, events)
        |
        +-- Team A: 1 lead + roster (default 16, max 32, shared worker slots)
        +-- Team B: 1 lead + roster (default 16, max 32, shared worker slots)
        +-- optional single shadow (captain-level, on-demand)
        |
        +-- per-task worktree (task working directory)
        +-- optional container (isolation boundary)
```

One captain coordinates two teams. The daemon owns persistent state and dispatch; each
task carries an attempt identity and lease, runs in its worktree, and is verified by daemon
commands. Review is independent from implementation and binds its verdict to artifact
digests. Only completed tasks unlock dependencies. See `SPEC.md` and `docs/contracts.md`.
