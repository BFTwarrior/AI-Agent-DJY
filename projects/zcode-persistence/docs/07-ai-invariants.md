# 07 AI Invariants

> This document corresponds to `AGENTS.md` in the project root; if the two disagree, `AGENTS.md` wins.

You are maintaining a ZCode "retry on failure" toolkit. Read `README.md` first to learn what it is, then `docs/06-ai-maintenance-guide.md` to learn how to change it.

## What this package is

Three components (the third is off by default):
- `src/retry_hook.py`: a ZCode `PostToolUse` hook (`PostToolUseFailure` as fallback); it **only advises** the model to retry a tool call and performs no retry itself.
- `src/retry_proxy.py`: a local HTTP proxy (127.0.0.1:8787) that **really does** resend model requests.
- `src/error_watch.py`: polls the session DB's `session.last_outcome` and emails the cause when there is a red dot (`error`);
  it is not auto-started by default and needs `ZCODE_PERSISTENCE_WATCH=1`.

## Invariants that must never be broken

0. The hook's main mount point is **`PostToolUse`**, not `PostToolUseFailure` (the latter is not dispatched for this client's timeouts/interruptions); mount both and dedupe by `toolCallId`.
1. The heartbeat must be an SSE **comment line** (starting with `:`). Making it a visible `data:` event pollutes the model's answer.
2. The heartbeat must be driven by an **independent clock** (`next_hb_at`) and must never be hung on the "some attempt failed" boundary; otherwise the first heartbeat arrives a whole attempt cycle late and misses the client's 95-second window.
3. Every code path in `retry_hook.py` **must exit with code 0**. A hook must never block a session.
4. Hook identification must use the script **basename exactly equal**, never a substring (otherwise `my_retry_hook.py` would be misjudged/mis-deleted).
5. `install.py` must **validate before writing to disk**: no config written and no file copied before any `die()`.
6. `uninstall.py` restores only when "current baseUrl == recorded proxyBaseUrl"; in every other case it only warns.
7. The proxy **must not log request/response bodies**, only status lines (time, path, status code, byte count, time to first byte).
8. TLS must use certifi's CA (the Windows built-in root store lacks SSL.com and validation fails).
9. The UA fallback must not be deleted: the relay's Cloudflare blocks `Python-urllib` (returns 1010).
10. The hook's stdout JSON **may only use `additionalContext`**. `systemMessage` is visible only to the user and invisible to the model — that is exactly where v0.3.0 fell over: the hook clearly logged `advise`, yet the model still did not retry. The client parses with zod (non-strict), so unknown keys are stripped — but stripped equals written for nothing, so it still outputs only this one key.
11. Backoff must not be "retry immediately". In measured failures 85% are the upstream **HTTP 429 (concurrency saturated)**, so you must wait per `RETRY_INTERVAL` (20 seconds); if the upstream gives a longer `Retry-After` (response header or error body), obey it (capped at `RETRY_AFTER_CAP`=60 seconds). Total retry volume is governed by `RETRY_WINDOW` (600 seconds), not by a count.
12. **Do not reintroduce "filter by error type"**. The user spec is "retry three times on any error at all": the hook advises a retry on any failure, and the proxy resends on any non-2xx. The v0.3.x FATAL filter has been deleted; adding it back equals violating the requirement.
13. The heartbeat is "sent only after **80 seconds with no upstream input**, then one every 80 seconds, **with no cap on count**". Do not change it to a fixed count, and do not make it send when data arrives. Before the response headers it is sent by the main loop's independent clock; after the response headers it is sent by `pipe_response`'s reader thread plus the main thread consuming the queue (one line at `HEARTBEAT_INTERVAL` of silence; truncation is judged only at `RETRY_WINDOW` of silence).
14. During the backoff wait the thread must `sleep` and must not spin (v0.3.1 once saturated a single core at 97% during a 50-second backoff).
15. Writing the upstream response body back must use `resp.read1(n)`, **never `resp.read(n)`**. `read(n)` keeps waiting until n bytes are filled, so SSE is squeezed into 8KB blocks before reaching the client, which is exactly why it does not look streaming.
16. Reads in the response-body phase must happen in a **separate thread** (`pipe_response`'s `reader()` → `queue_`); the main thread only consumes the queue, sends heartbeats on time, and judges truncation at the deadline. Do not use socket timeouts to detect silence: once a timeout fires, http.client's buffered stream becomes unusable ("cannot read from timed out object"); even if you reset the private flag and keep reading, the chunked block length line is read by `readline`, so a timeout drops half a line and the next read is guaranteed to desync (`IncompleteRead`).
17. **Do not try to interrupt a blocking read with `close()`/`shutdown()` from another thread** (it does not work on Windows in practice, and `resp.close()` waits on the `BufferedReader` lock, deadlocking with the blocking read). When the deadline arrives, let the main thread finish and return; the reader thread exits when it sees `stop` at `put`; if it is stuck in a blocking read, all it can do is wait for the socket timeout (`RETRY_WINDOW+30` seconds).
18. When the upstream replies `Connection: close`, `conn.sock` becomes `None` (http.client has already closed the connection object; the fd is kept alive by makefile's reference count). To get a socket you must go through `body_socket()`, which falls back to `resp.fp.raw._sock` when `conn.sock` is empty; when it cannot get one it writes a warning line to the log.
19. **Only 503 carries `retryable:true`; 400 must return `retryable:false`**. 503 (the proxy exhausted its retries) must let the client continue writing by itself; 400 means the client wrote a wrong prefix/request body, and marking it retryable would resend it 10 times.
20. **`error_watch`'s `seen` advances only after the email is sent successfully**. Being blocked by cooldown/rate limiting, a failed send, `--once`/`--no-send` must never advance it, otherwise the error is lost forever (on 2026-10-31 it sent 8 emails in a row and then silently dropped one, for exactly this reason).
21. **Proxy log timestamps must include the date** (`%Y-%m-%d %H:%M:%S`). Error reporting uses it to align `gave up` with the error moment; with time-of-day only, cross-day alignment goes wrong.
22. **`exitCode == 1` with completely empty stdout/stderr is not a failure**. It is the normal negative result of predicate commands such as `grep -q` with no match, `diff --quiet` with differences, or a false `test`; the client nevertheless marks the call `status="failed"`, so status alone is not enough. Any exit code other than 1, any output, a timeout, or cancellation still counts as a failure. The 2026-11-01 "pause once a minute" bug missed exactly this: three retry advices, and the third told the model to stop.
23. **Tool-call deltas must be buffered and only written out at `finish_reason` or at the end** (V0.2.5; JSON validation from V0.2.7). A stream that ends mid-arguments with nothing written out must be discarded and re-requested; once a complete tool call has been written out, it must pass through (resending would run the tools twice). Reverting the buffer to direct streaming brings `tool_args_invalid` back.
24. **A read error may be retried internally only when nothing has been written out** (V0.2.6; V0.2.7 resets the client when content exists). The exception path must check SSE, `client_gone`, `text_out`, `tool_out` and `finish_out`; only when all are false may it mark early and re-request. If content was emitted but no complete tool call or finish reason was sent, reset the client (see 29). Content already sent must never be retried internally, and a client disconnect must never be treated as an upstream failure (log `client gone`, not `stream broken`).
25. **The `/p/<token>` token is base64url (padding stripped) of the original baseUrl** (V0.2.6). After decoding, validate that the scheme is http/https and the host is non-empty; build the path as `base_path.rstrip("/") + "/" + tail` without duplicating `/v1`; preserve both the base query and the request query; add a non-default port to the Host header (bracket IPv6 literals). An invalid token must return 400.
26. **Provider migration must be idempotent, sidecar-first and restorable** (V0.2.6). Compare proxy addresses with `urlsplit` host+port, not string prefixes; back up first; write the sidecar before the config; skip non-http(s), hostless, invalid-port and userinfo URLs.
27. **Automatic migration must verify capabilities, not just the name** (V0.2.6). Require `features` to contain `p_route` and require `root` to exist and equal `ensure_proxy.HERE` (fail-closed). An old proxy process left on 8787 does not understand `/p`; migrating would turn every model request into a 400. `uninstall.py` must keep restoring `/p` from the sidecar, including before `--purge`.
28. **Tool-call completeness must use the client's own standard** (V0.2.7). Every buffered call needs a non-empty `name`; the concatenated `arguments` must parse with `json.loads(..., parse_constant=reject)` (`JSON.parse` rejects `NaN`/`Infinity`). Keep the buffer as an arrival-ordered list, never group by `index` and `sorted()` it — reordering multi-index fragments makes the client concatenate invalid JSON, or a wrong command. `flush_tools()` must write zero bytes when validation fails.
29. **Content written + later truncation or upstream SSE error: reset the client** (V0.2.7). Triggers: invalid tool-argument JSON; or an upstream `{"error":...}` (e.g. `upstream_error`) after content. Do not re-request internally (duplicates content), do not forward an SSE business error (`ProviderBusinessError`, `retryable=false`). Use `SO_LINGER=0`, close `wfile`/`rfile`, then the socket, and set `handler.close_connection=True`; otherwise `handle()` spins on the closed `rfile` at 100% CPU. Never reset after a complete tool call or an emitted `finish_reason`.

## Current finalized parameters

`RETRY_WINDOW=600` (seconds, the time window), `RETRY_INTERVAL=20` (seconds, fixed interval; `MAX_ATTEMPTS` is only a runaway fuse, default 200), `SILENCE_TIMEOUT=60`, `HEARTBEAT_START=80`, `HEARTBEAT_INTERVAL=80` (no cap on count), `PROXY_RETRY_WINDOW` / `PROXY_RETRY_INTERVAL` override the window and the interval, `PROXY_RETRY_ONCE_TTL=900` (one anchor+RST client retry per session), `PROXY_ANCHOR_SETTLE_MS=300` (wait after the anchor write before the reset, otherwise the kernel drops it), `PROXY_RETRY_AFTER_CAP=60`, port 8787.

Changing these defaults equals changing the product spec; you **must** update `README.md`, `docs/02-maintenance.md`, `docs/04-test-record.md` and `CHANGELOG.md` in sync.

## What must be done after changes

1. Run the accelerated test in section 4 of `docs/06-ai-maintenance-guide.md` (all four assertions pass).
2. Run `python -I tools/selftest_hook.py`, `tools/selftest_proxy_429.py`, `tools/selftest_stream.py`, `tools/selftest_watch.py`, `tools/selftest_route.py`, `tools/selftest_upstreams.py` (11 / 12 / 34 / 12 / 13 / 8 all pass; run `tools/selftest_ensure.py` after changing `ensure_proxy.py`). If `pipe_response` changed you must run the streaming set; if `error_watch.py` changed you must run the fourth set.
3. Bump `VERSION`, `tools/install.py`, `src/retry_proxy.py` (`PROXY_VERSION`) and `src/error_watch.py` (`clientInfo.version`); all four must agree.
4. Record "what changed + why" in `CHANGELOG.md`.
5. Repackage, **excluding** `__pycache__`, `*.pyc`, `*.log`.
6. Hand it to an independent sub-agent for review: released only when the overall score is ≥4.5/5 and the code score is ≥4.0/5; if lower, fix it and start over.

## Continuing development starts here (for the next AI / engineer)

**First get the version numbers straight**: what you ship externally is the formal release number (`0.2.10`); `0.4.0` is the build-line iteration number,
and the two are not the same thing. `VERSION`, `tools/install.py`, `PROXY_VERSION` and `clientInfo.version` all carry the formal release number;
the project `README.md` records the current build line.

**Five-minute onboarding**

1. Read the "What it is / Limitations" sections of `README.md`.
2. Read `docs/06-ai-maintenance-guide.md`, section 2 code map and section 3 invariants.
3. Run a health check once: `python <install directory>/doctor.py`; it must show 0 failed (the item count depends on how many providers are configured).
4. Run the self-tests once: `python tools/selftest_proxy_429.py`; all 12 scenarios should PASS.

**Three things you must know before changing code**

- The hook only "advises" a retry; what actually resends is the proxy; the two do not depend on each other and can be installed separately.
- Hook output **may only use `additionalContext`**; if written as `systemMessage` the model cannot see it (hit in v0.3.0).
- **No filtering by error type**. Every failure is advised to retry; the proxy resends on any non-2xx.

**Standard actions after changes**

1. `python -m py_compile src/*.py tools/*.py`
2. `python -I tools/selftest_proxy_429.py`
3. Run the heartbeat recipe in section 4 of `docs/06-ai-maintenance-guide` (four assertions)
4. `python tools/install.py --with-proxy --provider-id new-provider`
5. Restart the proxy (needed only if `retry_proxy.py` changed): **do not hand-write taskkill** — use
   `<install directory>/restart_proxy_idle.py`. Windows `SO_REUSEADDR` allows the old and new processes to listen on 8787 at the same time,
   and the health probe would be answered by the old process, so it looks switched but is still running the old code. That script only acts in an idle window,
   and counts it a success only when the old process is gone or port 8787 is released (the port is authoritative), exactly one listener remains, and `root` points at the install directory.
   When it cannot get a quiet window (other sessions keep holding upstream connections), add `--force`: it skips only the wait, and not one check is dropped.
6. `doctor.py` confirms that "proxy runtime parameters" match the script
7. Update `CHANGELOG.md`; on a formal release bump all four version fields (`VERSION`, `install.py`, `PROXY_VERSION`, `clientInfo.version`)
8. Repackage and confirm that the package / zip / installed copy have identical sha256

**Common failure lookup**

| Symptom | Look at first |
|---|---|
| The model cannot connect at all | Whether 8787 is listening; "proxy runtime parameters" in `doctor.py` |
| Still pops up `Turn execution failed` | The `reasons=` of `gave up` in `proxy.log` (status=429 storm / silence=upstream is down) |
| Advice was given but the model did not retry | Whether `hook.log` has `advise`; if it does, the output field is wrong; if not, the hook did not trigger |
| The hook never triggers | The matcher and script path items in `doctor.py` |

## Things not to do

- Do not reintroduce "unlimited retries" (tried in v1.1.0, already reverted).
- Do not make the heartbeat visible content.
- Do not substring-match hooks across events.
- Do not make network calls or do time-consuming work in the hook (it is killed at 5 seconds).
