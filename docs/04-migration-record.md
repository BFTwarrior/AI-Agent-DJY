# 04 Migration Record

## Initial import, 2026-11-01

Imported from the local workspace `<workspace>`. The repository contains source,
current documentation and configuration templates only. Release archives, historical
versions and runtime data stay on the local machine or go to Releases.

### Skills (3)

| Skill | SKILL.md sha256 | Upstream blob | Source |
|---|---|---|---|
| code-review-and-quality | `2db1e850379f255fd3091ef278cde24cd6c7d2ba23e360cc52ea522c40d4396e` | `08209ff2208d2883d48d945f7754c428b77f8d87` | addyosmani/agent-skills, MIT |
| code-simplification | `f0c5ed754057eb0c1e027e2587f59de816651feb5e837242296c43ea21cf621d` | `c4f794aa3fc63ea041989b30be7a3887c79c53ed` | addyosmani/agent-skills, MIT |
| constraint-driven-development | `06479d4305f286d23cfb99f5dc85695896785269664e1f6a8d800e3b71e70c10` | `d41ab055104f249d505fb6ea706e20b15f439a9f` | addyosmani/agent-skills, MIT |

The imported files are **installed snapshots**, not upstream HEAD. The upstream blob is
recorded for traceability only; the two may differ. Each directory has a `LICENSE`
(MIT, Copyright (c) 2025 Addy Osmani) and an `UPSTREAM.md`.

### MCP (2 templates)

| Directory | Contents | Secrets |
|---|---|---|
| `mcps/github/` | Launcher startup details + `mcp.json.example` | None; authentication handled by the launcher / `gh` |
| `mcps/ms365/` | Server startup details + `mcp.json.example` | None; OAuth token cache lives in `%APPDATA%` |

Template fields match the existing entries in `~\.zcode\cli\config.json`. That file was
not copied into the repository.

### Project (zcode-persistence)

| Directory | Files | Contents |
|---|---|---|
| `src/` | 4 | `retry_hook`, `retry_proxy`, `ensure_proxy`, `error_watch` |
| `tools/` | 7 | install, uninstall, doctor, 3 self-tests, proxy restart |
| `文档/` | 8 | 00–07, current documentation (Chinese) |
| `逻辑图/` | 1 | `架构.md` |
| Root | 4 | `README.md`, `CHANGELOG.md`, `VERSION`, `AGENTS.md` |

24 files, 346,164 bytes. Every file in `src/` and `tools/` has the same sha256 as the
corresponding file in `发行\Zcode-Persistence-V0.2-正式版`.

### Path and link adjustments

- Project documentation keeps its `文档/` directory (the release package used `docs/`).
  Operational links were rewritten from `docs/...` to `文档/...`; a full Markdown link
  check reports zero broken links.
- The package's `docs/05-AI维护指南.md` corresponds to `文档/06-AI维护指南.md` locally;
  links were mapped by number.
- Historical entries in `CHANGELOG.md` keep their original `docs/` wording; a note at the
  top of the file explains this. `文档/05-变更记录.md` remains byte-identical to the root
  `CHANGELOG.md`.
- Overlapping content between the package `docs/` and the local `文档/` was not imported
  twice; the local `文档/` is canonical.

### Deliberately excluded

| Content | Destination |
|---|---|
| `发行\*.zip` (current) | GitHub Releases (`proj-zcode-persistence-v0.2`) |
| `历史\发行\*.zip` (11 files) | History import archive → Release (`...-v0.1-history`) |
| `历史\文档\` (2 versions), `历史\逻辑图\` (1 version) | Same history import archive |
| `proxy.log`, `restart.log`, `install-state.json`, `__pycache__` | Local runtime data |
| The whole `历史\` directory | Kept locally, never deleted |

### Release record (2026-11-01)

- [x] Created the private GitHub repository and pushed the initial commit (`main`, 55 files)
- [x] Created tags: `v0.1.0`, `proj-zcode-persistence-v0.2`,
  `proj-zcode-persistence-v0.1-history`
- [x] Uploaded the current archive to the `proj-zcode-persistence-v0.2` Release
  - Release title: `Zcode-Persistence V0.2`
  - Asset: `Zcode-Persistence-V0.2-20261101.zip` (ASCII name, because Chinese characters
    are rewritten to `.` by the platform)
  - Size: 126,779 bytes
  - sha256: `314df991f4c291611fa1c8e4d32b5b62a37d9f30e17aab07d555ac310fef3f38`
- [x] Uploaded the history import archive to the
  `proj-zcode-persistence-v0.1-history` Release
  - Release title: `Zcode-Persistence pre-import history`
  - Asset: `zcode-persistence-history-import.zip` (1,300,705 bytes, 28 entries)
  - sha256: `f9aaed855ac2b538b298dc88477c2360ae95939477fbb386fd87d3d25a4b27d9`
  - Extracts to `history/`, matching the local `Zcode-Persistence\历史` directory
