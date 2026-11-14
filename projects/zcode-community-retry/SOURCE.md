# Source and provenance

- Distribution: **Zcode-Persistence V0.4.5** (2026-11-14)
- Upstream: [`tangyixiao/zcode-community-retry`](https://github.com/tangyixiao/zcode-community-retry) — this directory is a fork, not the upstream source of truth.
- Local behaviour: every model request failure — including terminal provider errors such as 1113 insufficient balance, 401/403 and permission errors — is retried at most **3 times** (4 physical requests in total), then the last response is returned unchanged.
- Changes against upstream:
  - `always` mode with `alwaysMaxRetries` (default 3) for the native plugin, standalone CLI and MCP tools.
  - HTTP 200 responses are inspected for JSON error payloads, including flat `{"code":"1113","msg":"..."}` bodies, with or without a JSON `Content-Type`.
  - `Retry-After` is honoured up to one hour in `always` mode (attempt-bounded, not time-bounded).
  - `unlimited` and `bounded` modes keep their upstream semantics for callers that opt in explicitly.
- Verification: `npm test` — 109 passing (2026-11-14). Behaviour of the packaged copy was re-checked against the installed plugin cache.
- Archive: release `proj-zcode-community-retry-v0.4.5`, asset `Zcode-Persistence-V0.4.5-20261114.zip`.
- Requirements: ZCode Desktop on Windows (Node.js 22+ available to the plugin host), or the explicit CLI/DSH loader.

Known limits: content already delivered to the client is never replayed; request bodies that cannot be copied are passed through untouched; the plugin depends on ZCode internal interfaces and may need adaptation after a ZCode upgrade.
