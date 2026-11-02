# 00 Overview

**Project name: Zcode-Persistence** (ZCode failure-retry toolkit)

It adds three things to ZCode: **automatically suggest a retry when a tool fails**, **automatically resend when a model request fails**, and (off by default) **email the reason when a session errors**.

- Version: V0.2.4 patch release (build line 0.4.0)
- Build date: 2026-11-02 (V0.2.4: absorb upstream SSE `error`/`stream_truncated` and retry internally; V0.2.3: internal retry for early-finished streams; V0.2.1: hook false-positive fix)
- Applies to: ZCode Desktop (Windows), Python 3.9+
- Dependencies: Python standard library only; in proxy mode, TLS verification prefers certifi when it is installed

---

## Two modes: know the difference first

| | Mode A: failure-suggestion hook | Mode B: local retry proxy |
|---|---|---|
| What it solves | After a **tool call fails**, it prompts the model to retry as-is | After a **whole-round model request fails**, it resends automatically |
| Can it resend automatically? | No, it only suggests | **Yes, fully automatic** |
| Coverage | Bash tool only | Every model request that passes through it |
| Side effects | None | Requests depend on the local proxy process; if the proxy stops, the model is unusable |
| Install complexity | Low (one config file) | Medium (also changes the provider baseUrl) |

**Just want a low-risk trial → install Mode A.**
**Really fed up with the "upstream has no output for 95 seconds" pop-up → install Mode B.**

### The optional third piece: error reporting (off by default)

`src/error_watch.py` watches `session.last_outcome` in the ZCode session database; when it sees `error`
(red dot in the left session list / notification area) it emails "why this failure happened" to `your-email@example.com`:

- Only `error` counts. `completed` (normal finish) and `interrupted` (user stopped / paused) are never reported.
- The reason comes from the `gave up` records in `proxy.log` that **line up with the error moment** (15 minutes either side);
  if none line up it says so plainly ("not caused by the proxy exhausting retries") instead of inventing a cause.
- Mail goes out through the outlook MCP (stdio JSON-RPC of `ms-365-mcp-server`); the sender is always
  `your-sender@example.com` (using the account's own name `your-email@example.com` as From gets discarded on the QQ side).
- Anti-spam: at most one report per session per 10 minutes; at most 8 mails per hour; a failed send does not advance state and is retried 1 minute later.
- **Not started by default**: only launched by SessionStart when the environment variable `ZCODE_PERSISTENCE_WATCH=1` is set.
  Run it manually with `python error_watch.py` (`--once` only prints, `--test-mail` sends a self-test mail).

---

## Quick start

### Mode A (hook only)

```bash
python tools/install.py
python tools/doctor.py
```

Open a new ZCode session and it takes effect.

### Mode B (hook + proxy)

```bash
# AP channel (upstream-a.example.com): prefix auto-detected as /ap
python tools/install.py --with-proxy --provider-id new-provider

# upstream-b channel (upstream-b.example.com): prefix auto-detected as /cm
python tools/install.py --with-proxy --provider-id new-provider-3

# If the original address cannot be identified, specify the prefix explicitly or the installer refuses to run
python tools/install.py --with-proxy --provider-id my-relay --proxy-prefix ap

python tools/doctor.py
```

**Prefix selection rule**: when `--proxy-prefix` is omitted, the prefix is derived from the original `baseUrl` — if it contains `upstream-b.example.com` the prefix is `/cm`, if it contains `upstream-a.example.com` it is `/ap`; if neither matches the installer **errors out and makes no changes at all**. It never silently defaults to some upstream, which would send channel A's requests to channel B.

After opening a new ZCode session, `doctor.py` should report "provider goes through the proxy" and "proxy port listening".

### Uninstall

```bash
python tools/uninstall.py            # undo hook and provider changes, keep script files
python tools/uninstall.py --purge    # also delete the install directory
python tools/uninstall.py --dry-run  # show what it would do
```

---

## Directory layout

```
projects/zcode-persistence/
├─ AGENTS.md                Hard constraints for AI maintainers (read this first)
├─ README.md                Index: documentation and directory navigation
├─ VERSION                  Version number
├─ CHANGELOG.md             Change log
├─ src/
│  ├─ retry_hook.py         Hook: PostToolUse primary + PostToolUseFailure fallback (mode A)
│  ├─ retry_proxy.py        Local retry proxy (mode B)
│  ├─ ensure_proxy.py       SessionStart hook: keeps the proxy running; error watch is off by default
│  └─ error_watch.py        Error reporting: red dot → email (off by default; needs ZCODE_PERSISTENCE_WATCH=1)
├─ tools/
│  ├─ install.py            Install (idempotent, automatic backup)
│  ├─ uninstall.py          Uninstall (exact restore)
│  ├─ doctor.py             Health check
│  ├─ selftest_hook.py      Self-test: ten hook decision cases (exit 1 with no output is not a failure)
│  ├─ selftest_proxy_429.py Self-test: five retry-semantics scenarios (including 400 not retryable)
│  ├─ selftest_stream.py    Self-test: seven streaming write-back scenarios (including the retryable error body on give-up)
│  ├─ selftest_watch.py     Self-test: 12 error-reporting assertions (cooldown/rate limit/send failure/cause attribution/--once does not persist)
│  └─ restart_proxy_idle.py Restart the process: only in an idle window (--force switches immediately); never start a new one until the old one is gone
├─ docs/
│  ├─ 00-overview.md        This document: what it is, how to use it, limitations
│  ├─ 01-install-and-rollback.md
│  ├─ 02-maintenance.md
│  ├─ 03-architecture.md
│  ├─ 04-test-record.md
│  ├─ 05-changelog.md
│  ├─ 06-ai-maintenance-guide.md  Complete handover guide: code map/invariants/test recipes/fault localization
│  └─ 07-ai-invariants.md   Hard-constraint quick reference
└─ diagrams/
   └─ architecture.md
```

---

## Mode A: rules of the failure-suggestion hook

Mount points: ZCode's **`PostToolUse`** (primary) + **`PostToolUseFailure`** (fallback), `matcher = "Bash"`.

> Why not use only `PostToolUseFailure`: in practice this client does not dispatch that event for "interrupted / timed-out tool calls";
> only `PostToolUse` always arrives, and it carries `exitCode` / `timedOut` / `stderr`.
> Both are mounted, deduplicated by `toolCallId`, so the same call is not suggested twice.

**Scope of the retry suggestion: any failure (single exception: exit 1 with no output)**

Since v0.4.0 there is no filtering by error type any more — as soon as a Bash call fails (non-zero exit code, genuine timeout, cancelled, or a status that is explicitly failed/error), a retry is suggested. Exception: exit code 1 with completely empty stdout/stderr is a predicate command's normal negative result (grep -q no match, diff --quiet differences, false test), not a failure. The old "do not retry on permission denied / no such file / syntax error" whitelist has been removed.

| Situation | Detection basis | Suggested wording |
|---|---|---|
| Timeout | `timedOut=true` (even if the output is empty) | Retry the same command as-is |
| Upstream produced nothing | The error text hits `UPSTREAM_PATTERNS` (upstream_deadline / turn execution failed / the Chinese phrase meaning "no output" / overloaded / provider_code / capacity) | `sleep 180` first, wait 3 minutes, then retry (set that command's timeout to 200000 ms or more) |
| Every other failure | Non-zero exit code / status=failed / cancelled | Retry the same command as-is |
| Success | Exit code 0 and status completed/success/ok | Silent |

`UPSTREAM_PATTERNS` only affects the wording (whether to wait 3 minutes first); it **does not affect whether a retry is suggested**.

**Attempt control**: the same command is suggested at most 3 times; once more than 10 minutes have passed since the last failure the counter resets to zero; state files older than 1 day are cleaned up automatically.

**Safety boundaries**: the hook never blocks a session and exits 0 on every path; it emits a single `additionalContext` sentence (visible to the model; the model cannot see `systemMessage`, a trap already hit in v0.3.0); before matching it strips `tool_input` and the metadata fields (`session_id`, `toolCallId`, `requestId`, etc.): `UPSTREAM_PATTERNS` is only used to decide "whether to wait 3 minutes first" and must not be disturbed by words in the command text or in the IDs.

---

## Mode B: rules of the local retry proxy

```
ZCode ──► 127.0.0.1:8787 ──► real relay ──► upstream
Resend on any error: up to 3 minutes, one attempt every 20 seconds; give up only when the window expires
```

The path prefix selects the upstream:

| Prefix | Target |
|---|---|
| `/ap/...` | `https://upstream-a.example.com/v1/...` |
| `/cm/...` | `https://upstream-b.example.com/v1/...` |

So the provider's baseUrl has to become `http://127.0.0.1:8787/ap/v1` (or `/cm/v1`).

**The three situations that are retried**

1. Cannot connect, or the connection is dropped
2. The upstream returns **any non-2xx** (including 4xx; the spec is to retry on any error)
3. The upstream emits not a single byte within 30 seconds

**Retry count**

Not by count but by time window: **keep retrying for 3 minutes, once every 20 seconds** (about 9 attempts inside the window), identical for streaming and non-streaming.
Wait **20 seconds** between two attempts; if the upstream returns a longer `Retry-After`, honour that instead (capped at 60 seconds). When the window expires no new attempt is started;
the attempt already in flight is allowed to run to completion (connect 10 s + send 90 s + wait for headers 30 s maximum), so the total duration may be slightly longer than the window.
In practice failures are mostly **HTTP 429 (concurrency saturated)**; waiting a few seconds before resending almost always gets through.


**What is returned on give-up (2026-10-31 change, important)**

Once the window is exhausted the proxy no longer returns `upstream_unavailable` to the client, but:

```json
{"message": "retried continuously for ... seconds and still failed (...)", "type": "server_error",
 "code": "model_server_error", "reason": "server_error", "retryable": true}
```

Reason: the ZCode client (`z7a()` in `zcode.cjs`) only accepts
`retryable===true`, `code ∈ {model_request_timeout, model_rate_limited, model_server_error, model_network_error}`
or `reason ∈ {stream_idle_timeout, rate_limited, server_error, network_error, timeout}`.
The old error code `upstream_unavailable` is in none of those sets, so the client judges it non-retryable, ends the whole round immediately and shows the red dot.
After the change the client uses its own stream-recovery retry (at most 10 times) and carries `previous-message-anchor` to continue writing from the previous content,
the equivalent of automatically sending a "continue". **This only applies to 503 (the proxy exhausted its retries)**; for 400 (the client itself wrote a wrong prefix / request body)
the proxy returns `invalid_request` + `retryable:false`, so that deterministic errors are not resent 10 times.

If a streaming request has already entered heartbeat mode (the 200 has been sent), giving up can only stuff the same error body into an SSE `data:` event,
with a chunked terminating block appended at the end — scenario 7 in `tools/selftest_stream.py` watches exactly this part.

**Heartbeat keep-alive**

When a streaming request reaches **80 seconds** with no upstream input at all, the proxy writes an SSE comment line (`: keepalive`) into the conversation:
the client ignores the content but can see that bytes are arriving, so it does not abort outright because of "no output for 95 seconds".
This works equally after the response headers have come back: when the upstream stalls mid-stream, a heartbeat is added every 80 seconds to keep waiting,
and truncation is only declared after 3 minutes of cumulative silence (content already received is not lost).
**Precondition**: the response must be `Content-Type: text/event-stream` (every normal streaming request is);
with any other type, inserting a comment line would corrupt the body, so only the 30-second silence truncation applies.
A slow-reading client only makes the whole stream slower (the proxy uses a queue to create backpressure) and never loses chunks;
a half-open connection that reads nothing and never disconnects blocks forever (until reading resumes or TCP reports an error) — that is the price of having no client write timeout.
After that another heartbeat is added **every 80 seconds** without input, **with no cap on the number of heartbeats**. The heartbeat is driven by an independent clock and does not wait for an attempt to fail before being sent.

**Early finish is retried**: if the upstream ends a streaming response before emitting any text or tool call — with `finish_reason=other`, an unknown value, or (the common production case) no `finish_reason` at all — the proxy withholds the ending event, discards that upstream attempt, and immediately re-requests it, continuing the same client response (V0.2.3), so the client sees the stream continue instead of ending the turn silently. The client maps a missing `finish_reason` to `other`, which is why watching only for the literal string misses the real case. An ending that arrives after real content is passed through unchanged, because resending would duplicate what the user already saw. The same rule covers an upstream SSE `{"error":...}` event (production: `stream_truncated`): with no text or tool call yet the event is swallowed and the attempt is re-requested; after real content it is forwarded unchanged (V0.2.4).

**Not retried**: a stream break after bytes have already been written back to the client — resending at that point would duplicate content. In this case the proxy does not write the chunked terminating block, so the client sees the stream did not end normally and knows it was truncated instead of mistakenly believing it finished.

**Known requirements**

- The relay's Cloudflare blocks user agents such as `Python-urllib` and returns 1010; the proxy automatically substitutes a normal browser UA.
- TLS verification prefers certifi's CA bundle; the Windows built-in root store is missing some roots (such as SSL.com), which causes verification failures.
- Every attempt has its own independent timeouts: connect 10 s, send the request body 90 s (the payloads are large, so the connect timeout cannot be reused), wait for the first byte 30 s.
- No request/response content is logged; only status lines are written (time, path, status code, byte count, first-byte latency).

---

## How to troubleshoot

```bash
python tools/doctor.py
```

It checks each item in turn: whether the scripts are all present, whether the interpreter exists, whether the hooks are registered, where the provider points, whether the proxy port is listening, and it prints the last 5 lines of `proxy.log`.

**Three typical failures**

| Symptom | Cause | Action |
|---|---|---|
| The model cannot connect at all in a new session | The proxy is not running, yet the provider already points to 8787 | Run `src/retry_proxy.py` manually, or check the SessionStart hook; if you need it right now, roll back with `uninstall.py` |
| The hook does not fire | No new session opened / `hooks.enabled` turned off / a tool other than Bash failed | Look at the `doctor.py` output; the hook only handles Bash |
| The proxy log shows attempt fail but it finally succeeds | Normal, it means the proxy is resending | Nothing to do; look at the `ok ... first=x.xxs` line |
| The proxy log shows `truncated` | The stream broke after writing back had started, so it cannot be retried | Expected; the client sees an incomplete stream |
| The proxy log shows `early finish ...` + `retry after early finish` | The upstream ended before producing content | Expected; the proxy discarded that attempt and re-requested upstream, so the client just sees the stream continue |

---

## Boundaries and limitations (must read)

1. **Mode A cannot really resend.** The hook can only inject a suggestion, and the model decides whether to retry. If the model does not listen, nothing happened.
2. **Mode B cannot cover every failure.** It covers "the request failed before returning data" and "the upstream ended with `finish_reason=other` before producing any content". If the failure happens after content has been written back, the proxy cannot retry without duplicating that content.
3. **The 95 seconds is the client timeout.** A streaming request gets a heartbeat at 80 seconds without data, so the 3-minute window holds; non-streaming requests cannot take heartbeats, so the client may give up at its own timeout first.
4. **The provider config may be rewritten by the ZCode UI.** If you have changed channel settings in the UI, `baseUrl` may have been overwritten back to the official address, in which case just run `install.py --with-proxy` again.
5. **Paths of the two config files**: `~/.zcode/cli/config.json` (hooks) and `~/.zcode/v2/provider_config.json` (provider). The installer touches only these two places, and backs both up before changing them.
6. **Error reporting does not run by default.** `error_watch.py` is installed into the install directory, but SessionStart only starts it when `ZCODE_PERSISTENCE_WATCH=1` is set;
   it decides on the red dot by polling `session.last_outcome` in `~/.zcode/cli/db/db.sqlite`, so a schema change in ZCode will break it —
   when broken it writes `db: failed to query the session DB` to `error_watch.log` instead of silently pretending to be alive.
7. **The mail sender cannot be changed.** The outlook MCP account is `your-email@example.com`, but `From` must be written explicitly as
   `your-sender@example.com`; when it is written as the account's own name the mail only stays in "Sent" and the QQ side never receives it (verified on 2026-10-31).
8. **This project is not an official component**; the ultimate fallback on failure is always `uninstall.py` + the config backups.
9. **The following two things have not been tested in practice, only asserted on this side**: the real ZCode client's
   "automatic continuation" for 503 / SSE error bodies (it can only be observed the next time retries are genuinely exhausted), and the recovery behaviour of the MCP send-failure path.
   The actual process swap performed by `restart_proxy_idle.py` has been verified on 2026-11-01 02:58 (old process terminated, single listener, correct `root`).

---

## Version and maintenance

**Before taking over maintenance, read `AGENTS.md` (hard constraints) and `docs/06-ai-maintenance-guide.md` (full manual).** The latter contains the code map, the complete list of invariants, directly runnable test recipes, a fault-localisation table and a regression-prevention checklist of past traps.


- Update `VERSION` and `CHANGELOG.md` with every change.
- Adding wording rules: change only `UPSTREAM_PATTERNS` at the top of `src/retry_hook.py` (on a match it suggests waiting 3 minutes first). Since v0.4.0 there is no longer a "decide by error type whether to retry" list: every failure is retried (except exit 1 with no output). Re-run `install.py` afterwards (idempotent, it overwrites the scripts).
- Adding an upstream: change `UPSTREAMS` in `src/retry_proxy.py` and add the matching prefix in `tools/install.py`.
- After any change you must run the cases in `docs/04-test-record.md`, and only release once they all pass.
