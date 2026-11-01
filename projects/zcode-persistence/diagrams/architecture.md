# Architecture Diagram (V0.2.3 patch release)

> Build line 0.4.0. Parameters and semantics follow the code in this project's `src/`;
> this document sketches the relationships without repeating every detail.

## Three pathways

```text
ZCode client
  model request ──► retry_proxy.py (127.0.0.1:8787) ──► upstream relay
                     ├─ /ap/... → upstream-a.example.com/v1
                     └─ /cm/... → upstream-b.example.com/v1
                        (resends automatically before any byte is returned)

  Bash tool failure ──► PostToolUse (primary)
                     └─► PostToolUseFailure (fallback; this client does not
                         dispatch it for timeouts/interruptions)
                           └─► retry_hook.py
                                 └─ stdout JSON {"additionalContext": ...}
                                      └─► model decides whether to retry

  session start ──► SessionStart ──► ensure_proxy.py ──► start proxy if port free

  session error (red dot) ──► error_watch.py ──► outlook MCP ──► email
                               (off by default; only last_outcome=error)
```

| Pathway | Trigger | Output | Can it really resend |
|---|---|---|---|
| Hook | A Bash call fails | One retry suggestion injected into the context | No, it can only suggest |
| Proxy | One model request fails | The response after resending | Yes |
| Auto-start | Session start | Ensures the proxy is running | — |
| Error reporting | `session.last_outcome=error` | One email containing the reason (off by default) | No, it only reports |

## Proxy retry state machine

```text
request ──► read full body (chunked-aware) ──► UA fallback ──► detect streaming
   │
   ▼
main loop (window started .. started+180s, one attempt every RETRY_INTERVAL=20s)
   ├─ each attempt: connect 10s → send body 90s → wait for first byte 30s
   ├─ failure: connection error / any non-2xx / 30s with no bytes
   ├─ after failure: wait max(20s, Retry-After ≤ 60s); stop if the next attempt falls outside the window
   ├─ window expires with no attempt in flight → finish (MAX_ATTEMPTS=200 is only a runaway fuse)
   └─ heartbeat: 80s without upstream input → write the SSE comment `: keepalive`,
                 then one every 80s, no cap (independent clock, not tied to attempt boundaries)
   │
   ├─ success → write response headers → read and flush
   │    ├─ stream breaks mid-way → stop; do not add a chunked terminator (the client must see truncation)
   │    └─ normal end → log ok
   └─ window expires with failures → streaming: SSE error event; non-streaming: 503 + OpenAI-shaped error body
```

**Key constraint**: once bytes have started flowing back to the client you cannot retry (the
content would be duplicated), so resending happens only "before the first byte". The
heartbeat exists so that the client's 95-second first-byte timeout does not misfire on a
long wait.

## Hook decision order

```text
non-Bash tool ──► pass through (the matcher already limits to Bash; this is belt and braces)
  ↓
failure detection uses hard signals only: exitCode ≠ 0 / timedOut / cancelled|interrupted /
status ∈ {failed, error, failure}
(never inspect the command text; never write status != "completed", which would misclassify success)
  ↓
same toolCallId already advised → skip (the two events may each fire once)
  ↓
UPSTREAM_PATTERNS match (upstream produced nothing)
  └─► advise: sleep 180, then retry the same command (set its timeout above 200000 ms)
  ↓
any other failure
  └─► advise: retry the same command immediately
  ↓
count reaches 3 → stop advising; ask the model to explain the blocker to the user
```

**No error-type allowlist**: the FATAL filter from v0.3.x has been deleted, and the proxy
likewise resends on any non-2xx. This is the user's explicit specification; putting it back
amounts to violating the requirement.
