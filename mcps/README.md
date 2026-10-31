# MCP Servers

| Server | Purpose | Type | Configuration |
|---|---|---|---|
| [github](github/) | Repositories, issues, pull requests, code search | Third-party launcher | `mcp.servers.github` |
| [ms365](ms365/) | Outlook, calendar, OneDrive, To Do | Third-party server | `mcp.servers.ms365` |

## Conventions

- The repository stores only `README.md` and `mcp.json.example`. The real configuration
  lives in `C:\Users\<user>\.zcode\cli\config.json` and never enters the repository.
- Paths in templates are examples; replace them with local paths before writing.
- **ZCode does not expand `${VAR}` in configuration files.** Variables are replaced by a
  deployment script or manually.
- Third-party servers are not vendored. Self-written servers go in `src/` with the same
  documentation rules.

## Adding an MCP server

1. Create `mcps/<name>/`; the name must match the `mcp.servers` key.
2. Write `README.md` (purpose, startup, authentication, verification, troubleshooting) and
   `mcp.json.example`.
3. Add `.env.example` when environment variables are needed; placeholders only.
4. Update this table and the root `README.md`.
5. Merge into the real configuration following
   [03-Deployment and Sync](../docs/03-deployment-and-sync.md); back up first.