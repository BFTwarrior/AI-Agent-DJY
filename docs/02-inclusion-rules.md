# 02 Inclusion Rules

## Skills

### Admission criteria

1. A clear use case: the `description` states when to use the skill, not marketing copy.
2. Self-contained: no dependency on relative paths to other skills in this repository.
3. Third-party content has an explicit license (MIT, Apache-2.0, etc.). Content without
   a license is linked, never copied.
4. Loadable by the current ZCode version: the `name` in `SKILL.md` matches the directory.

### Directory contents

| File | Required | Notes |
|---|---|---|
| `SKILL.md` | Yes | Frontmatter plus body |
| `LICENSE` | Third-party only | Verbatim, including the copyright line |
| `UPSTREAM.md` | Third-party only | Source, hash, import date, local changes |
| `references/` | No | Reference material synced with the skill |

### `SKILL.md` frontmatter

```yaml
---
name: <must match the directory name>
description: <when to use it; include triggers and boundaries, not marketing>
---
```

### `UPSTREAM.md` template

```markdown
# Source

- Upstream repository: https://github.com/<owner>/<repo>
- Upstream path: skills/<name>
- Import mode: installed snapshot (not HEAD)
- Local file: SKILL.md sha256=<...>
- Upstream blob: <sha or "not recorded">
- Import date: 2026-11-01
- License: MIT (see LICENSE in this directory, including the Copyright line)
- Local changes: none / list them
```

### Handling third-party content

- **Import the installed snapshot, not upstream HEAD**: the installed version is known to
  work; upstream may have changed.
- **Do not use git submodules**: ZCode loads plain directories, submodules leave nested
  `.git` directories, and both syncing and backup become error-prone. Use vendoring plus
  `UPSTREAM.md`.
- To upgrade a third-party skill, make a separate commit, update the hash and date in
  `UPSTREAM.md`, and describe the difference in the commit message.

## MCP servers

### Admission criteria

1. A self-written server, or a third-party server currently in use (templates only).
2. Do not copy third-party source into this repository; record the package name, version
   and startup command instead.
3. Templates contain no real tokens, accounts or usernames in paths.

### Directory contents

| File | Required | Notes |
|---|---|---|
| `README.md` | Yes | Purpose, install, startup, authentication, troubleshooting |
| `mcp.json.example` | Yes | Same shape as the real `mcp.servers.<name>` entry |
| `.env.example` | No | Placeholders when environment variables are needed |
| `src/` | Self-written only | Never for third-party servers |

### Templates and real configuration

The real configuration lives in `C:\Users\<user>\.zcode\cli\config.json` under
`mcp.servers.<name>` and **never enters the repository**. Template:

```json
{
  "mcp": {
    "servers": {
      "<server-name>": {
        "type": "stdio",
        "command": "<absolute path to interpreter>",
        "args": ["<absolute path to entry script>"],
        "timeoutMs": 60000,
        "env": {
          "API_KEY": "${API_KEY}"
        }
      }
    }
  }
}
```

Notes:

- **ZCode does not expand `${VAR}` in configuration files.** Placeholders are replaced by
  the deployment script before writing, or manually when no script exists.
- `env` is optional; not every server needs it.
- ms365 uses an OAuth token cache (`%APPDATA%\ms-365-mcp-server\.token-cache.json`), so no
  key belongs in the configuration.

## Projects

### Admission criteria

1. Independent lifecycle: its own version, docs, tests and release archive.
2. Source can be committed; runtime artifacts can be excluded.
3. A clear license, or an explicit "private / not licensed" note.

### Directory contents

```text
projects/<name>/
├─ README.md        Index: one line + version + links into docs/
├─ AGENTS.md        Hard constraints for AI maintainers
├─ CHANGELOG.md     Change log
├─ VERSION          Version number
├─ src/             Executable source
├─ tools/           Install/self-test/operations scripts
├─ docs/            Current documentation
└─ diagrams/          Current diagrams (Markdown)
```

### History and releases

- **No `history/` directory**: old versions are fixed by tags and release archives.
- Local history that predates migration is packaged as `*-history-import.zip`; its sha256
  is recorded in [04-Migration Record](04-migration-record.md). The 2026-11-03 public
  conversion removed the pre-sanitization archive from the
  `proj-<project>-v<version>-history` Release, so that Release now has no downloadable asset.
- Archive names match the local file; compare sha256 before upload.

## Archiving

When a project is retired:

1. Mark it `archived` in `projects/README.md`.
2. Create a final tag and keep the Release.
3. Do not delete the directory or its history. If it must leave the repository, verify the
   tag and Release first.
