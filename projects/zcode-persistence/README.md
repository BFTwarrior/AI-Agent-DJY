# Zcode-Persistence

A ZCode failure-retry toolkit: **suggests a retry when a tool fails**, **automatically
resends when a model request fails**, plus a default-off **email report of session errors**.

- Version: V0.2.5 patch release (build line 0.4.0)
- Applies to: ZCode Desktop (Windows), Python 3.9+
- Dependencies: Python standard library only; proxy mode prefers certifi (if installed)

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
├─ src/                     Runtime scripts (4)
├─ tools/                   Install/uninstall/self-test/restart (8)
├─ docs/                    Current documentation (00-07)
└─ diagrams/                Current structure diagrams
```

## Quick start

```bash
python tools/install.py          # Mode A: hook only
python tools/doctor.py           # Health check

python tools/install.py --with-proxy --provider-id new-provider   # Mode B: hook + proxy
```

For prefix selection, parameters, uninstallation and rollback see
[01-Install and rollback](docs/01-install-and-rollback.md); for design trade-offs and
internal structure see [03-Architecture](docs/03-architecture.md).

## Safety note

`src/error_watch.py` and some of the documentation contain a **real recipient email
address** (used for error reporting). This repository must stay private; to publish or
share it, first switch the address to environment-variable injection and scrub the
addresses out of the documentation.

## Distribution

The distribution package lives in the repository Releases: `proj-zcode-persistence-v0.2.5`.
The archive contains build artifacts; this directory is authoritative for the source, and
if the two disagree, this directory plus the tag wins.
