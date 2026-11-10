# 04 Test Record

This record documents the hook's v0.4.0 decision semantics (any Bash failure is advised to retry; the single exception is exit 1 with completely empty output) and the later proxy streaming fixes. After a change, re-run the relevant suites and only release once everything passes.
The old expectations of v0.3.x (filtering out by error type, no retry on `permission denied`) are void; do not change the code back according to the old tables.

> **Reading order**: Sections 1 through 20 are historical batches kept as-is for traceability
> (fixed-count retries, the v1.1.0 heartbeat parameters, the v0.4.0 build line, the 2026-10-31 fixes,
> and the V0.2.1–V0.2.10 changes). **Section 21 records the original V0.2.11 release behavior
> and is historical; Section 22 records the V0.2.12 candidate behavior and its test results.**
> The current defaults are a 600-second retry window, one attempt every 20 seconds, a 60-second
> silence timeout and 80-second heartbeats; the "180-second window" and "503 after 3 retries"
> wording in old batches is historical only.

## 1. Hook (retry_hook.py)

Test method: `echo '<payload>' | python src/retry_hook.py`, with the state directory isolated via `ZCODE_RETRY_HOOK_STATE_DIR`.

Automated regression: `python tools/selftest_hook.py` (10 decision cases plus the third-attempt wording check; 11 checks total, including the exit-1-with-no-output false positive).

| # | Input | Expected (v0.4.0) | Observed |
|---|---|---|---|
| 1 | `tool_name=Bash` + `operation timed out` | Has output; the message does not contain `sleep` | ✅ |
| 2 | `network timeout at registry.npmjs.org` | Has output | ✅ |
| 3 | The same command timing out 4 times in a row | 1/3, 2/3, 3/3, then silent on the 4th | ✅ |
| 4 | `upstream_deadline` | Has output; the message contains `sleep 180` and `200000 ms` | ✅ |
| 5 | A Chinese error message meaning "no output from upstream within 95 seconds" | Same as above | ✅ |
| 6 | `overloaded` | Same as above | ✅ |
| 7 | `permission denied` | **Has output** (no longer filtered out since v0.4.0) | ✅ |
| 8 | `upstream_deadline after permission denied` | Has output; the message uses `sleep 180` | ✅ |
| 9 | `tool_name=Read` + timeout | No output (only Bash is handled) | ✅ |
| 10 | Invalid JSON | No output, exit code 0 | ✅ |
| 11 | Empty stdin | No output, exit code 0 | ✅ |
| 12 | Command `timeout 30 npm test` + `AssertionError` | **Has output** (a timeout in the command text no longer affects the decision; a failure retries) | ✅ |
| 13 | Error text echoing that command verbatim | Has output | ✅ |
| 14 | `session_id="abc-429-def"` + `disk is full` | Has output (metadata takes no part in matching, and the decision is independent of the text) | ✅ |
| 15 | `requestId="req-429-x"` + an unrelated error | Has output | ✅ |
| 16 | A real `HTTP 429 too many requests` in the error field | Has output | ✅ |
| 17 | A timeout in the `error_message` field | Has output | ✅ |
| 18 | Command `ls` + `command not found` | **Has output** (deterministic errors retry too, up to 3 times) | ✅ |
| 19 | Corrupt state.json + a failing call | **Has output**, exit code 0 (bad records fall back to defaults and are no longer silent) | ✅ |
| 20 | Success + `status="success"` + a warning on stderr | **No output** (a successful call must not be misjudged as a failure) | ✅ |
| 21 | Failure + stdout/stderr both empty (exit=1) | **No output** (a predicate command's normal negative result; fixed 2026-11-01) | ✅ 2026-11-01 |
| 22 | `status="failed"` but `exitCode=0` | Has output | ✅ |
| 23 | Two consecutive events with the same `toolCallId` | The second is silent (deduplication takes effect) | ✅ |
| 24 | `tool_name=Bash` but neither `tool_response` nor any error field (only `session_id`/`tool_use_id`) | **No output** (metadata must not be padded out into error text, otherwise every successful Bash call would be advised to retry) | ✅ 2026-11-01 |
| 25 | `tool_response` is a string (not a dict) and non-empty | Failure is judged by content and a retry is advised | ✅ |
| 26 | `exitCode=1` + non-empty stderr | Has output (any output means it is not a silent predicate result) | ✅ 2026-11-01 |
| 27 | `exitCode=1` + non-empty stdout | Has output | ✅ 2026-11-01 |
| 28 | `exitCode=2` + empty stdout/stderr | Has output (an exit code other than 1 is still a failure) | ✅ 2026-11-01 |
| 29 | `status="failed"` + `exitCode=1` + empty output | **No output** (the client marks exit 1 as failed, so status alone is not enough) | ✅ 2026-11-01 |
| 30 | `exitCode=1` + `timedOut=true` + empty output | Has output; uses the timeout wording | ✅ 2026-11-01 |
| 31 | `exitCode=1` + `cancelled=true` + empty output | Has output (cancellation still counts as a failure) | ✅ 2026-11-01 |

**All 31 items exit with code 0**, with no stderr output.

## 2. Proxy (retry_proxy.py)

| # | Scenario | Expected | Observed |
|---|---|---|---|
| 1 | Empty UA, POST /ap/v1/chat/completions | The fallback UA takes effect, HTTP 200 | ✅ 4.3s, returned "connected" ("it worked") |
| 2 | Streaming, `stream=true` | SSE passed through event by event, content complete | ✅ 54 events, first packet at 5.6s, content `1,2,3,4,5,6,7,8,9,10` |
| 3 | UA `Python-urllib/3.12` calling the upstream directly | Blocked by Cloudflare with 1010 | ✅ reproduced; normal when going through the proxy |
| 4 | TLS verification | Passes with certifi | ✅ the default context fails, certifi succeeds |
| 5 | Unknown path prefix | 400 + a clear error | ✅ |
| 6 | All attempts fail (fixed 4 at the time) | 503 + retried automatically 3 times and still failing (OpenAI-shaped error body) | ✅ (the fixed-count era; the current wording is "retried continuously for N seconds and still failing") |

## 3. Autostart (ensure_proxy.py)

| # | Scenario | Expected | Observed |
|---|---|---|---|
| 1 | The proxy is already listening | Exits silently with 0, does not start another | ✅ the port entry count stays 1 |
| 2 | Run after the proxy was killed | Starts it, listening again within 3 seconds | ✅ |
| 3 | Script missing | Exits 0 without reporting an error | ✅ |

## 4. Configuration changes

| # | Check | Result |
|---|---|---|
| 1 | `config.json` is valid JSON | ✅ |
| 2 | Exactly 1 entry in `PostToolUseFailure` that references `retry_hook.py` | ✅ |
| 3 | That entry has `matcher=Bash`, `timeoutMs=5000` and no extra fields | ✅ |
| 4 | Exactly 1 entry in `SessionStart` that references `ensure_proxy.py` | ✅ |
| 5 | The baseUrl of `provider new-provider` points at `127.0.0.1:8787/ap/v1` | ✅ |
| 6 | The pre-change backup exists and holds the pre-change content | ✅ |
| 7 | After removing the entries this package added, the configuration is semantically identical to the backup | ✅ |

## 5. Independent re-review

The hook part of v1.0.0 went through two rounds of independent subagent review: the first round scored 4/5 (flagging the metadata false positive and the sleep colliding with the timeout), and the re-check after the fixes scored 5/5. The proxy and autostart parts were added just before packaging; for the review scope see the corresponding CHANGELOG entries.

## 6. Uncovered scenarios (known gaps)

1. **End-to-end triggering in a real ZCode session**: the hook can only fire on a real Bash tool failure, and the proxy needs an actual model call from inside ZCode. The packaging environment can only simulate payloads and cannot replace verification in a real session.
2. **Hook output field**: in v0.3.0, testing showed the model could not see `systemMessage`; v0.3.1 changed it to `additionalContext`.
3. **Proxy behavior when the response stream breaks mid-flight**: by design it does not retry, it just disconnects; no real mid-stream break sample was constructed.
4. **Multi-session concurrency**: hook counters are keyed per session, so in theory they are isolated; no concurrency stress test was run.

## 7. New cases in v1.0.2 (installer/uninstaller)

Executed in an isolated HOME sandbox; the real configuration was never touched.

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | First install with --with-proxy (original address matches upstream A in `upstreams.json`) | 1 hook entry each, baseUrl switched to /ap/v1, state records originalBaseUrl | ✅ |
| 2 | Re-running the same install command | Hooks are not duplicated, the provider is unchanged, originalBaseUrl is not overwritten | ✅ |
| 3 | Wrong providerId | Exits with an error, the configuration is byte-for-byte unchanged | ✅ |
| 4 | Original address matches upstream B in `upstreams.json` | Automatically selects /cm/v1 | ✅ |
| 5 | Original address unrecognized and no prefix given | Exits with an error and makes no change | ✅ |
| 6 | Original address unrecognized + --proxy-prefix ap | Switches normally | ✅ |
| 7 | uninstall --dry-run | Does not write to disk | ✅ |
| 8 | Real uninstall | Hooks cleared, the provider restored to the real address | ✅ |
| 9 | The configuration contains my_retry_hook.py | Only retry_hook.py is recognized/removed; the former is left alone | ✅ |
| 10 | State after uninstall | hooks/providers cleared and uninstalledAt written | ✅ |

## 8. Prefix-correction path cases for v1.0.3/v1.0.4

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Currently /cm, explicit --proxy-prefix ap | Switches to /ap, proxyBaseUrl in state updated accordingly | ✅ |
| 2 | Currently /ap, explicit --proxy-prefix ap | No switch, provider written 0 times | ✅ |
| 3 | Currently /ap, no explicit prefix | No switch, provider written 0 times | ✅ |
| 4 | Currently /cm, explicit ap, but state lacks the original-address record | Fails validation and exits; no script copied, no hook written, no provider written | ✅ (after the v1.0.4 fix) |

## 9. v1.1.0 heartbeat keep-alive cases

The tests used accelerated parameters (SILENCE=2s, HEARTBEAT_START=5s, MAX_ATTEMPTS=4, RETRY_DELAYS=0.2,0.2,0.2); the conclusions hold for the default values as well.

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Silent upstream + streaming, observed for 16 seconds | Heartbeat mode is entered only after the threshold is met, then one heartbeat per failure | Pass: entered at 6.6s, more than 3 in a row, no cap |
| 2 | A 200 received while heartbeating | The status line is not sent again | Pass: the sse_started flag skips the header |
| 3 | A 4xx/5xx received while heartbeating | The status code cannot be changed; it is turned into an SSE error | Pass |
| 4 | Silent upstream + non-streaming | No heartbeat; returns 503 after 3 full retries (4 attempts in total) | Pass |
| 5 | Connection failure + streaming | Retries up to the cap, then returns 503 with a reason | Pass |
| 6 | Real relay, non-streaming | HTTP 200 returned normally | Pass: 3.5s |
| 7 | Real relay, streaming | SSE passed through normally | Pass: 6.0s, content complete |

## 10. v0.4.0 final parameters

v0.4.0 release parameters: retry window 180 seconds, interval 20 seconds; single-attempt silence timeout 30 seconds; heartbeat starts after 80 seconds of silence, then one every 80 seconds with no cap. (Superseded: the default retry window is 300 seconds from V0.2.6 and 600 seconds since V0.2.10.)

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Silent upstream + streaming | Heartbeats start after 80 seconds and it wraps up when the window expires | Pass (first heartbeat at 3.1s under accelerated parameters, confirming clock-driven behavior) |
| 2 | Connection failure | Retries every 20 seconds within the window, returns 503 when the window expires | Pass (wrapped up in about 3 seconds under accelerated parameters) |
| 3 | Real relay (streaming/non-streaming) | Both normal | Pass |

## 11. Streaming write-back fix (after the 2026-10-31 review)

New self-test `tools/selftest_stream.py`; all six scenarios PASS (fake upstream on local loopback, accelerated parameters):

| # | Scenario | Expected | Observed |
|---|---|---|---|
| 1 | The upstream sends one 80-byte SSE event every 0.2s, 10 in total | Each arrives individually, maximum gap between consecutive events ≤0.7s (tolerance for high load) | ✅ span 1.80s, maximum consecutive gap 0.20s (before the fix they all arrived at once when the stream ended) |
| 2 | Send 1 event, pause 2.5s, send 1 more | A `: keepalive` keeps the connection alive, the second one arrives as usual, no truncation reported | ✅ 2 keepalives, second received, log `ok` |
| 3 | Declares `Content-Length: 100` but sends only 20 bytes | Recorded as `truncated`, no `0\r\n\r\n` appended | ✅ the client sees an incomplete stream |
| 4 | Normal streaming with two events | Fully written back + `ok` | ✅ |
| 5 | The upstream sends only 1 event and then goes completely silent (heartbeat 1s / window 2s, connection kept for 8s) | Heartbeats keep going; once cumulative silence reaches the window it wraps up and records `truncated` | ✅ `body silent 2s` + `truncated`, the client receives EOF |
| 6 | Slow client: the client does not read for 1.5 seconds while the upstream pushes 2000 events × 2KB (about 4MB) | Backpressure works, everything is received and the stream ends normally, no lost chunk and no false silence report | ✅ 2000/2000 events, terminating chunk received, log `ok` |

Also re-run: all four scenarios of `selftest_proxy_429.py` PASS; all four assertions of the heartbeat recipe in Section 4 of `docs/06-ai-maintenance-guide` pass;
the non-streaming control sends no heartbeat and returns 503 when the window expires; at that time `doctor.py` reported 11 PASS / 1 WARN (another rule for a provider that connects directly) / 0 FAIL.

## 12. v0.4.0 hardening (added during final acceptance)
| # | Scenario | Expected | Observed |
|---|---|---|---|
| 1 | chunked with 1-2 trailers | Written back normally, the next request on the same connection still gets 200 | ✅ |
| 2 | chunked with 101 trailers | Returns 400 and disconnects, leftover bytes are not taken as a new request | ✅ |
| 3 | `GET /__zp_health` | 200 + `{"name":"Zcode-Persistence"}` | ✅ |
| 4 | 8787 occupied by something other than this proxy | `ensure_proxy` writes a warning to `proxy.log` | ✅ |
| 5 | Old hook pointing at the old directory with matcher=Read | `ensure_hook` rewrites it in place to the new path/Bash, a second call makes no further change | ✅ |
| 6 | Running `X/doctor.py` after `install.py --prefix X` | It checks X, not the default directory | ✅ |
| 7 | Hook stdin containing a Chinese message meaning "no output from upstream within 95 seconds" | Hits the upstream wording (stdin is read as UTF-8, not via the system code page) | ✅ |
| 8 | Hook stdin containing invalid UTF-8 bytes | Does not affect the decision; `hook.log` records only the exception type, never the raw bytes | ✅ |
| 9 | Successful call with a stderr warning | Silent (not misjudged as a failure) | ✅ |
| 10 | State file with `count="NaN"` / `t="junk"` / `t="inf"` | Still advises a retry normally | ✅ |

## 13. Client auto-continuation + error reporting (evening of 2026-10-31)

All three self-test suites ran on local loopback with temporary databases and temporary ports; they never touch the real relay or the real session database and never actually send mail
(`send_mail` is replaced by a recorder, and `error_watch.LOG` points at a temporary directory).

| # | Self-test | Scenario | Expected | Observed |
|---|---|---|---|---|
| 1 | selftest_proxy_429 | Recovers after two 429s | 200, upstream hit 3 times | ✅ |
| 2 | Same as above | Persistent 429 | 503, error body `type=server_error / code=model_server_error / reason=server_error / retryable=true` | ✅ |
| 3 | Same as above | Recovers after three 400s | 200, hit 4 times | ✅ |
| 4 | Same as above | Persistent 400 | 503 when the window expires | ✅ |
| 5 | Same as above | **Unknown prefix (400)** | 400 + `retryable:false` + `code=invalid_request`, upstream hit 0 times | ✅ |
| 6 | selftest_stream | Event-by-event pass-through / keep-alive during mid-stream silence / short read on fixed length / normal wrap-up / silence deadline / slow client with 2000 events | Consistent with Section 12 | ✅ 6/6 |
| 7 | Same as above | **Giving up in heartbeat mode** (the upstream returns not a single byte, heartbeat starts at 1 second) | The SSE `data:` carries `retryable:true` + `model_server_error`, and the chunked terminating chunk is appended | ✅ |
| 8 | selftest_watch | A new red dot | The body contains title/model/provider/`reasons=connect` | ✅ |
| 9 | Same as above | Scanned again after it was sent | Not sent again | ✅ |
| 10 | Same as above | Historical red dot (2 hours ago) | The first round only records a baseline and sends nothing | ✅ |
| 11 | Same as above | `completed` / `interrupted` | Never reported | ✅ |
| 12 | Same as above | 8 mails already sent within one hour | `send_mail` is not called | ✅ |
| 13 | Same as above | Two sessions in the same round | Merged into one mail whose title contains "2 sessions reported errors" | ✅ |
| 14 | Same as above | The log holds only success lines (no failure whose timing matches) | The body says "not caused by the proxy exhausting its retries" ("not caused by the proxy running out of retries") | ✅ |
| 14b | Same as above | **`attempt fail` in the same period but no `gave up`** (using the pre-upgrade `HH:MM:SS` logs) | The body says "the proxy had failures in the same period but did not give up" ("the proxy had failures in the same period but has not given up yet") and lists the failure details | ✅ |
| 15 | Same as above | The same session reporting again 1 second later / after the cooldown expires | Not sent during the cooldown; sent again once it expires | ✅ |
| 16 | Same as above | The send fails | `seen` does not advance, and the retry after the backoff succeeds | ✅ |
| 17 | Same as above | `--once` (going through the full `main()`) | Prints only; no mail sent, no state file written | ✅ |

Real-machine record (not a self-test): on 2026-10-31 a self-test mail was sent with the corrected `From`;
later that evening the watcher sent 8 mails in a row for the same session (deduplication compared timestamps only), so the watcher was disabled that same day and changed to
"advance seen only after a successful send + 600-second per-session cooldown + at most 8 mails per hour + not started by default (`ZCODE_PERSISTENCE_WATCH=1`)".

## 14. Process swap with `--force` (2026-11-01)

**Real-machine run** (the only process swap with client-side evidence):

| Item | Result |
|---|---|
| How it was started | `restart_proxy_idle.py --force`, run in the foreground by this session's Bash (this session had no in-flight model requests at the time; what got cut were 5-7 upstream connections of another session) |
| Starting point | PID `<pid>`, `/__zp_health` returned the lowercase `zcode-persistence` and no `root` (old code from before the rename) |
| Reason | Another session's team kept 5-7 upstream `ESTABLISHED` connections open and `proxy.log` was silent for <1s, so the idle window never came |
| Result | <time> `kill: PID <pid> → success`; the first spawn brought up PID `<new-pid>` |
| Re-check | Only 1 LISTENING on 8787; `/__zp_health` = `{"name":"Zcode-Persistence","root":"<install-dir>"}` |
| Requests afterwards | From <time> `proxy.log` shows consecutive `ok ... status=200`; the proxy serves normally |

**Branch verification with injected stubs** (no real process killed; `netstat_rows`/`kill`/`spawn`/`health_info` replaced one at a time):

| # | Injected condition | Expected | Observed |
|---|---|---|---|
| 1 | `netstat_rows()` returns `None` | `abort`, exit code 1, `restart` not called | ✅ |
| 2 | 8787 has two LISTENING entries | `abort`, exit code 1, no process touched | ✅ |
| 3 | 8787 has no listener | `nothing`, exit code 0 | ✅ |
| 4 | A single listener | `restart` is called and the log contains the target PID / in-flight connection count / silent seconds | ✅ |
| 5 | The kill fails but the port is already free | Logs a `warn` and continues to spawn, ending with `restart: OK` | ✅ |
| 6 | The kill fails and the port is still occupied | `abort`, `spawn` called 0 times | ✅ |
| 7 | The health re-check fails after spawning and the leftovers cannot be cleaned up | Logs a `cleanup:` failure, `abort`s, and does not continue spawning | ✅ |
| 8 | Health re-check fails + `netstat_rows()` returns `None` during cleanup | `abort`s directly, no further `spawn` (`port_free()` also treats the port as occupied at this point) | ✅ |
## 15. 2026-11-01 auto-pause fix batch

### Hook false positive (V0.2.1)

| # | Case | Expected | Result |
|---|---|---|---|
| 1 | exit 1 + empty output | silent | ✅ |
| 2 | exit 1 + stderr / stdout | advise an identical retry | ✅ |
| 3 | exit 2 + empty output | advise an identical retry | ✅ |
| 4 | timeout / cancelled | advise an identical retry | ✅ |
| 5 | `status=failed` without `exitCode` | advise a retry | ✅ |
| 6 | `status=failed` + exit 0 | advise a retry | ✅ |
| 7 | upstream produced no output | advise `sleep 180` first | ✅ |
| 8 | the same command fails 4 times | 1/3, 2/3, 3/3 (with "do not stop the whole task"), 4th silent | ✅ |

### Streaming early finish, upstream errors and partial tool calls (V0.2.3–V0.2.5)

Production evidence: the `finishReason=other` events have no `rawFinishReason` field, so
the upstream sent no `finish_reason`; the client maps `undefined` to `other`. The tests
therefore focus on the missing-reason form.

Negative evidence: sending a mid-stream SSE error was classified by the client as
`ProviderBusinessError` with `retryable=false`, and the turn still failed. The final
design is an internal re-request, not a client-visible error.

| # | Case | Expected | Result |
|---|---|---|---|
| 1 | reasoning then literal `finish_reason=other`, no content/tool call | discard the attempt and re-request; the client never sees `finish_reason`; log `early finish` + `retry after early finish` | ✅ |
| 2 | content + `finish_reason=stop` | pass through, log `ok` | ✅ |
| 3 | content + `finish_reason=other` | pass through (avoid duplicate content), log `ok` | ✅ |
| 4 | reasoning then `[DONE]` with no `finish_reason` | mark early before `[DONE]`; the client never sees `[DONE]`; re-request | ✅ |
| 5 | reasoning then clean EOF with no `[DONE]` and no `finish_reason` | mark early at EOF and re-request | ✅ |
| 6 | content then `[DONE]` with no `finish_reason` | pass through, log `ok` | ✅ |
| 7 | first connection ends early (missing reason), second returns content + stop | client receives `final answer`, `stop`, `[DONE]`, no error; log early + retry + ok | ✅ |
| 8 | same but the first connection ends with literal `finish_reason=other` | client receives `literal answer`, `stop`, `[DONE]`, no error; log `early finish reason=other` + retry | ✅ |
| 9 | reasoning then an SSE `{"error":...}` (code=stream_truncated), no content/tool call | swallow the event and re-request; the client never sees the error; log `early finish upstream error: stream_truncated` + retry | ✅ |
| 10 | an SSE error event after content | forward unchanged, no retry (retrying would duplicate content); log `ok` | ✅ |
| 11 | the stream ends mid-tool-arguments (no `finish_reason=tool_calls`) | buffer not written out → discard and re-request; the client only receives the complete tool call, partial args never leak; log `early finish incomplete tool call at DONE/EOF` + retry | ✅ |
| 12 | a complete tool call + `finish_reason=tool_calls` | buffer flushed at finish time, passed through unchanged, no retry; log `ok` | ✅ |

Together with the original 1–7 cases, the twelve new scenarios (8–19) make 19 in total; all pass;
`selftest_hook.py`, `selftest_proxy_429.py`, `selftest_watch.py` and `selftest_ensure.py`
also pass.

## 16. V0.2.6 — generic routing, read-error retry, 23 scenarios

| # | Case | Expected | Result |
|---|---|---|---|
| 5 | upstream goes silent (short timeouts) | early finish at the window, then a retryable give-up; never an empty successful end | ✅ |
| 20 | reasoning then a TCP RST from upstream (SO_LINGER 0) | nothing written out → early and internal re-request; second attempt returns content | ✅ |
| 21 | `POST /cg/v1/chat/completions` (fake upstream echoes request line and Host) | forwards `POST /v1/chat/completions`, Host includes the non-default port | ✅ |
| 22 | `/p/<b64(baseUrl=/relay?base=1)>` plus a request query | path becomes `/relay/v1/chat/completions?base=1&api-version=1`, Host includes the port | ✅ |
| 23 | `/p`, `/p/`, non-base64, non-http(s), invalid port | all return 400 `bad /p/ route token`, no retry loop and no 500 | ✅ |

`selftest_stream.py`: 23 scenarios pass. `selftest_route.py`: 13 checks pass —
encoding round-trip; already-proxied, hostless, non-http(s), invalid-port and
userinfo URLs skipped; sidecar and backup; idempotence; `--restore`; proxy-root
`http://127.0.0.1:8787` not re-encoded; `08787` parsed as 8787; old proxy
(missing `p_route`), unreachable health, empty or mismatched `root` do not
migrate; uninstall restores `/p` from the sidecar (dry-run writes nothing).

Also passing: `selftest_hook.py` (11), `selftest_proxy_429.py` (5),
`selftest_watch.py` (12), `selftest_ensure.py` (serialization).

## 17. V0.2.7 — reset after content, 32 scenarios

Two production failures share one recovery path:

- `tool_args_invalid`: text had been written, then the upstream ended mid-arguments;
  V0.2.5 flushed the incomplete buffer.
- `upstream_error` (`request=<request-id>`, `<model>`): the gateway sent
  `{"error":{"message":"Upstream request failed","type":"upstream_error"}}` after
  67 characters; V0.2.4 forwarded it, and the client wrapped it in
  `ProviderBusinessError` (`retryable=false`).

| # | Case | Expected | Result |
|---|---|---|---|
| 17 | text, then an SSE error | error not forwarded; `reset client for recovery (upstream error after content: …)`; client receives RST; no internal re-request | ✅ |
| 24 | text, incomplete tool args, clean EOF | zero bytes of the partial call; RST; no chunked terminator | ✅ |
| 25 | same, with `finish_reason=tool_calls` and `[DONE]` | invalid JSON is never released; RST | ✅ |
| 26 | same, upstream RSTs mid-arguments | read-error branch also RSTs (FIN alone is not retryable) | ✅ |
| 27 | multi-index tool calls (index 1 first, then a 0/1 mixed event) | arrival order preserved; client-side concatenation yields `{}` and `{"a":1}` | ✅ |
| 28 | text, no tool call, upstream RST | pure-text truncation also RSTs | ✅ |
| 29 | CPU of the proxy process after a reset | <0.3 s CPU in a 0.6 s window | ✅ 0.000 s |
| 30 | `NaN` in arguments | rejected like the client's `JSON.parse` | ✅ |
| 31 | legacy `function_call` (no index) | validated under `-1` and passed through | ✅ |
| 32 | empty `arguments` | treated as incomplete; RST | ✅ |

`selftest_stream.py`: 32 scenarios pass. The other suites (hook 11, 429 5, watch 12,
route 13, ensure serialization) also pass. A Node/undici probe against the real proxy
receives `TypeError: terminated` with cause `read ECONNRESET` after 61 content bytes;
the client's `sqa()` matches. Independent review: overall 4.7/5, code 4.4/5.

## 18. V0.2.8 — retry_after from the error body

Some gateways (Cloudflare in particular) put the wait hint in the 502/503 body instead
of the `Retry-After` header. The proxy now probes the first 64 KB of every non-2xx body
for `"retry_after":N` or `Retry-After: N`, takes the larger of header/body, and keeps the
60-second cap. The probe caps the socket timeout at 1 second and parses once at
EOF / 64 KB / budget, so a number split across chunks is not truncated; the body is never
logged.

`selftest_proxy_429.py`: 12 scenarios pass (5 existing + body JSON hint / cap / text form /
split number / 64 KB bound / empty body / stall budget). The body-hint case also asserts
the marker string is absent from `proxy.log`. Full regression: hook 11, stream 32,
watch 12, route 13, ensure serialization. Independent review (2026-11-04, independent
subagent review): overall 4.8/5, code 4.8/5.

## 19. V0.2.9 — relay hosts moved to local upstreams.json

The public tree must not contain real relay hosts. `UPSTREAMS` now holds placeholders;
`apply_local_upstreams()` reads `upstreams.json` next to `retry_proxy.py` at import time,
validates host/port/scheme, and can add new prefixes (`/xx`). The file is git-ignored and
excluded from the release asset; `upstreams.example.json` documents the format.

`selftest_upstreams.py`: 8 checks pass (placeholder default, override `/ap`, add `/xx`,
invalid entries ignored, installer host lookup, explicit prefix wins, unknown host returns
None, unsupported prefix returns None). Full regression: hook 11, 429 12, stream 32, watch 12, route 13,
ensure serialization. No default retry parameter changed.

## 20. V0.2.10 — longer window + one real client retry

Field evidence (2026-11-06): a request carrying ~420k input tokens spent 355 s in five
silent attempts and gave up; the same upstream answered normally again
157 s later. A 5-minute window cannot outlast that kind of stall, and a 30-second silence
cutoff discards slow-but-healthy large requests.

- `PROXY_RETRY_WINDOW` 300 → 600 s; `PROXY_SILENCE_TIMEOUT` 30 → 60 s.
- After the window is exhausted **and** the 200 + heartbeats were already sent, the
  proxy writes one zero-width `content` delta (`chatcmpl-zp-anchor`), waits
  `PROXY_ANCHOR_SETTLE_MS` (default 300 ms), then resets the client connection with
  `SO_LINGER=0`. The settle delay is required: an immediate reset lost the anchor in
  11 of 43 measured runs because `SO_LINGER=0` drops unread peer data. ZCode only resumes a stream when it has
  discarded text **and** sees `ECONNRESET`; with heartbeats alone the discarded byte
  count is 0, so a bare RST never triggered a retry.
- `PROXY_RETRY_ONCE_TTL` (default 900 s): the first exhaustion of a session gets the
  anchor + RST, later ones fall back to the ordinary retryable SSE error. Without this
  gate on this branch the client's 10 retries would multiply with the proxy window;
  `reset_for_recovery` keeps resetting whenever incomplete content requires it.
- `reset_for_recovery` now delegates socket teardown to a shared `Handler._reset_client`;
  the V0.2.7 RST paths are unchanged.

`selftest_stream.py`: 34 scenarios pass, including the two new ones (anchor + RST when
an `x-session-id` is present; a second exhaustion in the same session must not RST).
Full regression: hook 11, 429 12, watch 12, route 13, upstreams 8, ensure serialization.

## 21. V0.2.11 release record — original early-tool behavior (historical)

At the V0.2.11 release, an upstream ending an SSE stream with a partial tool-call name or
JSON arguments before any client-visible content used a session-token-gated retry:
with a session id the proxy claimed the one-shot token, wrote the zero-width anchor, waited
for `PROXY_ANCHOR_SETTLE_MS`, and reset the connection; without a session id, or once the
token was consumed, it returned a retryable SSE error. This section records that release
behavior only; it is superseded by the V0.2.12 behavior in Section 22.

The original `selftest_stream.py` release record listed 35 scenarios, including one
end-to-end anchor/reset followed by a complete tool call. It is retained here for release
traceability, not as a statement of the current test run.

## 22. V0.2.12 candidate validation — early incomplete tool calls

Whenever an upstream ends with an incomplete buffered tool call before any client-visible
content, the proxy returns `early_tool` and writes the zero-width `chatcmpl-zp-anchor`,
waits `PROXY_ANCHOR_SETTLE_MS`, then resets the client connection with `SO_LINGER=0`.
This applies on every occurrence, including when no session id is present and when the
same session has already had an early-tool reset. The proxy does not claim
`PROXY_RETRY_ONCE_TTL`, return a retryable SSE business error for these cases, or replay
the unchanged request internally. ZCode's own bounded stream-recovery budget limits the
client retries. The long-window exhaustion branch remains separately gated by
`PROXY_RETRY_ONCE_TTL`.

Verification on 2026-11-11: `py_compile` passed; `selftest_stream.py` passed all 36 scenarios,
including no-session early-tool anchor + RST, two repeated early-tool RSTs followed by a
successful third tool call, anchor-write failure with transport reset, second long-window
exhaustion retaining its token behavior, and 0.000 s CPU increase in the 0.6-second post-RST
probe. The ten-round long-window anchor check was timing-sensitive: the first run observed
9/10 anchors, then the same full command after a three-minute wait observed 10/10 anchors
and 10/10 resets. Treat this as a successful rerun with a recorded intermittent miss, not as
proof of deterministic delivery. Full regression passed: hook 11, 429 12, watch 12, route 13,
upstreams 8, and ensure serialization. `doctor.py`: 18 PASS / 0 WARN / 0 FAIL on the existing V0.2.11 installation before upgrade; V0.2.12 is not installed locally, so its post-install health check has not been performed. `git diff --check` passed. The installed client bundle sets its stream-recovery budget to 10,
but a real ZCode UI recovery run was not performed; UI completion state remains unverified.
No release asset or GitHub release has been created yet.
