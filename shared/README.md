# Shared

Cross-project scripts and prompts.

```text
scripts/    Sync, validation and packaging tools (planned)
prompts/    Reusable prompt fragments
```

## Planned scripts

| Script | Purpose | Status |
|---|---|---|
| `sync_skills.py` | Repository → `AI\AI-Agent-DJY\skills` → `~\.zcode\skills`; dry-run by default, backup before write, never delete extra directories | Not implemented |
| `install_mcp.py` | Render `mcp.json.example` → merge `mcp.servers`; backup before write, roll back on failure | Not implemented |

Until the scripts exist, follow the manual steps in
[03-Deployment and Sync](../docs/03-deployment-and-sync.md).