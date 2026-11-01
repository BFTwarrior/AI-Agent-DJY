# AGENTS.md — for the AI taking over maintenance

You are maintaining a ZCode "failure retry" toolkit. Read `README.md` first to learn what it is, then read `docs/06-ai-maintenance-guide.md` to learn how to change it.

## What this package is

Two main components plus one optional side path (off by default):
- `src/retry_hook.py`: ZCode's `PostToolUse` hook (`PostToolUseFailure` as fallback). It **only suggests** that the model retry the tool call; it never performs any retry itself.
- `src/retry_proxy.py`: a local HTTP proxy (127.0.0.1:8787) that **really does** resend model requests.
- `src/error_watch.py`: error reporting (optional, off by default). It polls `session.last_outcome` in the session store and, on `error` (the red dot in the UI), emails the reason to `your-email@example.com`; `completed`/`interrupted` are not reported.

## Invariants that must never be broken

0. The hook's primary mount point is **`PostToolUse`**, not `PostToolUseFailure` (the latter is not dispatched for timeouts/interruptions in this client); mount both and deduplicate by `toolCallId`.
1. The heartbeat must be an SSE **comment line** (starting with `:`). Turning it into a visible `data:` event pollutes the model's answer.
2. The heartbeat must be driven by an **independent clock** (`next_hb_at`), not hung off the boundary of "an attempt failed"; otherwise the first heartbeat arrives a full attempt cycle late and misses the client's 95-second window.
3. **Every code path** in `retry_hook.py` **must exit with code 0**. The hook must never be allowed to block a session.
4. Hook identification must use **exact equality on the script basename**, never substring matching (otherwise `my_retry_hook.py` gets misdetected or wrongly deleted).
5. `install.py` must **validate first and write to disk afterwards**: no config may be written and no file may be copied before any `die()`.
6. `uninstall.py` restores only when "current baseUrl == recorded proxyBaseUrl"; in every other case it only warns.
7. The proxy **must not log request/response bodies**, only status lines (time, path, status code, byte count, first-byte latency).
8. TLS must use certifi's CA bundle (the Windows built-in root store lacks SSL.com, so validation fails).
9. The UA fallback must not be removed: the relay's Cloudflare blocks `Python-urllib` (returns 1010).
10. The hook's stdout JSON **may only use `additionalContext`**. `systemMessage` is visible to the user only and invisible to the model — that is exactly where v0.3.0 came unstuck: the hook dutifully wrote `advise` to the log, yet the model still did not retry. The client parses with zod (non-strict), so unknown keys get stripped — but stripped means written for nothing, so still emit this one key only.
11. Backoff must not be "retry immediately". 85% of the failures actually observed are upstream **HTTP 429 (concurrency saturated)**, so you must wait for `RETRY_INTERVAL` (20 seconds); if the upstream hands you a longer `Retry-After`, obey it (capped by `RETRY_AFTER_CAP`=60 seconds). The total retry budget is measured by `RETRY_WINDOW` (180 seconds), not by attempt count.
12. **Do not add "filter by error type" back in**. The user's spec is "any error at all gets three retries": the hook suggests a retry on any failure, the proxy resends on any non-2xx. The FATAL filter from v0.3.x has been deleted; adding it back amounts to violating the requirement.
13. The heartbeat is "send **only after 80 seconds with no upstream input at all**, then one every 80 seconds, **with no cap on the number of times**". Do not change it to a fixed count, and do not change it to also fire when data is arriving. Before the response headers it is sent by the main loop's independent clock; after the response headers it is sent by `pipe_response`'s reader thread plus the main thread consuming the queue (send one when silence reaches `HEARTBEAT_INTERVAL`, and only call it truncated when silence reaches `RETRY_WINDOW`).
14. During the backoff wait the thread must `sleep`, not spin (v0.3.1 once pinned a single core at 97% during a 50-second backoff).
15. Writing the upstream response body back must use `resp.read1(n)`, **never `resp.read(n)`**. `read(n)` keeps waiting until it has n bytes, so SSE gets squashed into 8 KB chunks before it reaches the client, which looks like it is not streaming.
16. Reading during the response-body phase must happen in a **separate thread** (`pipe_response`'s `reader()` → `queue_`); the main thread only consumes the queue, sends heartbeats on time, and calls truncation when due. Do not use a socket timeout to detect silence: as soon as a timeout fires, http.client's buffered stream becomes unusable ("cannot read from timed out object"); and even if you reset the private flag and keep reading, chunked chunk-length lines are read by `readline`, so a timeout drops half a line and the next read is guaranteed to lose sync (`IncompleteRead`).
17. **Do not try to interrupt a blocked read by calling `close()`/`shutdown()` from another thread** (measured as ineffective on Windows, and `resp.close()` waits on `BufferedReader`'s lock, so the two deadlock on each other). When the deadline arrives, let the main thread wrap up and return; the reading thread exits as soon as it sees `stop` at `put`; if it is stuck in a blocking read, all you can do is wait for the socket timeout (`RETRY_WINDOW+30` seconds).
18. When the upstream replies `Connection: close`, `conn.sock` becomes `None` (http.client has already closed the connection object, and the fd is kept alive by makefile's reference count). To get at the socket you must go through `body_socket()`, which falls back to `resp.fp.raw._sock` when `conn.sock` is empty; when it cannot get one it writes a warning line to the log.

19. **Only 503 carries `retryable:true`; 400 must return `retryable:false`**. A 503 means the proxy has exhausted its retries and
    the client needs to continue on its own; a 400 means the client wrote the wrong prefix/request body, and flagging it retryable only gets it resent 10 times.
20. **`error_watch`'s `seen` advances only after the email has been sent successfully**. Being blocked by cooldown/rate limiting, a failed send, and
    `--once`/`--no-send` may all not advance it — otherwise that error is lost permanently (hit on 2026-10-31: after 8 emails went out in a row one was then silently dropped).
21. **Proxy log timestamps must carry the date** (`%Y-%m-%d %H:%M:%S`). Error reporting relies on it to line `gave up` up with the moment of the error;
    with hours and seconds only, crossing a day boundary writes the previous incident up as the cause of this one.
22. **`exitCode == 1` with completely empty stdout/stderr is not a failure**. It is the normal negative result of predicate commands
    such as `grep -q` with no match, `diff --quiet` with differences, or a false `test`; the client nevertheless marks the call
    `status="failed"`, so status alone is not enough. Any exit code other than 1, any output, a timeout, or cancellation still counts
    as a failure. The 2026-11-01 "pause once a minute" bug missed exactly this: three retry advices, and the third told the model to stop.

## Current final parameters (v0.4.0)

`RETRY_WINDOW=180` (seconds, the time window), `RETRY_INTERVAL=20` (seconds, fixed interval; `MAX_ATTEMPTS` is only a runaway fuse, default 200), `SILENCE_TIMEOUT=30`, `HEARTBEAT_START=80`, `HEARTBEAT_INTERVAL=80` (no cap on count), `PROXY_RETRY_WINDOW` / `PROXY_RETRY_INTERVAL` override the window and the interval, `RETRY_AFTER_CAP=60`, port 8787.

Changing these defaults amounts to changing the product spec; you **must** update `README.md`, `docs/02-maintenance.md`, `docs/04-test-record.md` and `CHANGELOG.md` in step.

## What you must do after making changes

1. Run the accelerated test in section 4 of `docs/06-ai-maintenance-guide.md` (all four assertions must pass).
2. Run `python -I tools/selftest_hook.py`, `tools/selftest_proxy_429.py`, `tools/selftest_stream.py`, `tools/selftest_watch.py`
   (11 hook cases + 5 retry scenarios + 15 streaming scenarios + 12 error-reporting assertions must all pass). If you changed `pipe_response` you must run the streaming suite;
   if you changed `error_watch.py` you must run the third suite.
3. Bump `VERSION` and the `VERSION` in `tools/install.py`.
4. Record "what changed + why" in `CHANGELOG.md`.
5. Repackage, **excluding** `__pycache__`, `*.pyc`, `*.log`.
6. Hand it to an independent subagent for review: it is only released when both the overall and the code score are ≥4.5/5; if either is lower, fix it and start over.

## Start here to continue development (for the next AI / engineer)

**Get the version numbers straight first**: what is published externally is the official release number (V0.2); the `0.4.0` in the code is the build-line iteration number,
and the two are not the same thing. Both the `VERSION` file and the `VERSION` in `tools/install.py` carry the official release number;
the mapping entry at the top of `CHANGELOG.md` tells you which build line the current official release corresponds to.

**Five-minute orientation**

1. Read the "What it is / Limitations" sections of `README.md`.
2. Read section 2 (code map) and section 3 (invariants) of this file (`docs/06-ai-maintenance-guide.md`).
3. Run a health check once: `python <install directory>/doctor.py`, which should show 11 passed, 0 failed.
4. Run a self-test once: `python tools/selftest_proxy_429.py`; all 5 scenarios should PASS.

**Three things you must know before changing code**

- The hook only "suggests" a retry; the proxy is what actually resends. The two do not depend on each other and can be installed separately.
- Hook output **may only use `additionalContext`**; written as `systemMessage` the model cannot see it (stumbled on in v0.3.0).
- **No filtering by error type.** Suggest a retry on any failure; the proxy resends on any non-2xx.

**Standard actions after a change**

1. `python -m py_compile src/*.py tools/*.py`
2. `python -I tools/selftest_proxy_429.py`
3. Run the heartbeat recipe in section 4 of `docs/06-ai-maintenance-guide` (four assertions)
4. `python tools/install.py --with-proxy --provider-id new-provider`
5. Restart the proxy (only needed if what you changed is `retry_proxy.py`): **do not hand-write taskkill** — use
   `<install directory>/restart_proxy_idle.py` (source in `tools/restart_proxy_idle.py`; the installer copies it into the install directory). It acts only when no request is in flight,
   and it starts the new process only after confirming the old process is gone or port 8787 has been released (the port is what counts) (Windows' SO_REUSEADDR lets two listeners coexist,
   so the health check gets answered by the old process: it looks like success while you are in fact running two copies). Add `--force` only when the quiet window never comes:
   it skips the waiting only, and not one of the checks above is dropped — the price is that in-flight requests get cut off once.
6. Confirm with `doctor.py` that the "proxy runtime parameters" item matches the scripts
7. Update `CHANGELOG.md`; for an official release, bump `VERSION` and the `VERSION` in `install.py`
8. Repackage and confirm the package / zip / installed copy all share the same sha256

**Common faults at a glance**

| Symptom | Look at this first |
|---|---|
| The model cannot connect at all | Whether 8787 is listening; the "proxy runtime parameters" item in `doctor.py` |
| `Turn execution failed` still pops up | The `reasons=` of `gave up` in `proxy.log` (status=429 storm / silence=upstream is down) |
| A retry was suggested but the model did not retry | Whether `hook.log` has `advise`; if it does the output field is wrong, if it does not the hook never fired |
| The hook does not fire at all | The matcher and script-path items in `doctor.py` |

## Do not

- Do not reintroduce "infinite retry" (tried in v1.1.0, rolled back).
- Do not make the heartbeat visible content.
- Do not substring-match hooks across events.
- Do not make network calls or do time-consuming work inside the hook (it gets killed at the 5-second timeout).
