# 03 Deployment and Sync

## The three layers

```text
Repository (source)
  skills/<name>/
        │ 1. Install (administrator)
        ▼
C:\Program Files (x86)\AI\AI-Agent-DJY\skills\<name>\
        │ 2. Sync (normal user)
        ▼
~\.zcode\skills\<name>\SKILL.md          ← loaded by ZCode
```

MCP follows the same pattern:

```text
Repository mcps/<name>/ (templates)
        │ 1. Install self-written server into the AI directory
        ▼
C:\Program Files (x86)\AI\<server-name>\
        │ 2. Render template + backup + merge
        ▼
~\.zcode\cli\config.json  →  mcp.servers.<name>
```

Projects are not copied: `projects/<name>/` is the development directory. Use
`git pull`, edit, `commit`, `push`.

## Why an install layer

The local rule is "install skills and MCP servers under
`C:\Program Files (x86)\AI`, each in its own folder". The existing
`AI\addyosmani-agent-skills` and `~\.zcode\skills` contain identical `SKILL.md` files,
which shows the runtime uses copies while the AI directory is the install/archive layer.
This repository follows the same structure:

- `AI\AI-Agent-DJY\skills\<name>`: install layer, used to restore on a new machine.
- `~\.zcode\skills\<name>`: runtime copy; ZCode reads only this.
- The existing `AI\addyosmani-agent-skills` **is not deleted**; it remains the upstream
  snapshot and rollback point.

## Sync rules (manual for now)

No sync scripts exist yet. Follow these rules manually; any future script must implement
the same rules.

### Skills

1. Compare the sha256 of the repository `SKILL.md` and
   `~\.zcode\skills\<name>\SKILL.md`.
2. Back up the target directory to `%TEMP%\AI-Agent-DJY-backup-<timestamp>\`.
3. Copy only `SKILL.md`, `references/`, `LICENSE` and `UPSTREAM.md`.
4. Do not delete extra directories in the target. Report them and confirm manually.
5. Verify hashes again. If they differ, roll back.

### MCP

1. Back up `~\.zcode\cli\config.json` to `config.json.bak-<timestamp>`.
2. Change only the matching entry under `mcp.servers`; **preserve all unknown fields**.
3. Replace placeholders before writing; write via a temporary file plus `os.replace`.
4. On any failure, restore the backup and report the cause.
5. Verify after restarting ZCode: the server still connects, and `github` / `ms365` are
   not broken by the change.

## Prohibited

- Do not treat direct edits under `~\.zcode\skills\` or `config.json` as a long-term
  solution. If you debug there, write the change back to the repository afterwards.
- Do not store real `config.json`, token caches or `.env` files in the repository.
- Do not mirror-delete during sync: extra skills in the target may come from another
  source, and deleting them removes capability.

## Rollback

| Scenario | Rollback |
|---|---|
| Skill behaves incorrectly after sync | Copy back from `%TEMP%\AI-Agent-DJY-backup-<timestamp>` |
| Install layer overwritten | Restore from `AI\addyosmani-agent-skills` or the backup |
| MCP config corrupted | Restore `config.json.bak-<timestamp>` and restart ZCode |
| Project upgrade fails | `git checkout <previous tag>`, or restore the archive from Releases |

## Restoring on a new machine

1. Clone the repository to `<workspace>\AI-Agent-DJY\repo`.
2. Verify third-party licenses and sources using each `skills/*/UPSTREAM.md`.
3. Copy skills to `AI\AI-Agent-DJY\skills\`, then sync to `~\.zcode\skills\`.
4. Install servers and configuration following `mcps/*/README.md`; inject secrets from
   local environment variables.
5. Use `projects/<name>/` directly; download release archives from Releases when needed.
