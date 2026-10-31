# GitHub MCP Server

Connects to GitHub over stdio and exposes repository, issue, pull request and code search
tools.

## Startup (verified locally)

```text
command : C:\Program Files\nodejs\node.exe
args    : C:\Program Files (x86)\AI\github-mcp-server\github-mcp-launcher.js
type    : stdio
timeout : 60000
```

The launcher handles authentication itself (this machine uses the `gh` login), so no token
belongs in the configuration.

## Configuration

Copy the contents of `mcp.json.example` into:

```text
C:\Users\<user>\.zcode\cli\config.json  →  mcp.servers.github
```

Replace placeholders with real paths. Back up `config.json` before writing, merge only the
`github` entry, and preserve the other servers and unknown fields.

## Verification

1. Restart ZCode.
2. In a new session, confirm the `github` tools are available.
3. On failure, check the launcher's stderr; common causes are a changed Node path or an
   unauthenticated `gh`.

## Security

- Never copy the `gh` token or token cache into the repository.
- Do not put personal information beyond what the template requires into the template.
- For narrower privileges, use a token with the smallest required scope on the `gh` side.