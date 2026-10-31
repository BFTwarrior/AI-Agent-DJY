# 01 Structure and Naming

## Directory layout

```text
AI-Agent-DJY/
├─ README.md                  Overview (index only, no details)
├─ AGENTS.md                  Rules for AI maintainers
├─ .gitignore
├─ .gitattributes
├─ docs/                      Repository-level rules (this directory)
│  ├─ 00-overview.md
│  ├─ 01-structure-and-naming.md
│  ├─ 02-inclusion-rules.md
│  ├─ 03-deployment-and-sync.md
│  ├─ 04-migration-record.md
│  ├─ 05-licenses-and-sources.md
│  └─ 06-maintenance-and-acceptance.md
├─ skills/
│  ├─ README.md
│  └─ <skill-name>/
│     ├─ SKILL.md
│     ├─ LICENSE
│     ├─ UPSTREAM.md
│     └─ references/
├─ mcps/
│  ├─ README.md
│  └─ <server-name>/
│     ├─ README.md
│     ├─ mcp.json.example
│     └─ .env.example
├─ projects/
│  ├─ README.md
│  └─ <project-name>/
│     ├─ README.md
│     ├─ src/
│     ├─ tools/
│     ├─ 文档/
│     └─ 逻辑图/
└─ shared/
   ├─ scripts/
   └─ prompts/
```

## Naming rules

| Object | Rule | Example |
|---|---|---|
| Repository | User-defined | `AI-Agent-DJY` |
| Skill directory | Lowercase kebab-case, identical to `name` in `SKILL.md` | `code-review-and-quality` |
| MCP directory | Lowercase kebab-case, identical to the `mcp.servers` key | `ms365` |
| Project directory | Lowercase kebab-case | `zcode-persistence` |
| Repository docs | `NN-topic.md` with a two-digit number | `03-deployment-and-sync.md` |
| Project docs | Keep the project's own numbering | `00-总览.md` |

Constraints:

- No spaces, underscores or Chinese directory names; Chinese appears only in file names
  and body text.
- **Single exception**: projects keep `文档/` and `逻辑图/` per the owner's convention
  (see "Project internals" below). Repository-level directories stay English.
- Once published, a directory name should not change; if it must, update every link,
  `UPSTREAM.md` and deployment script.
- Use one casing only. Windows and git disagree on case sensitivity.

## Project internals

- `src/`: executable source.
- `tools/`: install, self-test and operations scripts (not runtime code).
- `文档/`: current documentation; old versions are not duplicated in the repository.
- `逻辑图/`: current diagrams, Markdown only. Original XMind files go to Releases or
  local disk.
- The project `README.md` is an index: one-line description, version, and links into
  `文档/`.

## Tag conventions

| Object | Format | Example |
|---|---|---|
| Repository | `v<major>.<minor>.<patch>` | `v0.1.0` |
| Single project | `proj-<project>-v<major>.<minor>` | `proj-zcode-persistence-v0.2` |
| Pre-import project history | `proj-<project>-v<version>-history` | `proj-zcode-persistence-v0.1-history` |

- Repository tags and project tags are separate, so "which package was released" is
  never ambiguous.
- Release asset names match the local archive, and the sha256 is compared before upload.

## Branches and commits

- Default branch is `main`; do not push directly. Use a branch and a pull request, even
  for a personal repository.
- Commit message: `<type>: <short description>`; type is one of `feat`, `fix`, `docs`,
  `chore`, `import`.
- Imports of third-party content use `import:` and name the source repository, path and
  license in the body.
