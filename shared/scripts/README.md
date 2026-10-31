# Scripts

Planned cross-project scripts. Any implementation must follow these rules:

1. Default to `--dry-run` and print files that would be added, overwritten or skipped.
2. Back up the target to `%TEMP%\AI-Agent-DJY-backup-<timestamp>` before writing.
3. Never delete extra directories or entries in the target; report them only.
4. Use `pathlib` + `expanduser`; do not hard-code drive letters.
5. Exit non-zero on failure and explain the cause; never swallow exceptions silently.

| Script | Purpose | Status |
|---|---|---|
| `sync_skills.py` | Three-layer skill sync and verification | Not implemented |
| `install_mcp.py` | MCP template rendering and merge | Not implemented |

Until the scripts exist, follow
[03-Deployment and Sync](../../docs/03-deployment-and-sync.md) manually.