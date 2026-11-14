# Zcode-Persistence

> ## ⛔ 已废弃 / DEPRECATED
>
> **V0.2.13 及更早版本（Build line 0.4.0）的整套设计已废弃**：hook 注入 + 内存 patch fetch + 本地反向代理 + 邮件上报，这一路线不再维护，也不要再安装它的 hook。
>
> **V0.2.13 及之前的版本均不再使用。请改用 `zcode-community-retry` 插件 V0.4.5 及之后的版本**
> （本仓库 [`projects/zcode-community-retry`](../zcode-community-retry/README.md)，基于 [`tangyixiao/zcode-community-retry`](https://github.com/tangyixiao/zcode-community-retry) 的 fork）。
>
> 新行为：任何失败（含 1113 余额不足、无权限等终止类错误）统一**最多重试 3 次**，之后停止，不再无限重试；由插件自己完成，不需要改写 ZCode 安装目录、不需要 hook、不需要本地代理。
>
> **V0.2.13 and earlier are deprecated.** The hook + in-memory patch + local proxy design is retired.
> Use the `zcode-community-retry` plugin **V0.4.5 or later** instead (every failure is retried at most
> three times, then it stops). Everything below is kept for history only.

- Version: V0.2.13 (2026-11-11) — 最后版本 / last release of this deprecated design
- Build line: 0.4.0
- Applies to: ZCode Desktop (Windows), Python 3.9+
- Dependencies: Python standard library only; proxy mode prefers certifi (if installed)
- Status: **DEPRECATED** — replaced by `zcode-community-retry` plugin V0.4.5+

## Version history

### V0.2.13: no slowdown, no proxy-only failures

Three field-measured defects are fixed; each made "direct works, proxy breaks" true.

- **Deterministic 4xx returns immediately.** A 400 used to be resent 20 times over 585 s.
  It is now passed through after one upstream hit. 408/425/429 and 5xx still retry.
- **Same latency as a direct connection.** `TCP_NODELAY` on both the client-facing and the
  upstream socket; loopback measurement: direct 41.9 ms vs proxy 52.4 ms to first content
  (repeated: 52.3 ms). `tools/selftest_speed.py` gates the proxy's extra overhead
  (proxied minus direct) at 40 ms for the first byte and 30 ms for the first content
  chunk, after discarding a warm-up round and asserting HTTP 200.
- **Repeated early incomplete tool calls retry inside the proxy** (default 3, 3 s apart)
  instead of resetting the client every time; anchor + RST remains the fallback once that
  budget is spent.
- Tool-call completeness validation now lives in `src/sse_tools.py` (pure functions).
  An `arguments` payload sent as a JSON object instead of a string is no longer a false
  incomplete call.

### V0.2.12: repeated early incomplete-tool recovery

When an upstream ends a stream with a buffered incomplete tool call before any
client-visible content, every `early_tool` outcome writes the zero-width anchor, waits
`PROXY_ANCHOR_SETTLE_MS`, and resets the client connection. This applies even without a
session id and after an earlier early-tool reset; ZCode's own bounded recovery budget
limits retries. This path does not use `PROXY_RETRY_ONCE_TTL`. Anchor-write failure is
logged and followed by best-effort transport reset. Complete tool calls and incomplete
calls after visible content retain their existing handling.

Validation: the 36-scenario streaming suite and full regression pass locally. The ten-round
long-window anchor check observed 9/10 anchors on its first run and 10/10 after a delayed
rerun, so delivery is timing-sensitive. The real ZCode UI recovery state was not exercised
end to end; client behavior remains an acceptance limitation.

### V0.2.10: longer retry window + one real client retry

`PROXY_RETRY_WINDOW` is 600 s (was 300) and `PROXY_SILENCE_TIMEOUT` is 60 s (was 30):
a stalled relay often recovers after 6–9 minutes, and a 30-second cutoff throws away
slow-but-healthy large requests.

When the window is exhausted *after* the 200 + heartbeats were already sent, the proxy
now writes one zero-width `content` delta and resets the client connection. The client
resumes a stream only when it has discarded text **and** sees `ECONNRESET`; with
heartbeats alone the discarded byte count is 0, so a bare RST never triggered a retry.
A settle delay (`PROXY_ANCHOR_SETTLE_MS`, default 300 ms) sits between the write and the
reset: `SO_LINGER=0` drops unread peer data, and an immediate reset lost the anchor in
11 of 43 measured runs.

For this long-window exhaustion branch only, a per-session one-shot token
(`PROXY_RETRY_ONCE_TTL`, default 900 s) limits the anchor + RST to one retry per session,
so the client's 10 retries cannot multiply with the proxy window. The token is released if
the anchor write fails. Early incomplete-tool recovery does not claim this token; it relies
on ZCode's bounded client recovery instead.

### V0.2.9: relay hosts moved out of the public tree

`UPSTREAMS` now contains placeholder hosts only. The proxy loads real relay hosts from
`upstreams.json` next to `retry_proxy.py`; the file is git-ignored and never included in
the public release asset. `src/upstreams.example.json` documents the format. `/p/<base64>`
routing is unchanged.

### V0.2.8: retry_after from the error body

The proxy now also reads the wait hint from the first 64 KB of a non-2xx error body
(`"retry_after":N` or `Retry-After: N`), takes the longer of header/body, and keeps the
60-second cap. The probe caps the socket timeout at 1 second and parses once at
EOF / 64 KB / budget, so a number split across chunks is not truncated. The body is never
logged. `selftest_proxy_429.py` now covers 12 scenarios, including split numbers and the
64 KB bound.

### V0.2.7: recover after content has been written

Two production failures are fixed by the same transport-level mechanism:

- **`tool_args_invalid`**: the upstream ended the stream halfway through tool-call
  arguments. V0.2.5 buffered tool deltas, but once text had been emitted it flushed the
  incomplete JSON; the client's `JSON.parse` failed and the turn died with
  `retryable=false`.
- **`upstream_error` after content**: the gateway returned an in-stream
  `{"error":{"message":"Upstream request failed"}}` after 67 characters. Passing it
  through gives a `ProviderBusinessError`, also `retryable=false`.

The proxy now validates every buffered tool call (name + JSON, rejecting
`NaN`/`Infinity`) and never writes a partial one. When content has already been sent and
the tool call is incomplete, or the upstream reports an error, it resets the client
connection (`SO_LINGER=0`, after closing `wfile`/`rfile`). The ZCode client sees
`ECONNRESET`, discards the partial output and retries with `previous-message-anchor`
(up to 10 attempts). See [03-Architecture](docs/03-architecture.md).

## Documentation

| Page | Contents |
|---|---|
| [00-Overview](docs/00-overview.md) | What this is, the difference between the two modes, quick start, boundaries and limitations |
| [01-Install and rollback](docs/01-install-and-rollback.md) | Installation, prefix selection, uninstallation |
| [02-Maintenance manual](docs/02-maintenance.md) | Parameters, logs, restarting the proxy, troubleshooting |
| [03-Architecture](docs/03-architecture.md) | Internal structure of the hook and the proxy |
| [04-Test record](docs/04-test-record.md) | Test cases and results of the self-test suites |
| [05-Changelog](docs/05-changelog.md) | Version history and fix records |
| [06-AI maintenance guide](docs/06-ai-maintenance-guide.md) | Code map, invariants, test recipes, fault localization |
| [07-AI handover invariants](docs/07-ai-invariants.md) | Quick reference of the hard constraints for taking over maintenance |

## Structure

```text
projects/zcode-persistence/
├─ README.md                Index: documentation and directory navigation
├─ AGENTS.md                Hard constraints for AI maintainers
├─ VERSION                  Version number
├─ CHANGELOG.md             Change log
├─ src/                     Runtime scripts (5 Python files) + upstreams.example.json
├─ tools/                   Install/uninstall/self-test/restart (11)
├─ docs/                    Current documentation (00-07)
└─ diagrams/                Current structure diagrams
```

## Quick start

```bash
python tools/install.py          # Mode A: hook + proxy auto-start
python tools/doctor.py           # Health check

# Mode B, recommended: route every provider through the proxy
python src/route_providers.py --dry-run
python src/route_providers.py
# Open a new ZCode session afterwards (SessionStart starts the proxy).
```

For prefix selection, parameters, uninstallation and rollback see
[01-Install and rollback](docs/01-install-and-rollback.md); for design trade-offs and
internal structure see [03-Architecture](docs/03-architecture.md).

The proxy ships with **placeholder** upstream hosts. Put real relay hosts in
`src/upstreams.json` (format: `src/upstreams.example.json`); the file is git-ignored and
is never included in the public release asset. `/p/<base64>` routing does not need it.

## Safety note

`src/error_watch.py` ships with **placeholder** addresses. Before enabling error
reporting, set `ZCODE_PERSISTENCE_MAIL_TO` (recipient) and
`ZCODE_PERSISTENCE_MAIL_FROM` (sender). When the recipient is a QQ address, the sender
must be an Outlook address; QQ discards forged senders. This repository contains no real
email addresses.

## Distribution

The distribution package lives in the repository Releases:
`proj-zcode-persistence-v0.2.12`.
The archive contains build artifacts; this directory is authoritative for the source, and
if the two disagree, this directory plus the tag wins.
