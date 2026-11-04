# 02 Maintenance

## One command for day-to-day checks

```bash
python tools/doctor.py
```

Checks: scripts all present, interpreter exists, `hooks.enabled`, the three hook entries (`PostToolUse` primary + `PostToolUseFailure` fallback + `SessionStart`; the first two require `matcher == "Bash"`, all three require the script path to really exist), the provider target, the proxy port, **the running proxy version against the installed `VERSION`**, **whether the running proxy parameters match the current script**, error-watch status, and the tail of the log. If there is a FAIL, act on the path it points at; ignore the rest.

The "proxy runtime parameters" check exists specifically to catch the "changed the code but forgot to restart the proxy" trap: it compares the four values `retry <N>s window` / `every Ns` / `silence=Ns` / `heartbeat>=Ns` from the last startup line in `proxy.log` against the defaults in the script source, one by one, and issues a WARN if any single one differs.

---

## Adjusting error handling

Since v0.4.0 there is **no error-type classification**: any failed Bash call gets a retry suggestion (single exception: exit 1 with completely empty output), at most 3 times (a 4th failure is no longer suggested). This is the user's explicit specification — do not add the FATAL filter back.

The only pattern table left is `UPSTREAM_PATTERNS` (at the top of `src/retry_hook.py`): on a hit, the suggestion is to `sleep 180` and wait 3 minutes before resending, because for these "upstream produced nothing" errors an immediate resend will basically fail again. To extend it, add to this one list only.

The rules are Python regular expressions and are case-insensitive. After changing them you must:

1. Feed a sample in by hand to verify (see "Local verification" below)
2. Update `CHANGELOG.md`
3. Re-run `python tools/install.py` to overwrite the installed scripts

**Note**: only `UPSTREAM_PATTERNS` affects the wording (wait 3 minutes); it does not affect "whether to retry" — every failure is retried (except exit 1 with empty output), and that behavior must not be steered by the pattern table.

---

## Local verification (testable without installing)

The hook script reads JSON from stdin, so you can feed it a sample directly:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"curl x"},"error":"operation timed out"}' \
  | python src/retry_hook.py
```

- Output = judged retryable
- No output = let through

To isolate the counters, add the environment variable:

```bash
ZCODE_RETRY_HOOK_STATE_DIR=/tmp/rh-test python src/retry_hook.py < sample.json
```

**Four sample classes that regression must cover**

| Sample | Expected |
|---|---|
| `operation timed out` | Output, without sleep |
| `upstream_deadline` | Output, including sleep 180 |
| `permission denied` | **Output** (no type filtering since v0.4.0) |
| Same command 4 times in a row | Output for the first 3, no output on the 4th |

---

## Adding a new upstream relay

**V0.2.6 and later: no code change needed.** Run `python src/route_providers.py`;
it rewrites each provider's baseUrl to `http://127.0.0.1:8787/p/<base64url(original)>`
and the proxy forwards to the decoded origin. New providers are migrated
automatically on the next session start.

If you really need a fixed prefix (for example when the baseUrl cannot be edited):

1. Edit `UPSTREAMS` in `src/retry_proxy.py`:

   ```python
   UPSTREAMS = {
       "/ap": ("upstream-a.example.com", 443),
       "/cm": ("upstream-b.example.com", 443),
       "/cg": ("127.0.0.1", 27891, "http"),
       "/xx": ("new-domain.example", 443),  # added
   }
   ```

2. Add the corresponding entry to the `PREFIXES` dict in `tools/install.py` (the key is the prefix name, the value is the full baseUrl); the prefix name automatically becomes a valid value for `--proxy-prefix`.
3. Restart the proxy (see below).

---

## Tunable parameters (environment variables)

All of the proxy's timing can be overridden with environment variables; changes take effect after a restart:

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_RETRY_WINDOW` | `300` | Duration of the retry window (seconds). Once it is reached no new attempts are started; an attempt already in flight is allowed to finish, so the actual duration may slightly exceed the window |
| `PROXY_RETRY_INTERVAL` | `20` | Interval between two attempts (seconds) |
| `PROXY_MAX_ATTEMPTS` | `200` | Fuse against runaway retries; not reached in normal operation |
| `PROXY_SILENCE_TIMEOUT` | `30` | Seconds a single attempt waits for the first byte |
| `PROXY_HEARTBEAT_START` | `80` | How many consecutive seconds without upstream input before heartbeats start |
| `PROXY_HEARTBEAT_INTERVAL` | `80` | While upstream is silent, send one extra heartbeat every N seconds, unlimited count |
| `PROXY_CONNECT_TIMEOUT` | `10` | Connect timeout (seconds) |
| `PROXY_SEND_TIMEOUT` | `90` | Timeout for sending the request body (seconds) |
| `PROXY_RETRY_AFTER_CAP` | `60` | Upper bound (seconds) on how far the upstream `Retry-After` (header or error body) is honored |
| `PROXY_PORT` | `8787` | Listening port |

Example: move heartbeats forward to 60 seconds and repeat them every 60 seconds, shrink the retry window to 60 seconds, and try every 10 seconds:

```bash
PROXY_HEARTBEAT_START=60 PROXY_HEARTBEAT_INTERVAL=60 PROXY_RETRY_WINDOW=60 PROXY_RETRY_INTERVAL=10 python src/retry_proxy.py
```

## Restarting the proxy

**First confirm no request is in flight**: ZCode's own model requests go through this proxy, and an answer that is being generated would be cut off.
How to check (Windows): `netstat -ano | findstr <proxy PID>`; if there are still `ESTABLISHED` lines connected to an external address (not 127.0.0.1),
requests are being processed, so wait for them to finish before touching anything. `FIN_WAIT_2` is leftover teardown state and does not count as busy.

**Do not hand-write `taskkill`**. Windows' `SO_REUSEADDR` allows two processes to listen on 8787 at the same time,
and while the old process is alive the new one can still bind and `/__zp_health` still answers, so "the switch looks successful" while the old code is actually running.
Use the ops script: it only acts in an idle window with no in-flight requests, and it only starts the new process after confirming the old process is gone **or port 8787 has been released**
(the port is authoritative: if the kill fails but the port is empty, continue; if the port is still occupied, give up):

```bash
python "C:/Program Files (x86)/AI/Zcode-Persistence/restart_proxy_idle.py"
# or run it in the background (your own requests go through the proxy; running in the foreground blocks you)
```

The script writes `restart.log` in the same directory on every action: `idle:` means it waited for the window, `kill:` is the process-kill result,
and only `restart: OK（… root=…）` means the new code really took over (`root` is the script's own directory).
`abort:` means the old process did not die cleanly, or that whatever is on 8787 is not this proxy — in that case it will not start a new process and manual handling is required.

**When no idle window can be waited for** (for example, a subagent in another session keeps holding upstream connections): add `--force` to swap processes immediately.

```bash
# run in the background or another session: --force cuts in-flight requests, including your own
python "C:/Program Files (x86)/AI/Zcode-Persistence/restart_proxy_idle.py" --force
```

`--force` only skips "waiting for the idle window" (the three criteria: in-flight connections, `proxy.log` silence, `MIN_ALIVE`),
and after `kill:` it must still satisfy "old process gone or port 8787 released", exactly one listener, and `root` pointing at the install directory — not one item fewer.
**Cost**: in-flight requests get cut off and the corresponding session receives one connection reset; the client's `ECONNRESET` recognition has been verified with a Node/undici probe, but whether a real ZCode turn resumes writing on its own has not been measured end-to-end. Before `--force` starts it writes the target PID, the number of in-flight connections and the seconds of log silence into `restart.log`,
so the blast radius can be checked afterwards. The first hot update on 2026-11-01 was done exactly this way: the new PID came up and immediately caught the requests that followed.

When the install directory is empty (nothing is listening on the port) no restart is needed; the session-start hook of the next session will bring it up on its own.

---

## Reading the logs

| File | Location | Contents |
|---|---|---|
| Hook log | `%TEMP%\Zcode-Persistence\hook.log` | `advise: n/3`, `cap: limit reached`, `skip: reason`, `error: exception` |
| Hook state | `%TEMP%\Zcode-Persistence\state.json` | Counters keyed by "session + command"; safe to delete to reset |
| Proxy log | `<install directory>\proxy.log` | `ok path status=200 bytes=... first=x.xxs`, `attempt fail (...)`, `early finish ...` + `retry after early finish ...` (discarded and re-requested internally), `reset client for recovery (...)` (V0.2.7: the client connection was reset so the client can retry with its anchor), `truncated ...` |

An `attempt fail` followed by `ok` in the log is a good sign — the resend succeeded. Only `gave up after N attempts in Ns` is a genuine failure (it only stops once the retry window expires).

---

## Release process

1. Change the code
2. Update all four version fields (`VERSION`, `tools/install.py`, `PROXY_VERSION`, `clientInfo.version`; semver: a bug fix bumps 0.0.1, a feature bumps 0.1.0)
3. Update `CHANGELOG.md`, stating clearly "what changed + why"
4. Run every case in `docs/04-test-record.md`
5. Repackage the ZIP and move the old version to the local history directory (do not create a `history/` directory inside the repo; release packages go through Releases) — never overwrite, never delete
6. On the target machine, `install.py` does an overwrite install (the scripts are replaced, and the hook entries in the config are not duplicated)

---

## When to stop

If any of the following happens, the approach is getting worse and you should roll back instead of patching further:

- The proxy crashes repeatedly, and `proxy.log` shows slabs of `attempt fail` with no `ok`
- The provider `baseUrl` has been changed back by the ZCode UI more than twice
- "Cannot reach the model" appears mid-session while `doctor.py` shows the port is not listening
- You start needing to restart the proxy manually every day

The rollback commands are the third tier in `01-install-and-rollback.md`.

---

## Error reporting (error_watch): enabling, disabling and troubleshooting

This component is **off by default**: it is installed, but `ensure_proxy.py` only starts it when the environment variable
`ZCODE_PERSISTENCE_WATCH` is `1/true/yes/on`.

```bash
# enable the switch (user-level, persistent): it takes effect only after a full ZCode restart,
# the SessionStart hook inherits the environment of the ZCode process; the current session does not change
setx ZCODE_PERSISTENCE_WATCH 1

# disable: setx ZCODE_PERSISTENCE_WATCH 0, or delete the user variable
# (or set it temporarily in the current cmd, then run the command below in the foreground)

# manual foreground run (Ctrl+C to stop): use this when the current session needs it immediately, without the switch
cd /d "C:\Program Files (x86)\AI\Zcode-Persistence"
python error_watch.py

# diagnose only; no email, no state write
python error_watch.py --once

# send one end-to-end self-test email
python error_watch.py --test-mail

# report a historical session (ignores baseline and rate limit)
python error_watch.py --report-sid <session id> --proxy-log <path to proxy.log>
```

To view status and logs:

```bash
type "C:\Program Files (x86)\AI\Zcode-Persistence\error_watch.log"
# start: started / baseline: historical red dots skipped on the first pass / cooldown: suppressed by cooldown
# ratelimit: hit the limit / mail: sent or failed / db: session DB cannot be opened or queried
```

To stop it:

```bash
# find the process by command line, not by port (it does not listen on one)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*error_watch.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
```

Common symptoms:

| Symptom | Cause | Action |
|---|---|---|
| `cooldown` keeps appearing in the log | The same session is reported only once per 10 minutes; this is normal | Nothing to do |
| `ratelimit: 8 emails already sent within one hour` | Flood protection during an outage | Wait for the next hour, or tune `MAX_PER_HOUR` |
| `mail: send failed` | MCP will not start / credentials expired / network | Read the reason and the stderr tail that follow; re-verify with `--test-mail` |
| Mail arrives but the sender is a QQ address | `From` was not set to the outlook address | Check `MAIL_FROM`; the QQ side discards forged senders |
| No mail has ever arrived | Only `completed`/`interrupted` sessions were involved (neither type is reported) | Use `--once` to see whether any session is currently in error |
