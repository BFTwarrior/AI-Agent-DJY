# AI-Agent-DJY Maintenance Rules

Hard constraints for AI maintainers. Read [`README.md`](README.md) and [`docs/`](docs/)
before making changes.

## Directory responsibilities

- `skills/<name>/`: self-contained skill; the `name` in `SKILL.md` must match the directory.
- `mcps/<name>/`: self-written servers or configuration templates only. Third-party
  servers are recorded by version and startup command, not vendored.
- `projects/<name>/`: complete project with source, `文档/` and `逻辑图/`; no `历史/`.
- `docs/`: repository-level rules only; project details do not belong here.
- `shared/`: cross-project scripts and prompts.

## Prohibited

1. Never commit secrets, tokens, `.env`, real `config.json`, logs, sqlite, zip or xmind files.
2. Never delete or rewrite the `LICENSE` or `UPSTREAM.md` of a third-party skill; upgrades
   go in a separate commit.
3. Never edit runtime copies under `~/.zcode/skills/` directly. Edit the repository, then sync.
4. Never create `projects/<name>/历史/` inside the repository. Old versions use tags and Releases.
5. Never remove tests, assertions or thresholds from `CONSTRAINTS.md` just to get green.
   See `skills/constraint-driven-development/SKILL.md`.
6. Never push directly to `main`. Use a branch, open a pull request, merge after review.

## Standard actions after a change

1. Skill changed: verify the `SKILL.md` frontmatter and that `UPSTREAM.md` is still accurate.
2. MCP template changed: confirm no real values and that fields match
   `~/.zcode/cli/config.json`.
3. Project changed: run the test recipes in the project's `文档/`, update `CHANGELOG`.
4. Run the full-worktree secret scan before committing (command in
   `docs/06-maintenance-and-acceptance.md`).
5. Release: update `VERSION`/`CHANGELOG`, create tags, upload Release assets.

## Commit messages

`<type>: <short description>` where type is `feat`, `fix`, `docs`, `chore` or `import`.
One commit does one thing. Imports of third-party content use `import:` and name the source
and license in the body.
