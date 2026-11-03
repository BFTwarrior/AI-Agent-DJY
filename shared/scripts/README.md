# Scripts

No cross-project scripts yet. When the first one is added, it must follow these rules:

1. Default to `--dry-run` and print files that would be added, overwritten or skipped.
2. Back up the target to `%TEMP%\AI-Agent-DJY-backup-<timestamp>` before writing.
3. Never delete extra directories or entries in the target; report them only.
4. Use `pathlib` + `expanduser`; do not hard-code drive letters.
5. Exit non-zero on failure and explain the cause; never swallow exceptions silently.
6. Name the projects that use it at the top of the file; keep it generic if only one does.

Until a script exists, follow
[03-Deployment and Sync](../../docs/03-deployment-and-sync.md) manually.
