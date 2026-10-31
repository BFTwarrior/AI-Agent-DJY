# Microsoft 365 MCP Server

Connects to Microsoft 365 over stdio and exposes Outlook mail, calendar, OneDrive and To Do
tools.

## Startup (verified locally)

```text
command : C:\Program Files\nodejs\node.exe
args    : C:\Program Files (x86)\AI\ms-365-mcp-server\node_modules\@softeria\ms-365-mcp-server\dist\index.js
type    : stdio
timeout : 120000
```

## Authentication

- First use runs the OAuth device-code flow.
- The token cache is stored at `%APPDATA%\ms-365-mcp-server\.token-cache.json`.
- The configuration contains **no** account, password or token.

The token cache is runtime data: it does not enter the repository and does not migrate with
it. Sign in again on a new machine.

## Configuration

Copy the contents of `mcp.json.example` into:

```text
C:\Users\<user>\.zcode\cli\config.json  →  mcp.servers.ms365
```

Back up `config.json` before writing, merge only the `ms365` entry, and preserve the other
servers and unknown fields.

## Sending mail

- Specify a sender address the account is allowed to use. Using the account's own address as
  `From` can cause some recipients (for example QQ Mail) to drop the message; it then only
  remains in Sent Items.
- Use `text` or `html` for `contentType`, matching the API's expected casing.
- Never record real passwords, application secrets or refresh tokens in this directory.

## Verification

1. Restart ZCode.
2. In a new session, call a read-only tool (for example, list mail folders).
3. On failure, check the Node path, the server install path, and whether the OAuth cache has
   expired.

## Troubleshooting

| Symptom | Check first |
|---|---|
| Empty tool list | Whether the server starts manually; whether the config key is `ms365` |
| 401 / login required | Remove or regenerate `.token-cache.json`, then repeat the device-code flow |
| Mail sent but not received | Whether `From` is the account's own address; switch to an allowed sender |