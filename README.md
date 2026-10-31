# AI-Agent-DJY

Skills, MCP servers and projects for AI agents — one repository, one source of truth.

> This README is an overview and index only. Usage details, design rationale and maintenance
> rules live in the [`docs/`](docs/) pages. Project-specific documentation stays inside each
> project folder and keeps its original language.

## What's inside

### Skills

| Skill | Purpose | Source | Status |
|---|---|---|---|
| [code-review-and-quality](skills/code-review-and-quality/) | Multi-axis code review: correctness, readability, architecture, security, performance | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT) | Active |
| [code-simplification](skills/code-simplification/) | Reduce complexity without changing behavior | Same (body credits Anthropic's code-simplifier) | Active |
| [constraint-driven-development](skills/constraint-driven-development/) | Turn a project's quality bar into `CONSTRAINTS.md` and prevent it from being quietly lowered | Same (MIT) | Active |

### MCP Servers

| Server | Purpose | Type | Status |
|---|---|---|---|
| [github](mcps/github/) | GitHub repositories, issues, pull requests | Third-party launcher + config template | Active |
| [ms365](mcps/ms365/) | Outlook mail, calendar, OneDrive | Third-party server + config template | Active |

### Projects

| Project | Description | Version | Docs | Release |
|---|---|---|---|---|
| [zcode-persistence](projects/zcode-persistence/) | ZCode retry toolkit: hook suggestions, local retry proxy, optional error email reports | V0.2 | [Docs](projects/zcode-persistence/) (Chinese) | [Release](https://github.com/BFTwarrior/AI-Agent-DJY/releases/tag/proj-zcode-persistence-v0.2) |

## How to use

- **Skills**: the repository is the source; the runtime copy lives in `~/.zcode/skills/<name>/`.
  See [Deployment and Sync](docs/03-deployment-and-sync.md).
- **MCP**: this repository stores templates only. The real configuration lives in
  `~/.zcode/cli/config.json` under `mcp.servers`; secrets never enter the repository.
  Startup details are in each server's `README.md`.
- **Projects**: develop directly in `projects/<name>/`. Pull, edit, test, commit, push.
  Release archives go to GitHub Releases, not into git history.

## Documentation

| Page | Contents |
|---|---|
| [00-Overview](docs/00-overview.md) | Scope, boundaries, how the three asset types relate |
| [01-Structure and Naming](docs/01-structure-and-naming.md) | Directory layout, naming rules, tag conventions |
| [02-Inclusion Rules](docs/02-inclusion-rules.md) | What may enter the repository, and the templates to use |
| [03-Deployment and Sync](docs/03-deployment-and-sync.md) | Repository → AI install layer → ZCode runtime, and the safety rules |
| [04-Migration Record](docs/04-migration-record.md) | What was imported on 2026-11-01, exclusions, checksums |
| [05-Licenses and Sources](docs/05-licenses-and-sources.md) | Third-party licenses, copyright lines, inclusion boundaries |
| [06-Maintenance and Acceptance](docs/06-maintenance-and-acceptance.md) | Tests to run, checks before commit, release checklist |

## Conventions at a glance

- Directory names are lowercase kebab-case; a skill directory name must match the `name`
  field in its `SKILL.md`.
- Third-party skills must include both `LICENSE` (with the copyright line) and `UPSTREAM.md`
  (source, hash, local changes).
- No secrets, tokens or real `config.json` files. Commit `*.example` templates only.
- Old project versions are fixed by tags and Releases; there is no physical `history/`
  directory inside the repository.
- Run a full-worktree secret scan before every commit. Details in
  [06-Maintenance and Acceptance](docs/06-maintenance-and-acceptance.md).

## License and privacy

This repository has no root LICENSE yet (all rights reserved). Third-party content under
`skills/` keeps its own license; see [05-Licenses and Sources](docs/05-licenses-and-sources.md).
If this repository is ever open-sourced, add a root `LICENSE` and verify each third-party entry.

**The project source contains real email addresses** (`projects/zcode-persistence/src/error_watch.py`).
This repository must remain private. Before publishing or sharing, move those addresses to
environment variables and remove them from the documentation.
