# 03 Architecture

## Overall layout

```text
ZCode Desktop
  model request ──┐
                  │  (mode B: baseUrl = 127.0.0.1:8787/p/<b64> or a fixed /ap,/cm,/cg)
                  ▼
            retry_proxy :8787 ──► upstream-a.example.com/v1
                  │                (resend on failure)
                  ▼
            upstream relay

  tool call failure ──► PostToolUse (primary) / PostToolUseFailure (fallback)
                            └─► retry_hook.py
                                  └─► additionalContext (retry suggestion)

  session start ──► SessionStart ──► ensure_proxy.py ──► start proxy

  session error (red dot) ──► error_watch.py ──► outlook MCP ──► email
```

The two main chains are independent of each other: the hook handles **tool failures**, the
proxy handles **model request failures**. Either can be installed on its own. The third is
an optional bypass: `error_watch.py` does not take part in retries; only when a session ends
up at `last_outcome=error` (red dot in the UI) does it read the proxy log and mail the
reason out; it is off by default (enabled only with `ZCODE_PERSISTENCE_WATCH=1`).

---

## Mode A: the hook chain

```text
Bash tool failure
   │
   ▼
ZCode dispatches PostToolUse (fallback event PostToolUseFailure); the payload contains
tool_name / tool_input / tool_response (exitCode, timedOut, status, stderr, stdout)
   │
   ▼
retry_hook.py reads stdin JSON
   │
   ├─ not Bash ───────────────────────────► exit 0, silent
   ├─ failure detected: exit code ≠ 0 / timedOut / cancelled / status=failed|error
   ├─ no failure ─────────────────────────► exit 0, silent
   ├─ same toolCallId advised within 120s ─► exit 0 (deduplication)
   ├─ count already 3 ────────────────────► exit 0
   ├─ UPSTREAM match ──► count+1 ──► emit "wait 3 minutes first" advice
   └─ any other failure ──► count+1 ──► emit "retry immediately" advice

Counting rule: key = sha1(session | command), cap 3, 10-minute window, pruned after 1 day.
Since v0.4.0 there is no FATAL filter: every failure gets a retry suggestion. Exception: exit 1 with completely empty output is a predicate command's normal negative result, not a failure.
```

**Why `tool_input` is stripped first**: since v0.4.0, "whether to retry" looks only at exit
code/timeout/cancellation and has nothing to do with the text; the text only decides
"whether to wait 3 minutes first" (`UPSTREAM_PATTERNS`). If the raw command happens to
contain a word like `upstream_deadline`, it makes people think the upstream is down, so it
does not take part in matching.

**Why the metadata fields are stripped**: `session_id`, `requestId` and `toolCallId` are
random strings that can coincidentally combine into words like `capacity` or `overloaded`,
causing the "wait 3 minutes first" advice to be sent by mistake. Once they are stripped,
the decision depends only on real output.

**Why it always exits 0**: the hook is a bypass; a problem in it should not bring the
session to a halt. All exceptions are swallowed in the outer `__main__`.

---

## Mode B: the proxy chain

```text
client POST /p/<base64url(original)>/v1/chat/completions (or /ap,/cm,/cg)
   │
   ▼
read the full body (supports Content-Length and chunked)
   │
   ├─ UA is python-* or missing ──► replace with a normal browser UA (bypasses Cloudflare 1010)
   │
   ▼
attempt 1:
  connect(10s) → send(90s) → wait for first byte(30s)
   ├─ connection failure / any non-2xx ──► retry
   ├─ no response headers within 30s ────► retry
   └─ headers received ──────────────────► start write-back
   │
   ▼
write response headers (strip hop-by-hop) → read1 chunk by chunk, flush to the client
   │  (streaming: the reader thread only does blocking reads; the main thread checks the
   │   queue every 0.5s; after 80s of silence add `: keepalive`; at 300s mark truncation)
   │
   ├─ SSE ends ([DONE] / clean EOF) with no finish_reason, or an unknown reason,
   │   and no text/tool call yet ──► return "early"; _handle re-requests upstream and
   │   continues the same client response (V0.2.3)
   ├─ upstream sends an SSE {"error":...} (stream_truncated/upstream_error)
   │   ├─ no text/complete tool call ──► swallow, mark early, re-request (V0.2.4)
   │   ├─ text written, no complete tool call ──► RST the client (V0.2.7)
   │   └─ complete tool call / finish emitted ──► pass through
   ├─ stream ends mid-tool-arguments (tool_args_invalid shape)
   │   ├─ nothing written out yet ──► drop the buffer, mark early, re-request (V0.2.5)
   │   └─ text written, incomplete JSON ──► write zero bytes, RST the client (V0.2.7)
   ├─ read error/silence with no text/tool call/finish reason and the client connected
   │   ──► mark early, re-request (V0.2.6; a client disconnect is logged as
   │   `client gone` and never retried)
   ├─ read error/silence after text was written, no complete tool call
   │   ──► RST the client (V0.2.7; FIN alone is not retryable for the client)
   ├─ stream breaks after content and a complete tool call / finish reason ──► can only end; cannot retry (would duplicate content)
   ├─ fixed-length response delivers too few bytes ──► log truncated, no terminator
   └─ normal end ──► log ok
```

**The retry decision (since v0.4.0; 300-second window since V0.2.6)**: every failed attempt is resent — connection errors, any
non-2xx from upstream, and silence timeouts. It is not count-based but time-window-based:
keep retrying for 5 minutes, once every 20 seconds (`Retry-After` from the response header
or the error body is honored, capped at 60 seconds), and only stop when the window expires; `MAX_ATTEMPTS=200` is merely a fuse against
runaway retries. During backoff the thread does a `time.sleep` until the next attempt
instead of spinning. Heartbeats are independent of attempt boundaries: after 80 consecutive
seconds without upstream input one `: keepalive` is sent, and then one every 80 seconds,
with no upper limit.

**Key design point: retries happen before any user-visible text is written** (V0.2.3).
Once text has been written there is no going back; that is a physical constraint of HTTP
streaming. The one recoverable case is a stream that ends with **no text and no tool call**
(missing/unknown `finish_reason`, or literal `other`): the proxy discards that upstream
attempt and re-requests it internally, and the new stream continues writing into the same
client response. It does **not** send a mid-stream SSE error — production testing showed the
client classifies that as `ProviderBusinessError` with `retryable=false`. The same
recoverable shape is an explicit upstream SSE `{"error":...}` event (production:
`stream_truncated`/`upstream_error`): it is swallowed and retried when no text/tool call
has been emitted (V0.2.4); once content exists but no complete tool call has been sent,
the client is reset instead (V0.2.7). If a complete tool call or a `finish_reason` has
already been written, the event is passed through — a retry would run tools twice.

**Recovering after content (V0.2.7)**: an internal re-request would duplicate the text,
and an SSE business error becomes `ProviderBusinessError` (`retryable` always false). The
client's `Eqo()` only recovers when discarded reasoning/text bytes > 0 and `sqa(error)` is
true; `sqa()` walks the `cause` chain and accepts `ECONNRESET`. The proxy therefore
validates every buffered tool call as JSON (`NaN`/`Infinity` rejected) and, if content was
written and the call is incomplete or the upstream errored, sets `SO_LINGER=0`, closes
`wfile`/`rfile`, then the socket, and sets `handler.close_connection=True`. Closing only
the socket object does not release the fd because the makefiles hold references, so the
client would hang; not setting `close_connection` makes `handle()` spin on the closed
`rfile` at 100% CPU. The client sees `ECONNRESET`, discards the partial output and retries
with `previous-message-anchor` (max 10).

**Where the 30-second silence timeout comes from**: the ZCode client declares failure if it
has not received the first byte within 95 seconds. So the proxy first hangs an SSE heartbeat
comment line on the stream once 80 seconds are up, extending the client's patience.
Silence **before the response headers** is judged a failure with `SILENCE_TIMEOUT=30` and
retried; **after the response headers** retrying is no longer possible, and silence is
handled instead by "reader thread + main thread consuming the queue": one heartbeat every
80 seconds keeps the wait alive, and the stream is judged truncated only once cumulative
silence reaches `RETRY_WINDOW` (300 seconds).

The premise is that the response body really is SSE (`Content-Type: text/event-stream`, or
a 200 event-stream has already been sent in heartbeat mode); otherwise inserting a comment
line would corrupt the body, and in that case the 30-second silence truncation still applies.

**The window is not a hard cap**: `RETRY_WINDOW` only decides "whether to still start new
attempts". The attempt already in flight is allowed to finish (connect 10 seconds + send 90
seconds + wait for headers 30 seconds at most), so the actual duration when giving up may
slightly exceed the window; the "retried continuously for N seconds" figure in the give-up
message records the real elapsed time.

**The worst case overshoots the window**: each attempt also spends connect time (10 seconds
at most) and request-body send time (90 seconds at most). If the upstream can be connected
to but swallows the request body slowly, the total can far exceed 95 seconds and the client
will time out first. The proxy cannot rescue that case; it can only guarantee that the
requests which fail fast get resent.

---

## Startup chain

```text
ZCode session start
   │
   ▼
SessionStart hook → ensure_proxy.py
   │
   ├─ 8787 already listening ──► GET /__zp_health to verify identity
   │                             ├─ this proxy ──► exit 0 (idempotent)
   │                             └─ not this proxy ──► log a warning, exit 0
   │                                 (the provider would hit the wrong service)
   ├─ port free ──► subprocess.Popen(DETACHED_PROCESS) to start retry_proxy.py
   └─ any exception ──► exit 0 (never blocks session start)
```

`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` is used so that the proxy survives the hook
process — the hook exits as soon as it finishes, and the proxy has to keep running.

---

## Data and privacy

| Data | Written to disk | Location |
|---|---|---|
| Model request/response bodies | **Not recorded** | — |
| Tool error text | Only counts and type (timeout/upstream/error); the error body is not written; the exception branch records only the exception type | `%TEMP%\Zcode-Persistence\hook.log` |
| Command text | Used only to compute the hash for the counter key | `state.json` (hash only, irreversible) |
| Proxy state | Only status code/byte count/latency | `<install directory>\proxy.log` |

The API Key lives in the provider config; the proxy only uses it while forwarding and never
writes it to the log.

---

## Relationship to the ZCode event model

ZCode supports seven hook events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop`.

This package uses three:

- `PostToolUse`: **the primary mount point**. This client does not dispatch
  `PostToolUseFailure` for interrupted/timed-out Bash calls, but `PostToolUse` always
  arrives, carrying a structured `tool_response` (`exitCode` / `timedOut` / `status` /
  `stderr`)
- `PostToolUseFailure`: fallback, present only when the tool really throws
- `SessionStart`: the only event that reliably catches the "session start" moment, used to
  start the proxy

**No event can catch "a whole round of model requests failed"** — `Stop` only fires with
`responseText` on normal completion. That is why Mode B has to solve it at the transport
layer with a proxy rather than with a hook.
