# 06 AI Maintenance Guide

The audience for this document is an AI or engineer with **absolutely no context**. After reading it you should be able to: judge the current state, change things safely, verify changes, package and release, and locate the problem when something goes wrong.

---

## 1. Thirty-second orientation

| Question | Answer |
|---|---|
| What is this | A two-piece "automatic retry on failure" kit for ZCode plus one optional bypass: hook + local proxy + error reporting (off by default) |
| Version | See `VERSION` (`0.2.8` on main; latest published release `0.2.7`; the build line is `0.4.0`, and the project `README.md` records the current build line) |
| Where is the code | Five Python files in `src/` (hook / proxy / auto-start / route migration / error reporting), no third-party dependencies (certifi optional) |
| Where it is installed | `C:\Program Files (x86)\AI\Zcode-Persistence\` |
| Which system config is modified | `~/.zcode/cli/config.json` (hook), `~/.zcode/v2/provider_config.json` (the provider's baseUrl) |
| How to confirm the state | `python <install directory>\doctor.py` (script, interpreter, hooks.enabled, the three hooks, provider, port, proxy version (running vs installed), proxy runtime parameters, whether error watching is installed / on or off / PID-locked, log tail; the two tool hooks also validate matcher=Bash) |
| How to roll back | `python tools/uninstall.py`, or use the `.bak-*` backups in the same directory |

The two main components are **independent of each other** (hook / proxy); you may install only one or both.
The third component `error_watch.py` (error reporting) depends on the proxy log to determine the cause, and is off by default.

---

## 2. Code map

### `src/retry_hook.py` (about 360 lines)

A ZCode hook, mounted primarily on `PostToolUse`, with `PostToolUseFailure` as the fallback, `matcher="Bash"`.

```
main()
 ├─ read stdin JSON
 ├─ tool_name != "Bash" → exit 0
 ├─ failure detected (exit code ≠ 0 / timeout / cancelled / status=failed|error)
 ├─ no failure → exit 0
 ├─ same toolCallId already advised within 120s → exit 0
 ├─ count already 3 → exit 0
 ├─ UPSTREAM_PATTERNS match → advise "wait 3 minutes, then retry"
 └─ any other failure → advise "retry the same command immediately"
```

Since v0.4.0 only a single pattern list remains, `UPSTREAM_PATTERNS` (a hit means: advise waiting 3 minutes before sending again); **whether to retry is not decided by the pattern** — every failure is advised to retry, up to 3 times (single exception: exit 1 with completely empty output). Counter state lives in `%TEMP%\Zcode-Persistence\state.json`, keyed by `sha1(session|command)`.

### `src/retry_proxy.py` (about 1,280 lines)

Local HTTP proxy. A request comes in → resolve the upstream from a fixed prefix or `/p/<b64>` → forward → resend on failure.

```
Handler._safe_handle()          ← client disconnects are collapsed into one log line here
 └─ Handler._handle()
     ├─ parse /ap, /cm, /cg, or /p/<b64> → (host, port, scheme)
     ├─ read the full body (chunked-aware)
     ├─ UA fallback (python-urllib → browser UA)
     ├─ inspect body.stream to decide streaming vs non-streaming
     └─ main loop (while True)
         ├─ window expired and no attempt in flight → finish
         ├─ time to try → start one attempt (fetch_once in a subthread, main thread polls)
         ├─ result received: ok → pipe_response; failure → record the reason
         ├─ window expired or attempt >= MAX_ATTEMPTS (fuse 200) → finish
         ├─ heartbeat check (independent clock next_hb_at)
         └─ before each retry, wait RETRY_INTERVAL (20s; honor a larger Retry-After) and loop

pipe_response()                 ← response headers already sent; no more retries
 ├─ read1(8192), write back chunk by chunk (never batch)
 ├─ streaming: process_sse() parses lines (bytes pass through unchanged), tracks content/tool_calls;
 │   unknown/other finish_reason with neither present → return "early" to _handle;
 │   [DONE] or clean EOF with no finish_reason at all → the same "early" signal
 ├─ streaming: start a reader thread that only does blocking reads → queue_; the main thread checks the queue every 0.5s
 │   ├─ silence reaches HEARTBEAT_INTERVAL → write `: keepalive`
 │   └─ silence reaches RETRY_WINDOW      → finish and mark truncated (do not wait for the reader; it exits on stop at put)
 └─ finish: complete → add `0\r\n\r\n`; short read/exception → do not add, log truncated
```

`fetch_once()` returns `Attempt(reason=...)`, and reason has five values: `ok` / `connect` / `silence` / `status` / `other`. **reason decides the subsequent behavior**: only `silence` triggers the "waited too long" semantics.

### `src/error_watch.py` (about 700 lines)

Error reporting: polls `session.last_outcome` in `~/.zcode/cli/db/db.sqlite`; when the value is `error`
(the UI red dot) it emails the cause to `ZCODE_PERSISTENCE_MAIL_TO` (sender: `ZCODE_PERSISTENCE_MAIL_FROM`). It is not auto-started by default; only SessionStart starts it when `ZCODE_PERSISTENCE_WATCH=1`.

- State machine (the easiest place to introduce a bug): `seen` advances to that session's `time_updated` only after a **successful send**;
  cooldown / rate limiting / send failure / `--no-send` all **do not advance** it, and the error stays in pending for the next round.
- `sent_at`: per-session cooldown (`SESSION_GAP=600`), preventing dozens of emails for a single failure.
- `sent`: send timestamps within the last hour, used for the `MAX_PER_HOUR=8` rate limit.
- `retry_after`: backoff after a failed send (`MAIL_RETRY_GAP=60`).
- `logged`: log throttling marker; cooldown / rate-limit / send-failure notices default to one line per 600 seconds (per session or session set), avoiding a screen flood from the 5-second poll.
- `baseline`: on first start only red dots within `FRESH=180` seconds count as "just happened"; earlier ones only record a baseline; a failed query does not set the baseline.
- Cause parsing relies on the **date-bearing** timestamps in `proxy.log` (`LOG_TS_RE`), and only accepts `gave up` / `attempt fail` within
  `CAUSE_WINDOW=900` seconds before or after the error moment; the old format (time-of-day only) is still supported, but logs older than one day may be computed wrongly.

### `src/ensure_proxy.py` (about 270 lines)

`SessionStart` hook. If the port is already listening → exit 0; otherwise launch the proxy with `DETACHED_PROCESS`. Any exception is swallowed, so session startup is never slowed down.

### `tools/`

- `install.py`: validate first (config exists, source files exist, provider exists, prefix can be determined) → then write to disk (copy scripts, write hooks, modify provider) → finally write `install-state.json`. A config parse failure exits before anything is written to disk.
- `route_providers.py` (in `src/`): rewrite every provider's baseUrl to `/p/<base64url>`; idempotent, backs up first, records original URLs in a sidecar, `--restore`. SessionStart calls it only after the proxy reports the `p_route` feature and a matching `root`.
- `uninstall.py`: delete hooks by exact basename; the provider is restored only when "current value == the recorded proxyBaseUrl"; `/p` migrations are restored from `provider_config.json.proxy-origins.json`, including before `--purge`; `--purge` verifies the process command line before killing, and only accepts prefix records whose directory really contains this tool's files.
- `doctor.py`: script, interpreter, `hooks.enabled`, the three hooks (the two tool hooks validate matcher=Bash, all three validate the script path), provider, port, proxy version (running vs installed), proxy runtime parameters, error-watch status, log tail. The log tail reads only the last 64KB; finding the "start line" walks back from the end of the file in 64KB blocks, up to 8MB.
- `selftest_hook.py`: 11 hook checks (10 decision cases + third-attempt wording; including exit 1 with no output, timeouts and cancelled calls).
- `selftest_proxy_429.py`: twelve retry-semantics scenarios (429 recovers / persistent 429 / 400 recovers / persistent 400 / unknown prefix 400 must be `retryable:false` / body-supplied `retry_after` / cap / text form / split number / 64 KB bound / empty body / stall budget).
- `selftest_stream.py`: 32 streaming scenarios (including missing-finish-reason, upstream-error, partial-tool-call, RST-after-content, multi-index ordering, CPU after reset, `NaN` and legacy `function_call` cases).
- `selftest_watch.py`: 12 assertions for error reporting (new red dot / dedupe / historical baseline / completed and stopped are not reported / rate limit / multiple sessions merged / wording when there are no relevant records / failure but not given up · new format / same · old format / cooldown and expiry / send failure retry / `--once` writes nothing to disk).
- `selftest_route.py`: 13 `/p` routing and provider-migration checks.
- `selftest_ensure.py`: cross-process serialization of the proxy-start lock.
- `restart_proxy_idle.py`: restart only in an idle window; `--force` skips the wait but not the safety checks.

---

## 3. Invariants (read before changing anything)

These were hardened after real incidents; breaking any one of them causes a known failure:

| # | Invariant | Symptom after breaking it |
|---|---|---|
| 0 | Hook mounted on `PostToolUse` + `PostToolUseFailure`, deduped by `toolCallId` | Mounting only Failure → never triggers (this client does not dispatch timeouts/interruptions) |
| 1 | Heartbeat is the SSE comment line `: keepalive` | Changing it to `data:` makes it be treated as something the model said, polluting the answer and staying in context for a long time |
| 2 | Heartbeat is driven by an independent clock, and is **sent only after 80 consecutive seconds without upstream input, with no limit on count** | Hanging it on attempt boundaries makes it one cycle late; changing it to a fixed count breaks the stream during long waits |
| 3 | All hook paths exit with code 0 | Returning 2 or raising blocks the session |
| 4 | Hook matching uses exact basename equality | Substring matching would misjudge `my_retry_hook.py` as installed/removed |
| 5 | install validates before writing to disk | A mid-way `die()` leaves a half-finished state: hook installed, state not written |
| 6 | uninstall restores only under exact conditions | Loosening it would overwrite an address the user changed by hand |
| 7 | Request/response bodies are never logged | Leaks conversation content and keys |
| 8 | TLS uses certifi | The Windows root store lacks SSL.com and the proxy cannot connect at all |
| 9 | UA fallback | Relay Cloudflare blocks `Python-urllib` and returns 1010 |
| 10 | Hook output may only use `additionalContext` | With `systemMessage` the model cannot see it, which equals no advice (the v0.3.0 pitfall) |
| 11 | **Do not filter by error type**: every failure is advised to retry (except exit 1 with empty output) | Adding the FATAL filter back violates the requirement "retry every error three times" |
| 12 | The proxy retries **any non-2xx** | Reverting to a whitelist makes 4xx pop up immediately and the user sees no retry |
| 13 | The backoff period must `sleep` and wait | Busy-spinning saturates a single core (97% measured in v0.3.1) |
| 14 | Write the response body back with `resp.read1(n)`, not `resp.read(n)` | `read(n)` waits until 8KB is accumulated, so SSE does not look streaming |
| 15 | Response body reads happen in a separate thread (`reader()` → `queue_`) and the main thread consumes | A blocking read in the main thread cannot send heartbeats on time or finish on schedule |
| 16 | Do not use socket timeouts to detect silence | After a timeout the buffered stream cannot be resumed; chunked `readline` also loses half a line and causes `IncompleteRead` |
| 17 | Do not close/shutdown from another thread to interrupt a read | On Windows it does not wake up, and it deadlocks against the `BufferedReader` lock |
| 18 | Short reads must check `resp.length` | A fixed-length response that ends early does not raise, is treated as a complete response and gets a terminating chunk appended |
| 19 | Get the upstream socket via `body_socket()` | When the upstream replies `Connection: close`, `conn.sock` is `None`; it is used only to set the leak-insurance timeout |

---

## 4. Test recipe (must run after changes)

No real relay needed. **Key trick**: set the heartbeat start smaller than a single silence (`START=2` < `SILENCE=3`); if heartbeats still appear around 2 seconds, that proves they are driven by an independent clock and did not wait for some attempt to fail.

```python
import importlib.util, json, os, socket, sys, threading, time

SRC = r"<package dir>/src/retry_proxy.py"  # use forward slashes to avoid path escaping
os.environ.update(
    PROXY_SILENCE_TIMEOUT="3",           # 3 seconds of silence per attempt
    PROXY_HEARTBEAT_START="2",           # heartbeat starts at 2s (deliberately below silence, to prove clock-driven timing)
    PROXY_HEARTBEAT_INTERVAL="2",
    PROXY_RETRY_WINDOW="3",              # 3-second retry window (very short for the test)
    PROXY_RETRY_INTERVAL="0.2",          # 0.2 seconds between attempts
    PROXY_PORT="18795", PROXY_CONNECT_TIMEOUT="2")
sys.dont_write_bytecode = True           # do not leave __pycache__ in the package
spec = importlib.util.spec_from_file_location("rp", SRC)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", 18796)); srv.listen(20)
threading.Thread(target=lambda: [srv.accept() for _ in iter(int, 1)], daemon=True).start()
m.UPSTREAMS.clear(); m.UPSTREAMS["/t"] = ("127.0.0.1", 18796, "http")
threading.Thread(target=m.main, daemon=True).start(); time.sleep(0.8)

body = json.dumps({"model": "m", "stream": True,
                   "messages": [{"role": "user", "content": "hi"}]}).encode()
NL = b"\r\n"
req = (b"POST /t/v1/chat/completions HTTP/1.1" + NL + b"Host: x" + NL +
       b"Content-Type: application/json" + NL +
       b"Content-Length: " + str(len(body)).encode() + NL + NL) + body
s = socket.create_connection(("127.0.0.1", 18795), timeout=20); s.sendall(req)
s.settimeout(0.3)

t0 = time.time(); raw = b""; hb = []
while time.time() - t0 < 20:             # 3s silence → the first failure hits the window; finish in ~3.2s, 20s is ample margin
    try:
        d = s.recv(4096)
        if not d:
            break
        raw += d
        while b"keepalive" in raw:
            hb.append(round(time.time() - t0, 2))
            raw = raw.replace(b"keepalive", b"", 1)
    except socket.timeout:
        pass
s.close()

print("heartbeat times:", hb)
print("assert 1: not before 2s :", bool(hb) and all(t >= 1.7 for t in hb))
print("assert 2: before 3s     :", bool(hb) and hb[0] < 3)
print("assert 3: window finish  :", "已持续重试".encode() in raw)  # literal Chinese prefix of the runtime give-up message
print("assert 4: error event    :", b"server_error" in raw)
```

**Why these parameters**: `HEARTBEAT_START=2` is deliberately smaller than `SILENCE_TIMEOUT=3`. If heartbeats still appear around 2 seconds (while the first attempt only fails at 3 seconds), that proves heartbeats do not depend on attempt boundaries. With a 3-second window paired with 3-second single silence, as soon as the first attempt fails (t≈3.0 s) the next attempt's start time (t≈3.2 s) is already past the window, so it finishes immediately — this isolates exactly the "window expired" path, and the 20-second observation window leaves ample margin.

**The four assertions**

| Assertion | What it proves | What it means if it fails |
|---|---|---|
| 1. All heartbeats ≥ start (0.3-second tolerance) | Heartbeats are not early | The clock threshold comparison is written wrong |
| 2. First heartbeat earlier than the silence timeout | Heartbeats do not wait for an attempt to fail | Heartbeats were hung back onto attempt boundaries (historical bug) |
| 3. The give-up message appears in the response | Window-expiry finish works | The RETRY_WINDOW logic was broken |
| 4. `server_error` appears in the response | All-failed returns an explicit error instead of hanging | The finish path was lost |

Non-streaming control: set `stream` to `False`; expect **no** `keepalive`, and an HTTP **503** after the window expires (plain JSON, not SSE; about 3 seconds with the accelerated parameters).

**The response body (streaming write-back) has its own self-test**: `python tools/selftest_stream.py`, whose 32 scenarios each stress "pass through chunk by chunk / keep alive during mid-stream silence / short read on a fixed length judged truncated / normal finish / silence until the window is judged truncated / slow client loses no data / give up in heartbeat mode must carry a retryable error body". You must run it after changing `pipe_response` — behavior after the response headers cannot be tested with this recipe.

## 5. Troubleshooting

| Symptom | Check first | Common cause |
|---|---|---|
| The model cannot connect at all | Whether 8787 is listening; `doctor.py` | Proxy not started / provider already points at the proxy but the port is empty |
| Still pops up "no output for 95 seconds" | Whether `proxy.log` has `heartbeat #` | Heartbeat not triggered (non-streaming requests send none), or a single attempt's connect + wait already exceeded 95 seconds |
| Hook does not trigger | The hook items in `doctor.py`; `hook.log` | `hooks.enabled=false` / mounted on the wrong event / non-Bash tool |
| The log has `attempt fail` but ends with `ok` | Normal | It means the retry rescued it |
| The log has `truncated` | Normal | The stream broke after write-back had started; cannot retry |
| `install.py` reports "no changes were made" | Read the error text | It exited during validation, which is expected behavior; supply the missing arguments as instructed |
| The provider address was reverted to the official one | Re-run `install.py --with-proxy` | The ZCode UI may rewrite that file |

Log locations: `%TEMP%\Zcode-Persistence\hook.log` (hook), `C:\Program Files (x86)\AI\Zcode-Persistence\proxy.log` (proxy).

---

## 6. Change and release flow

1. Change the code.
2. Run the tests in section 4; all four assertions pass.
3. Feed a sample manually to verify the hook (mandatory when the pattern list changed):
   ```bash
   echo '{"tool_name":"Bash","tool_input":{"command":"curl x"},"error":"operation timed out"}' | python src/retry_hook.py
   ```
4. Bump the version in all four places: `VERSION`, `VERSION` in `tools/install.py`, `PROXY_VERSION` in `src/retry_proxy.py`, and `clientInfo.version` in `src/error_watch.py`.
5. Update `CHANGELOG.md` (state clearly what changed and why).
6. Sync the affected parameter tables in `README.md` / `docs/02-maintenance.md`.
7. Package: save the script below as `make_zip.py` and run `python make_zip.py <package-dir> <output.zip>` from anywhere. The output must be outside the package directory; the script skips itself, `__pycache__`, `*.pyc` and `*.log`. Remember to change the version number.

```python
import os, sys, zipfile

root = os.path.abspath(sys.argv[1])
out = os.path.abspath(sys.argv[2])
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d != "__pycache__"]
        for fn in fns:
            src = os.path.join(dp, fn)
            if src == out or fn == "make_zip.py" or fn.endswith((".pyc", ".log")):
                continue
            z.write(src, os.path.join("Zcode-Persistence-vX.Y",
                    os.path.relpath(src, root)))
```

8. Hand it to an independent sub-agent for review (released only when the overall score is ≥4.5/5 and the code score is ≥4.0/5); if below standard, fix it and start over.

---

## Continuing development starts here (for the next AI / engineer)

**First get the version numbers straight**: what you ship externally is the formal release number (`0.2.8` on main; latest published V0.2.7); `0.4.0` is the build-line iteration number,
and the two are not the same thing. `VERSION`, `tools/install.py`, `PROXY_VERSION` and `clientInfo.version` all carry the formal release number;
the project `README.md` records the current build line.

**Five-minute onboarding**

1. Read the "What it is / Limitations" sections of `README.md`.
2. Read this file (`docs/06-ai-maintenance-guide.md`), section 2 code map and section 3 invariants.
3. Run a health check once: `python <install directory>/doctor.py`; it must show 0 failed (the item count depends on how many providers are configured).
4. Run the self-tests: `tools/selftest_hook.py` (11 checks), `tools/selftest_proxy_429.py` (12 scenarios), `tools/selftest_stream.py` (32 scenarios), `tools/selftest_route.py` (13 checks),
   `tools/selftest_watch.py` (12 assertions), `tools/selftest_ensure.py` (serialization); all should PASS.

**Three things you must know before changing code**

- The hook only "advises" a retry; what actually resends is the proxy; the two do not depend on each other and can be installed separately.
- Hook output **may only use `additionalContext`**; if written as `systemMessage` the model cannot see it (hit in v0.3.0).
- **No filtering by error type**. Every failure is advised to retry (except exit 1 with empty output); the proxy resends on any non-2xx.

**Standard actions after changes**

1. `python -m py_compile src/*.py tools/*.py`
2. `python -I tools/selftest_proxy_429.py` (retry semantics)
3. `python -I tools/selftest_stream.py` (streaming write-back)
4. Run the heartbeat recipe in section 4 of `docs/06-ai-maintenance-guide` (four assertions)
5. `python tools/install.py --with-proxy --provider-id new-provider`
6. Restart the proxy (needed only if `retry_proxy.py` changed): follow "Restart the proxy" in `docs/02-maintenance.md`, and **do not kill the process while a request is in flight**
7. `doctor.py` confirms that "proxy runtime parameters" match the script
8. Update `CHANGELOG.md`; on a formal release bump all four version fields (`VERSION`, `install.py`, `PROXY_VERSION`, `clientInfo.version`)
9. Repackage and confirm that the package / zip / installed copy have identical sha256

**Common failure lookup**

| Symptom | Look at first |
|---|---|
| The model cannot connect at all | Whether 8787 is listening; "proxy runtime parameters" in `doctor.py` |
| Still pops up `Turn execution failed` | The `reasons=` of `gave up` in `proxy.log` (status=429 storm / silence=upstream is down) |
| Advice was given but the model did not retry | Whether `hook.log` has `advise`; if it does, the output field is wrong; if not, the hook did not trigger |
| The hook never triggers | The matcher and script path items in `doctor.py` |

## 7. Historical pitfalls already fixed (regression-prevention checklist)

These are all real problems that were hit and fixed. **Do not reintroduce them.**

| Pitfall | Symptom | Fix |
|---|---|---|
| Command text participated in matching | `timeout 30 npm test` was treated as a timeout error | Strip `tool_input` and the raw command before matching |
| Metadata participated in matching | `session_id` happened to contain `429` → false report | Exclude identifier fields such as `session_id`/`requestId`/`toolCallId` |
| `sleep 180` hit the tool timeout | Bash's default 2 minutes killed the sleep and the wait was wasted | The advice text requires that command's timeout be set above 200000 milliseconds |
| Heartbeat hung on attempt boundaries | The heartbeat came one attempt cycle late and could miss the 95-second window | Switch to the independent clock `next_hb_at` |
| Upstream succeeded after heartbeat mode | The status line was sent a second time and the response body was corrupted | `pipe_response(..., sse_started)` skips the headers |
| A terminating chunk appended after the stream broke | The client assumed it completed normally | Do not append `0\r\n\r\n`; record `truncated` |
| Send timeout reused the connect timeout | Requests with hundreds of KB of body could not finish writing and were judged failed | Separate `SEND_TIMEOUT=90` |
| Re-running provider switched to the wrong upstream | `/cm` was switched to `/ap` | Determine the prefix automatically from the original address; error out if it cannot be determined |
| Hook substring matching | `my_retry_hook.py` was wrongly deleted | Exact basename equality |
| Unlimited retries | Requests hung forever when the upstream died | Tried in v1.1.0 then reverted; now a 5-minute time window + one attempt every 20 seconds, always finishing at the deadline |

---

## 8. Known boundaries (not bugs, do not try to "fix" them)

1. **The hook cannot catch a whole-turn failure**. `PostToolUseFailure` requires `toolName`/`toolCallId`; a model-level `Turn execution failed` has no tool involved, so none of the seven hook events fires. This class can only be handled by the proxy.
2. **The proxy cannot rescue "the upstream slowly swallows the request body"**. 95 seconds is a hard client timeout, and the proxy cannot make the upstream faster.
3. **Heartbeats work only for streaming**. A non-streaming response must be complete JSON; nothing can be inserted in the middle.
4. **The heartbeat comes online at 80 seconds**, after which the client's 95-second timeout no longer counts; after the response headers, if the upstream emits no bytes for a long time, the reader thread + main loop keep sending heartbeats, and truncation is judged only when accumulated silence reaches the retry window (300 seconds).
5. **The provider config may be rewritten by the ZCode UI**; re-running `install.py --with-proxy` restores it.
6. **`retryable` is decided locally, not by the upstream** (corrected 2026-10-31). When the proxy gives up it returns
   `code=model_server_error` + `retryable:true` itself, and only then does the client retry using stream recovery and continue writing;
   older versions treated `retryable=false` in the client's popup as "decided by the upstream", which caused the whole turn to be judged dead.
   400 (the client itself wrote something wrong) still returns `retryable:false`.
7. **Windows `SO_REUSEADDR` allows two processes to bind 8787 at the same time** (not allowed on Linux). So "the port is listening" does not equal "this proxy is the one running": both `ensure_proxy`/`doctor` first request `/__zp_health` to confirm. When two proxies appear, kill the extra one by PID from `netstat -ano`; do not leave both.
8. **The time window is not a hard upper bound**. `RETRY_WINDOW` only decides "whether to still launch new attempts"; an attempt already in flight is allowed to finish (connect 10 seconds + send 90 seconds + wait for headers 30 seconds maximum), so the worst-case duration may exceed the window.
9. **`proxy.log` does not rotate**. It keeps growing during long runs; `doctor` reads only the tail (walking back at most 8MB for the start line), and when cleanup is needed you can simply delete it (the proxy recreates it).
10. **Response-body heartbeats apply only to SSE**. `can_hb` requires the client to want streaming and the response to be `text/event-stream` (or heartbeat mode to have already sent a 200);
    for other Content-Types, inserting a comment line would corrupt the body, so that case is still truncated per `SILENCE_TIMEOUT=30` seconds.
11. **Reader thread and queue**. `pipe_response` uses `Queue(maxsize=64)` (about 512KB) to connect the reader thread and the main thread;
    when the queue is full the reader thread blocks (backpressure) and no data is lost. After the main thread finishes it sets `stop`, and the reader thread exits at its next `put`;
    if it is stuck in a blocking read, all it can do is wait for the socket timeout (`RETRY_WINDOW+30` seconds) — the unavoidable price of being unable to interrupt `read1` from outside on Windows.
    Also: when the client "neither reads nor disconnects" (half-open), the main thread blocks in `wfile.write` until the peer recovers or TCP errors; having no client write timeout is a pre-existing boundary.
    Degradation: when `body_socket()` cannot get a socket, the read timeout remains `SILENCE_TIMEOUT=30` and response-body heartbeats are basically ineffective.
12. **A missing or unknown `finish_reason` is a failure, not a normal end** (V0.2.3).
    The client's `Bto()` maps `undefined`/null/unknown values to `other`, then completes
    the turn. If the stream produced no `delta.content` and no tool call, `process_sse()`
    withholds the ending event at `[DONE]` (or at clean EOF when `[DONE]` is absent) and
    returns `"early"`; `_handle` discards that upstream attempt and immediately re-requests
    it, continuing the same client response. Do **not** send a mid-stream SSE error: in
    production the client classified it as `ProviderBusinessError` with
    `retryable=false`, and the turn failed. If content or a tool call was already emitted,
    the ending must pass through unchanged: retrying there would duplicate visible
    output. An explicit upstream SSE error event (`{"error":...}`, production code
    `stream_truncated`) follows the same rule (V0.2.4): swallowed and retried when no
    text/tool call exists; once content exists, a client reset is used instead (V0.2.7).
    Tool-call deltas are buffered until `finish_reason` or stream end (V0.2.5); the JSON
    is validated before release (V0.2.7): a stream that ends mid-arguments with nothing
    written out is discarded and re-requested; once a complete tool call has been written
    out, no more retries (tools would run twice); if content exists but the call is
    incomplete, reset the client.
13. **`ensure_proxy` must hold a cross-process lock** (V0.2.3). Port probing alone races:
    two SessionStart hooks can both see an empty port and spawn a proxy, and Windows
    `SO_REUSEADDR` lets both listen on 8787. The named mutex
    `Local\ZcodePersistence-EnsureProxy` serializes the check-and-spawn critical section;
    `selftest_ensure.py` proves two processes serialize. `doctor.py` reports FAIL if more
    than one process is LISTENING on 8787.
