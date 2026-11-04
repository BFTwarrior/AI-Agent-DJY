# 00 Overview

## What this repository is

AI-Agent-DJY is a personal **agent asset repository**: skills, MCP servers and complete
projects live in one place under a single set of rules for naming, inclusion, deployment
and release.

It solves three problems:

1. **Scattered assets**: skills live in `~/.zcode/skills`, MCP configuration lives in
   `~/.zcode/cli/config.json`, and projects are spread across the local workspace, with no
   single source or version.
2. **Untraceable changes**: editing runtime copies directly leaves no record of what
   changed or how to roll back.
3. **Migration cost**: moving to a new machine or agent platform starts with guessing
   which files to take.

## Layout

```text
skills/     Reusable capability packages: SKILL.md + references + source record
mcps/       Self-written MCP servers, or config templates for third-party servers
projects/   Complete projects: source + current docs + current diagrams
shared/     Cross-project scripts and prompts (reserved; nothing shared yet)
docs/       Repository-level rules (this directory)
```

`skills/`, `mcps/` and `projects/` are the three asset types; `shared/` and `docs/` support
them.

Shared principles:

- **The repository is the source; the runtime is a copy.** Edit the repository, then sync.
  Never edit files under `~/.zcode` as the long-term solution.
- **Third-party content must be traceable**: license, source, and hash at import time.
- **Old versions live in tags and Releases**, not as duplicate folders in the repository.

## Boundaries: what does not belong here

| Category | Reason | Where it goes |
|---|---|---|
| Secrets, tokens, real `config.json` | Private repositories are still cloned, backed up and shared | Local environment variables / ZCode user config |
| `venv/`, `node_modules/` | Reproducible, large | Local machine |
| Build outputs, zip, original xmind files | Binary history grows quickly | GitHub Releases or local disk |
| Logs, sqlite, state files | Runtime data, possibly private | Local machine |
| Third-party content without a license | Copyright is reserved by default | Link only; do not copy the body |

## Relationship to the local workspace

```text
<workspace>\
├─ 归档\AI-Agent-DJY\           Project folder (contains docs/diagrams/history)
│  ├─ <local docs>\ <local diagrams>\ <local history>\   Planning docs and local history
│  └─ repo\                    ★ Repository workspace (the only git root)
│     ├─ skills/ mcps/ projects/ shared/ docs/
│     └─ README.md AGENTS.md LICENSE .gitignore .gitattributes
└─ Zcode-Persistence\          Old folder, read-only backup after migration
   └─ <local history>\         Local history originals, kept
```

**The repository root is `AI-Agent-DJY\repo`.** `<workspace>` denotes the local parent
folder; the repository is `<workspace>\归档\AI-Agent-DJY\repo`. Do not
initialize git in the `AI-Agent-DJY` parent folder, or planning documents and local history
would be committed along with the repository.

## Data flow

```text
repo skills/<name>/   ──install──►  C:\Program Files (x86)\AI\AI-Agent-DJY\skills\<name>\
                               └──sync───►  ~\.zcode\skills\<name>\

repo mcps/<name>/     ──render + backup──►  ~\.zcode\cli\config.json  (mcp.servers.<name>)

repo projects/<name>/ ──tag/Release──►  GitHub Releases (archives)
```

Details: [03-Deployment and Sync](03-deployment-and-sync.md).

## Current contents (2026-11-04)

- 3 skills: `code-review-and-quality`, `code-simplification`, `constraint-driven-development`
- 2 MCP entries: `github`, `ms365` (config templates only, no secrets)
- 1 project: `zcode-persistence` V0.2.9 (source + docs + diagrams; 12 retry scenarios + 32 streaming scenarios)
- `shared/`: scaffold only; no cross-project scripts or prompts have been added yet

## Non-goals

- This is a personal asset repository, not a public skill marketplace.
- It does not replace each project's own tests and release process.
- It is not a secret store.
