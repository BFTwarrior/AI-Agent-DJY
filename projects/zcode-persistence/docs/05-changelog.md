# 05 Changelog

> 2026-11-01: migrated to the AI-Agent-DJY repository; documentation was translated to English and directories standardized to `docs/` and `diagrams/`. Historical entries keep paths as originally written.

## V0.2.7 — 2026-11-03

Recover after content has been written. Buffered tool calls are validated as JSON
(names required, `NaN`/`Infinity` rejected) and never released partially. If content
was emitted and the tool call is incomplete, or the upstream sends an SSE
`{"error":...}` after content, the proxy resets the client connection (`SO_LINGER=0`,
closing `wfile`/`rfile`, `close_connection=True`); the client sees `ECONNRESET`,
discards the partial output and retries with `previous-message-anchor`. This fixes
recurring `tool_args_invalid` and `upstream_error` failures that previously ended the
turn with `retryable=false`. 32 streaming scenarios, the other suites, and a
Node/undici probe pass; independent review 4.7/5 overall, 4.4/5 code. See
`CHANGELOG.md` for details.

## V0.2.6 — 2026-11-03

Generic `/p/<base64url>` routing for any provider, automatic provider migration
on SessionStart (gated by the proxy's `p_route` feature and a matching `root`),
internal retry after a reasoning-only stream read error, sidecar-based
uninstall rollback, and a 300-second default retry window. 23 streaming
scenarios and 13 migration checks pass. See `CHANGELOG.md` for details.

## V0.2.5 — 2026-11-02

> Fixes a third silent-failure path: the upstream ends the stream **in the middle of
> a tool call's arguments** (no `finish_reason=tool_calls`). The client receives a
> dangling tool call, classifies it as `tool_args_invalid` with `retryable=false`,
> and the turn fails (6 occurrences on 2026-11-02). Tool-call deltas are now
> buffered inside the proxy and only written out when the call is complete; if the
> stream ends while nothing has been written out, the attempt is discarded and
> re-requested internally.

### Fix: a partial tool call was passed through as if it were content

**Symptom**: the pop-up says the tool arguments returned by the upstream are
incomplete; details show `provider_code=tool_args_invalid ... retryable=false`;
the client log has `lastChunkType=tool-input-delta`, `toolCallCount=0`.

**Root cause**: after the reasoning, the upstream starts streaming tool arguments
(`tool-input-start` plus deltas) and then ends the stream without finishing them.
The proxy treated "tool deltas seen" as "real output" and passed everything
through, but a dangling tool call cannot be executed by the client.

**Fix** (`src/retry_proxy.py`):
- tool-call deltas (grouped by `tool_calls[].index`, legacy `function_call` uses
  key -1) go into a `tool_buf` buffer and are **not** written out;
- the buffer is flushed, in index order, when a `finish_reason` (safe value) or
  real content arrives, or at the end of the stream;
- if the stream ends (`[DONE]`/EOF/error) while the buffer has not been written
  out and no text or complete tool call has been emitted, the attempt is marked
  `early` ("incomplete tool call ...") and re-requested;
- once a complete tool call has been written out, no more retries: resending
  would execute the same tools twice.

**Trade-off**: tool arguments no longer stream character by character; they
appear when the call finishes. Reasoning and text still pass through chunk by
chunk.

### Verification

- `selftest_stream.py` adds case 18 (partial tool call → internal retry, the
  client only receives the complete tool call, partial args never leak) and
  case 19 (complete tool call + `tool_calls` finish → passed through unchanged);
  19 scenarios pass. The other four suites pass.
- `VERSION`, `tools/install.py` and `src/error_watch.py` bumped to 0.2.5.

## V0.2.4 — 2026-11-02

> Fixes another silent-stop path: instead of a missing `finish_reason`, the upstream
> sends an SSE `{"error":{"code":"stream_truncated",...}}` event. The proxy used to
> forward it unchanged; the client classified it as `ProviderBusinessError` with
> `retryable=false` and failed the turn immediately. Now, as long as no text or tool
> call has been emitted, the proxy swallows the event and retries internally.

### Fix: upstream SSE error events were passed through

**Symptom**: the pop-up says the upstream output was interrupted; details show
`provider_code=stream_truncated ... retryable=false`; the client log has
`lastChunkType=reasoning-delta`, `textDeltaChars=0`, `toolCallCount=0`.

**Root cause**: after emitting only reasoning, the upstream sends
`data: {"error":...}` (code `stream_truncated`). `process_sse` only inspected
`finish_reason` and forwarded every non-`[DONE]` data line verbatim; the client
failed on the error event before the proxy's early retry could help.

**Fix** (`src/retry_proxy.py`):
- on a top-level `error`, if `saw_text` / `saw_tool` / `finish_seen` are all false,
  call `early_finish("upstream error: <code>")` and do not forward the line;
- reuse the V0.2.3 early path: discard the attempt and re-request into the same
  client response;
- if text or a tool call already exists, forward unchanged to avoid duplication.

### Verification

- `selftest_stream.py` adds case 16 (reasoning + error → internal retry succeeds)
  and case 17 (text + error → passed through, no retry); 17 scenarios pass.
- The other four suites pass.
- Production sample: the 18:55:53 `stream_truncated` request had only 188 reasoning
  deltas (751 chars), `text=0`, `tool=0`, so it was safe to retry.

## V0.2.3 — 2026-11-02

> Corrects the previous diagnosis: the upstream usually sends **no `finish_reason` at
> all**, and the client maps `undefined` to `other`. The proxy now checks the end of the
> stream (`[DONE]` and clean EOF), not just a literal `"other"` value, and **discards the
> failed attempt and re-requests the upstream internally**. Also fixes the race that let
> two proxies listen on 8787 after a reboot.

### Fix: a stream without `finish_reason` was treated as a normal completion

**Problem**: a turn ended after a while with no error and had to be continued by hand.
The client log (`model.sdk.stream.completed`) shows `finishReason=other`,
`textDeltaChars=0`, `toolCallCount=0`, and **no `rawFinishReason` field**.

**Root cause**: the client's `Bto()` maps a missing/null/unknown `finish_reason` to
`other`, then completes the turn (`turn.completed`). The previous release only intercepted
the literal `"other"`, which never matched in production: the 23:48:03 stream was logged
by the proxy as `ok bytes=1009`, with no `early finish other` line.

**Dead end (discarded)**: sending a mid-stream SSE error to the client. Two production
trials were classified as `ProviderBusinessError` with `retryable=false`, so the turn
still failed (one sub-agent was interrupted). A mid-stream error does not trigger the
client's auto-continuation.

**Final fix** (`src/retry_proxy.py`):
- Track `choices`, whether any `finish_reason` was seen, and whether text/tool calls were
  produced. At both stream endings (`[DONE]` and clean EOF): if choices were seen, no
  `finish_reason` arrived, and no text/tool call was produced, mark the attempt `early`.
- `pipe_response` returns `"early"`; `_handle` keeps the same client response and
  immediately re-requests the upstream, writing the new stream's reasoning/text into that
  same response. The client simply sees the stream continue.
- A literal `other` or any other unknown `finish_reason` is treated the same way when
  nothing was produced. `stop` / `length` / `content_filter` / `tool_calls` /
  `function_call` pass through.
- Streams that already produced text/tool calls always pass through: retrying would
  duplicate content the user has already seen.
- New log lines: `early finish ...` followed by `retry after early finish ...`.

### Fix: two proxies listening on 8787

- `ensure_proxy.py` now takes a Windows named mutex
  (`Local\ZcodePersistence-EnsureProxy`) around "check the port + spawn", so two
  SessionStart hooks cannot both spawn a proxy. This actually happened after the
  2026-11-01 reboot: PIDs <pid> and <pid> started in the same second.
- `doctor.py` counts LISTENING processes on 8787 and reports FAIL when there is more than
  one, instead of only checking that "something is listening".

**Verification**: `selftest_stream.py` has 15 scenarios (eight new, 8–15: missing
`finish_reason` with `[DONE]`, missing `finish_reason` at EOF, content + missing reason,
and transparent continuations for both the missing-reason and literal-`other` forms); `selftest_hook.py` has 10 cases plus the third-attempt wording (11 checks total);
`selftest_proxy_429.py` and `selftest_watch.py` still pass. The new
`selftest_ensure.py` proves two processes serialize on the mutex (2.45 s). Local install
runs a single proxy. Live traffic also confirmed it twice: the `early finish` events at
00:59:57 and 01:01:17 were re-requested internally, and the client completed at 01:00:29
and 01:01:28 with `attempt=1` (`finishReason=tool-calls`), with no `turn.failed`.

## V0.2.1 — 2026-11-01

> V0.2.1 is a patch release on top of V0.2: only the hook's false positive and stop wording changed; proxy and error-reporting behavior are unchanged.

### Hook no longer treats "no match" as a failure

**Problem**: a Bash call ending with `exitCode=1` and completely empty stdout/stderr — `grep -q` with no match, `diff --quiet` with differences, a false `test` — was treated as a failure. The client also marks such calls `status="failed"`, so the hook advised a retry three times. The third message told the model to stop and explain, and it did: the "test" session started at 21:22:58, received the 3/3 advice at 21:24:09, and finished at 21:24:14 (1m16s), matching the screenshot's "worked 1m17s / stopped".

**Fix**:
- `failure_of()` now treats `exitCode == 1`, not timed out, not cancelled, and empty stdout/stderr as **not a failure**. Any other exit code, any output, a timeout, or cancellation still counts as a failure.
- The third-attempt wording in both branches now says "report the result and continue with the other steps of the current task ... do not stop the whole task".
- New `tools/selftest_hook.py`: 10 boundary cases plus the third-attempt wording check (11 checks total), covering exit 1 with no output / stderr / stdout, exit 2, exit 0, timeout, cancellation, `status="failed"` with exit 1, `status="failed"` with exit 0, and upstream-no-output.

**Verification**: the 10 hook cases pass; `selftest_proxy_429`, `selftest_stream` and `selftest_watch` still pass; a live `grep -q` with no match produces no hook advice, while `ls` on a missing directory (exit 2) still does.

**Packaging**: `VERSION` and `install.py` are bumped to `0.2.1`; the V0.2 release asset is superseded and removed from GitHub.

## V0.2 Release — 2026-10-31

### Client auto-continuation (evening of 2026-10-31)

**Problem**: the user's popup showed `provider_code=upstream_unavailable … retryable=false`, the whole turn was forcibly ended, and the session list on the left showed a red dot. The old error code is not in the client's retryable set, so the three minutes of retries were wasted.

- `retry_proxy.py` gains `error_body()`: when giving up it returns
  `{type:"server_error", code:"model_server_error", reason:"server_error", retryable:true}`.
  Once the client's `z7a()` decision chain matches, it retries with stream recovery (up to 10 times) and uses `previous-message-anchor`
  to continue writing from where the previous output stopped, which is equivalent to automatically sending a "continue".
- New `invalid_body()`: **400 still returns `retryable:false`**. An unknown prefix or a malformed request body is the client's own mistake;
  marking it retryable would only get a deterministic failure resent 10 times (independent review P1-3).
- The health probe `/__zp_health` now includes `root` (the directory the script lives in), so after a process swap you can confirm which copy of the code is running.
- Proxy log timestamps changed from `HH:MM:SS` to `YYYY-MM-DD HH:MM:SS`, so the error report can align events by time.

### Error reporting (off by default)

New `src/error_watch.py`: polls `session.last_outcome` in `~/.zcode/cli/db/db.sqlite` and, on `error` (red dot), emails the cause to `your-email@example.com`; `completed` / `interrupted` are not reported.

- Only `gave up` records that line up within 15 minutes before or after the error time are accepted; if nothing lines up it says so honestly instead of inventing a cause.
- Sent through the outlook MCP (stdio JSON-RPC of ms-365-mcp-server); `From` must be fixed to
  `your-sender@example.com`, since sending under the account's own name gets dropped on the QQ side (verified in practice).
- Anti-flooding: `seen` advances only after a successful send; a 600-second cooldown per session; at most 8 mails per hour;
  a failed send backs off for 60 seconds and does not advance state; `--once` only prints and writes nothing to disk.
- **Not started by default**: `ensure_proxy.py` starts it only when `ZCODE_PERSISTENCE_WATCH=1`.
  On 2026-10-31, deduplication comparing timestamps alone caused 8 mails in a row for the same fault; it was disabled and turned into an explicit switch.

### Pre-release cleanup (review P1/P2, 2026-11-01)

- **Fixed `FAIL_RE` breaking on dated logs**: after the proxy log switched to `YYYY-MM-DD HH:MM:SS`, the regex was still anchored on
  `^(\d{2}:\d{2}:\d{2})`, so the "failure details" were always empty, and "the proxy is failing" was misjudged as
  "not caused by the proxy". The date is now optional, and the self-test was split into 7a (only success lines) / 7b (new format with failures but no give-up) / 7c (old format, same content).
- **Log throttling**: notices for cooldown/rate limiting/send failure/`--no-send` are throttled per session or session set (600 seconds by default),
  so 10 minutes of consecutive errors in one session leaves only 3 log lines (previously 121).
- **Fake liveness made visible**: `connect_db` now writes `db: …` even when it cannot open the database (the same message once every 10 minutes); a failed `new_errors`
  query returns `None` and **does not set the baseline**, so historical red dots are not flushed in bulk once the database recovers.
- **`--once`**: bypasses cooldown/rate limiting, only prints, writes nothing to disk (self-test item 10 was changed to run the full `main()`).
- **Process-swap verification**: `single_listener()` now fails when the health probe lacks `root` (an old proxy from before the upgrade).
- **Lifecycle completeness**: `uninstall.py --purge` terminates `error_watch.py` by command line (no longer filtered by process name);
  `doctor.py` gained an "error watching" item and checks via the command line whether the PID in the lock file really is the watcher process.
- **State file pruning**: when `seen` exceeds 200 entries, only sessions that still exist in the current database are kept, preventing unbounded growth.
- **Process-swap script shipped with the package**: `tools/restart_proxy_idle.py` is copied to the install directory by `install.py`,
  so the restart command in the docs no longer points at a private path outside the package.
- **Consistent counts in docs**: self-test counts unified at 5 / 7 / 12; the component description unified as "two main components + one optional bypass".

### Block-by-block code review (early hours of 2026-11-01)

Going file by file on the principle of "leave what works alone, fix only what is wrong" turned up and fixed two issues:

- **Hook false positive**: `retry_hook.failure_of()`, when it had neither `tool_response` nor any
  `error*` field, stitched metadata such as `tool_name`/`session_id` into "error text",
  so a successful Bash call was judged a failure and a retry was advised. That case is now never judged a failure;
  when `tool_response` is a non-dict string the decision is made from its content. New cases 24/25.
- **Uninstaller process kill unreliable**: `uninstall.py` used `taskkill`, and on 2026-10-31 it was observed returning 0
  without actually killing the proxy, so `--purge` deleted the directory while the process kept running. Now it uses ctypes `TerminateProcess` plus
  confirmation of the exit code, with `taskkill` only as a fallback; `kill_watcher()` was switched to the same path.

### Hot update (early hours of 2026-11-01)

- **`restart_proxy_idle.py` gains `--force`**: swap the process immediately when no idle window can be found. Observed on 2026-11-01:
  another session's team held 5-7 upstream `ESTABLISHED` connections continuously, `proxy.log` never went silent for even 1 second,
  so the idle window never arrived. `--force` skips only "wait for an idle window" (three checks: in-flight connections, log silence, `MIN_ALIVE`),
  while none of the other checks are dropped — verifying via `kill:` that the old process really is gone, that only one listener remains on 8787, and that `root` points at the install directory;
  the price is that in-flight requests are cut once. Before swapping, the target PID, in-flight connection count and silent seconds are written to `restart.log`.
- **First hot update landed**: old PID <pid> (code from before the rename; `/__zp_health` returned the lowercase name and no `root`)
  → new PID <pid>; the health probe returns `{"name":"Zcode-Persistence", "root":"C:\\Program Files (x86)\\AI\\Zcode-Persistence"}`,
  8787 has a single listener, and requests are handled immediately afterwards (`ok ... status=200`). **Option A's retryable 503 error body has been in effect since then.**
- **Fixes after independent review (same day)**: when `netstat` cannot be read it is no longer treated as "no listener" and falsely reported as success (now `abort` + exit code 1);
  when the kill fails but the port is already free, the port decides and spawning continues instead of falsely reporting "still occupied"; leftover cleanup now verifies each process individually and
  re-checks the port afterwards, stopping further spawning if anything is left (closing the double-listener window); the script's own abnormal exit code changed to 2 (distinct from the 0/1 success/failure codes);
  the module docstring now documents `--force` and the exit codes. All of the branches above were verified one by one with read-only tests using injected stubs.

### Tests

- `tools/selftest_watch.py` (new): 12 assertions (7 split into 7a/7b/7c), covering the baseline, deduplication, cooldown, rate limiting, retry after a failed send,
  `--once` not writing to disk, merging multiple sessions, and the wording used when there is no cause.
- `tools/selftest_proxy_429.py`: new scenario 5 (unknown prefix 400 → `retryable:false`).
- `tools/selftest_stream.py`: new scenario 7 (giving up in heartbeat mode; the SSE error body must carry
  `retryable:true` / `model_server_error` and the terminating chunk must be appended).

### Streaming write-back fix (2026-10-31, independent review P1)

Hands-on testing during the review turned up three real problems, all in `pipe_response`:

- **SSE batched up to 8KB**: `resp.read(8192)` waits until 8KB has accumulated or the stream ends, so a single SSE event of a few dozen bytes
  was held back until 8KB and only then sent to the client, which looked like "not streaming". Changed to `resp.read1(8192)`.
- **Truncation after 30 seconds of mid-stream silence**: after the response headers the socket timeout still applied `SILENCE_TIMEOUT`,
  while "send a heartbeat only after 80 seconds without input" covered only the period before the response headers. Worse, once the buffered stream in `http.client` times out
  it becomes unusable (`cannot read from timed out object`), so reading cannot resume after the timeout.
  Changed to a **reader thread + main thread consuming a queue**: the reader thread only does blocking reads, the main thread polls the queue every 0.5 seconds,
  sends a `: keepalive` once silence reaches `HEARTBEAT_INTERVAL` (80 seconds), and only wraps up and reports truncation once cumulative silence reaches `RETRY_WINDOW`
  (180 seconds), so content already received is not lost.
  (Two other approaches were tried along the way — "a watchdog thread closing the connection to interrupt the blocking read" and "resetting a flag after the timeout to resume reading" — and neither works in practice:
  on Windows shutdown/close does not wake a blocking read, and resuming after a reset makes the chunked readline lose half a line.)
- **Short reads on fixed-length responses treated as success**: when the upstream declared `Content-Length: 100` but sent only 20 bytes, `read1` raised
  nothing, the old code appended `0\r\n\r\n` and logged `ok`, and the client took the truncated JSON as a complete response. Now
  `resp.length` is used to determine the remaining bytes; a short read wraps up as `truncated` without appending the terminating chunk.
- Supporting changes: `body_socket()` solves the case where the upstream answers `Connection: close` so `conn.sock` is `None` and the socket actually in use cannot be reached;
  `_safe_handle()` + `Server.handle_error()` reduce "the user cancels mid-generation" to a single log line instead of dumping a full traceback into `proxy.log`.
- New `tools/selftest_stream.py` (six scenarios: event-by-event pass-through / keep-alive during mid-stream silence / short read on fixed length judged truncated /
  normal wrap-up / silence up to the window judged truncated / slow client without data loss and with a normal wrap-up); any change to `pipe_response` must run it.

### Code cleanup (2026-10-31, review after V0.2 was released)

- **Fixed the zero-sleep spin when the window expires**: if the process is suspended during backoff (sleep/debugger), it can wake up past
  the window, at which point the start condition is false and the failure branch is never reached, so the main loop spins. A check "if the window has expired and no attempt is in flight, wrap up"
  was added at the top of the main loop, and it was reproduced and verified with a 2-second window + 5-second interval (it returns 503 after 2 seconds).
- The start line and backoff lines now use `%gs`, so fractional intervals (0.2 in the tests) print faithfully, matching the default-value comparison in
  `doctor.py`.
- Docs and comments aligned with the time-window semantics: the `src/retry_proxy.py` module description, invariant 11 in `AGENTS.md`,
  the mode B diagram in `README.md`, and `docs/02` `docs/03` `docs/04` `docs/05` all dropped stale wording
  such as "4 attempts / RETRY_DELAYS / backoff table".
- The `load_json` docstrings in `install.py`/`uninstall.py` now state honestly that it "raises exceptions";
  all ports in `uninstall.py` are now derived from `PROXY_HOST`; `doctor.py` lost a duplicate `import re`
  and had its `resolve_prefix` description corrected; `selftest_proxy_429.py` dropped two unused port constants and
  its module description now says four scenarios.

### Switching to time-window retries (2026-10-31, V0.2 trial run)

- User requirement: **do not retry by count; keep retrying for 3 minutes, once every 20 seconds**.
- `MAX_ATTEMPTS` no longer decides when to give up; that is now controlled by `PROXY_RETRY_WINDOW=180` (seconds);
  the interval is fixed at `PROXY_RETRY_INTERVAL=20` (seconds). `MAX_ATTEMPTS` is demoted to a runaway-prevention fuse (default 200).
- Measured (accelerated parameters: 1-second window / 0.2-second interval): all 4 self-test scenarios PASS; on persistent failure it gives up only when the window ends.
- The give-up message is now "retried continuously for N seconds and still failing (M attempts in total: ...)".
- Caveat: streaming requests are kept alive for the full 3 minutes by the 80-second heartbeat; heartbeat cannot be inserted into non-streaming requests, so the client may time out first.

### Slow-retry tuning (2026-10-31, V0.2 trial run)

- Field report: the upstream was cut off **during the TLS handshake** (`SSLEOFError: UNEXPECTED_EOF_WHILE_READING`),
  and 4 consecutive attempts all failed in `connect`; the user saw "already retried 3 times automatically and still failing (other,connect,connect,connect)".
- Fix: the retry interval changed from 5/15/30 seconds to **a fixed 10 seconds each time** (`PROXY_RETRY_DELAYS=10,10,10`),
  giving 4 attempts a total window of about 30 seconds plus the handshake time of each attempt, leaving the upstream time to recover.
- Note: this only changes the retry rhythm and cannot fix an upstream fault; if all 4 attempts fail it still reports an error, as expected.


The first public release, containing:

- Automatic retry 3 times on any error (hook advice + proxy resend, proxy backing off 5/15/30 seconds)
- A heartbeat (`: keepalive`) after 80 consecutive seconds without upstream input, then one every 80 seconds, unlimited
- The hook outputs `additionalContext` (visible to the model); logs never contain the error body
- The full install/uninstall/self-test/health-check set: `install.py`, `uninstall.py`, `doctor.py`, `selftest_proxy_429.py`


## 0.4.0 — 2026-10-30 (spec alignment: retry three times on any error; 80-second heartbeat)

Two hard specs were reissued by the user, and this version implements them literally:

### 1. Automatically retry three times on any error

- **Hook**: the FATAL filter was deleted (older versions treated `permission denied`, `not found`, `syntax error` and the like as "deterministic errors" and gave up immediately). Now any failed Bash call gets a retry recommendation, still capped at 3 times (after the 4th failure no further recommendation is made, and the model is asked to explain the blocker to you). For the no-output-from-upstream category it still advises waiting 3 minutes before sending again, because an immediate resend almost always fails too.
- **Proxy**: the retry condition changed from the fixed allowlist `{408,425,429,500,502,503,504}` to **any non-2xx**. The cost is explicit: errors such as `400/401/404` where a resend is useless also wait 5+15+30 seconds before the original error is reported to you. This is knowingly accepted under the "retry every error" spec.

### 2. Heartbeat changed to 80 seconds with no cap on count

- `HEARTBEAT_START` and `HEARTBEAT_INTERVAL` are both **80 seconds**: the first `: keepalive` is sent only after 80 consecutive seconds with no upstream input, then one every 80 seconds, **with no cap**.
- 80 seconds rather than 90 leaves a 15-second margin under the client's 95-second first-byte timeout.

### 3. Must-fix items found in review (all from the independent subagent's v0.3.1 review report)

- **P0 busy-wait fixed**: during backoff waits the `q is None` branch of the main loop did not sleep, and a 50-second backoff was measured eating 97% of one core. It now sleeps until whichever comes first, the next attempt or the next heartbeat (a 2-second backoff was measured consuming only 0.25 seconds of CPU).
- **P1 crash on an empty backoff table fixed**: `PROXY_RETRY_DELAYS=""` made `RETRY_DELAYS` an empty list, so `[-1]` raised IndexError directly and the connection got no response. A parse failure or an empty table now falls back to `5,15,30`.
- **P1 doc alignment**: the default-value table in `docs/02` (3 attempts, 90 seconds, the removed `PROXY_RETRY_DELAY`/`PROXY_MAX_BACKOFF`), the English assertion in `docs/05` that can never hold, and the 502/3-times entries in the `docs/04` results column were all rewritten for 0.4.0; a second review round then found that the "will not advise a retry" list in the README, the FATAL flowchart in docs/03 and the regression sample table in docs/02 still described the old model, and those were fixed in this version too.
- **P2**: `Retry-After` now supports the HTTP-date form; `server`/`date` were added to `HOP_BY_HOP` to avoid duplicate response headers; hook output switched to `ensure_ascii=True` to work around the GBK code page of Windows pipes.
- **Tests**: `tools/selftest_proxy_429.py` grew to 4 scenarios (429 recovers / persistent 429 / 400 recovers / persistent 400), with the port chosen automatically. The recovery scenarios assert a 200 after the 3rd/4th hit, and the persistent-failure scenarios assert a 503 error body after 4 attempts.

### 4. Last round before release (final acceptance feedback)

- **Trailer overflow no longer pollutes the connection**: after the chunked 0 chunk at most 100 trailer lines are read, and anything beyond that is returned as a 400 malformed request (previously the extra bytes were taken by keep-alive as the next request, which was observed reporting `Bad HTTP/0.9 request type`).
- **Port occupation becomes identifiable**: the proxy gained a `GET /__zp_health` probe; when the port is already taken, `ensure_proxy.py` first probes the identity and, if it is not this proxy, logs a warning in `proxy.log`, so "another process holds 8787 and the provider talks to the wrong service" no longer leaves no trace.
- **Hook logs no longer contain error bodies**: `hook.log` records only the count and kind (`advise: 1/3 kind=error`), not the first error line; exception branches record only the exception type, never the raw input.
- **Reinstalling rewrites old hooks**: `ensure_hook()` in `install.py` compares `command`/`args`/`matcher`/`timeoutMs`/`statusMessage` for an existing hook of the same script and corrects it in place; reinstalling with a different `--prefix` no longer leaves a hook pointing at the old directory.
- **Stricter doctor checks**: the two tool hooks are checked for `matcher == "Bash"` in addition to the basename, all three hooks are checked for the existence of the script path, and `hooks.enabled` is now displayed; the "proxy runtime parameters" check compares four items: `attempts`/`silence`/`heartbeat>=`/`every`.
- **Bounds on environment variables**: "finite but invalid" values such as `PROXY_PORT=65536` and `MAX_ATTEMPTS=1e308` now fall back to the defaults too.


## 0.3.1 — 2026-10-30 (it really retries now: two "fake fixes" resolved together)

**0.3.0 had two pitfalls; the field evidence is below and both are fixed.**

### Pitfall 1: the hook output a field the model cannot see

- Field: a new session ran a test command; `hook.log` clearly recorded `advise: 1/3 (timed out) kind=transient`, yet the model replied "the command was already executed as-is, no retry".
- Cause: it output `{"systemMessage": ...}`. That field is only visible to the user and is **not injected into the model context**, so the model never receives it.
- Fix: changed to `{"additionalContext": ...}` (the ZCode hook documentation states explicitly that this field is injected into the session). The JSON schema is strict, so only this one key is output.

### Pitfall 2: upstream 429s burned by "retrying immediately"

- Field statistics (`proxy.log`, 1771 successful requests): 994 failed attempts, of which **849 were HTTP 429**; of the 230 `gave up` events, **201 were `status,status,status`**, i.e. all three attempts hit 429. That is exactly where the `Turn execution failed ... retryable=false` popup the user saw came from: the proxy gave up, and the client in turn declared it non-retryable.
- Cause: the old logic also "retried immediately with a 10-second backoff cap" on 429, whereas a 429 really means upstream concurrency is maxed out and waiting is required.
- Fix:
  - `MAX_ATTEMPTS` 3 → **4** (first attempt + 3 retries), matching "automatically retry three times on any error".
  - New `RETRY_DELAYS=5,15,30` progressive backoff; if the upstream supplies `Retry-After`, the larger value is taken (capped by `RETRY_AFTER_CAP=60`).
  - `HEARTBEAT_START` 90 → **60** (seconds): the SSE heartbeat is attached during backoff so the client does not time out while waiting.
  - Giving up now returns **503 + an OpenAI-shaped error body** (`type=server_error`) instead of a plain-text 502.
    (At the time it was `code=upstream_unavailable`; since 2026-10-31 it is `model_server_error` + `retryable:true`,
    see the "Client auto-continuation" entry above.)

### Other

- New `tools/selftest_proxy_429.py`: a local-loopback self-test of the 429 retry chain, two scenarios (recovers after two 429s / persistent 429) with fully automatic assertions; no real relay needed.
- `AGENTS.md` gained invariants 10 and 11 (the field must be `additionalContext` only; backoff must not retry immediately).
- Docs: this round only synced the numbers in `README.md` and the assertion wording in `docs/05`; `docs/02`, `docs/03` and `docs/04` still retained the old error-type-filtering model, which was fully fixed in 0.4.0 (see below).

## 0.3.0 — 2026-10-30 (the hook actually fires now)

**This is a substantive fix. Up to and including 0.2.0, the hook never fired once in real use.**

- Measured: this client **does not dispatch** `PostToolUseFailure` for Bash calls that are "interrupted / timed out"; a non-zero command exit does not count as a tool failure either. So hooking only `PostToolUseFailure` meant it never took effect.
- Changed to hook `PostToolUse` as the primary (`matcher=Bash`), judging failure from `exitCode` / `timedOut` / `status` / `stderr` in `toolResponse`; `PostToolUseFailure` is kept as the fallback for when the tool throws.
- Added deduplication by `toolCallId` (120-second window), so that the two events firing at the same time do not produce the advice twice.
- Error text now comes only from `stderr` + `stdout` (the whole payload is no longer scanned), eliminating metadata false positives at the root.
- `doctor.py` checks both the primary and the fallback mount points.

## 0.2.0 — 2026-10-30 (project renamed to Zcode-Persistence)

**Rename-only version; the code logic is identical to 0.1.2, only identifiers and paths changed.**

- Project directory: `zcode-retry-hook` → `Zcode-Persistence`
- Package directory / ZIP: `zcode-retry-hook-v0.1.2` → `Zcode-Persistence-v0.2.0`
- Install directory: `C:\Program Files (x86)\AI\zcode-retry-hook` → `...\AI\Zcode-Persistence`
- Hook state and log directory: `%TEMP%\zcode-retry-hook` → `%TEMP%\Zcode-Persistence`
- All docs, script defaults and AGENTS.md updated in sync
- Upgrade path: run the old package's `uninstall.py` first, then the new package's `install.py`, and finally delete the old install directory

## 0.1.2 — 2026-10-30

- Corrected the time estimate in `docs/06-ai-maintenance-guide.md`: the accelerated recipe's three attempts measured 9.7 seconds (it previously said "about 11 seconds"), and the calculation is now written out.
- No code changes; runtime behavior is identical to 0.1.1.

## 0.1.1 — 2026-10-30

Maintenance fixes only; behavior matches 0.1 with unchanged parameters.

- `src/retry_proxy.py`: corrected an outdated comment (the heartbeat had long been an independent clock with a 90-second interval, yet the comment still said "sent on every failure, with no cap"); logs now strip query strings uniformly, so secrets that the upstream puts into URL parameters are not written to disk.
- `tools/doctor.py`: hook detection now matches exactly on the script basename, consistent with install/uninstall (the previous substring match misjudged `my_retry_hook.py` as already installed).
- `tools/install.py`: the exception path that died only after writing was changed to warn without making changes, removing a structural hazard.
- Docs: added `AGENTS.md` and `docs/06-ai-maintenance-guide.md`; rewrote the test recipe (four assertions that can be judged automatically); corrected symbol names in `docs/02` that do not exist and the accelerated parameters in `docs/04`.

## 0.1 — 2026-10-30 (first release)

Final parameters:

- **Retry**: at most 3 attempts (including the first, i.e. 2 retries after a failure), the same for streaming and non-streaming.
- **Heartbeat**: for streaming requests, the first `: keepalive` is sent after 90 seconds without data, then one every 90 seconds.
- **Backoff**: starts at 1 second and doubles, capped at 10 seconds.
- The heartbeat is driven by an independent clock and does not wait for an attempt to fail.
- All timings can be overridden with `PROXY_*` environment variables (`MAX_ATTEMPTS` minimum is 1).

Documentation completed: added `AGENTS.md` (hard-constraint quick reference) and `docs/06-ai-maintenance-guide.md` (code map, invariants, test recipe, fault localization, regression checklist) so any AI can take over maintenance.

The version number was set to 0.1 at the user's request. The 1.0.x / 1.1.0 iterations during development are internal, their installer packages have been deleted, and they are not kept externally.
