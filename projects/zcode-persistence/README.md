# Zcode-Persistence

A ZCode failure-retry toolkit: **suggests a retry when a tool fails**, **automatically
resends when a model request fails**, plus a default-off **email report of session errors**.

- Version: V0.2.9
- Build line: 0.4.0
- Applies to: ZCode Desktop (Windows), Python 3.9+
- Dependencies: Python standard library only; proxy mode prefers certifi (if installed)

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
├─ src/                     Runtime scripts (5; includes route_providers.py)
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
`proj-zcode-persistence-v0.2.9`.
The archive contains build artifacts; this directory is authoritative for the source, and
if the two disagree, this directory plus the tag wins.
