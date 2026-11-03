# 04 Migration Record

## Initial import, 2026-11-01

Imported from the local workspace. The repository contains source,
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
| `tools/` | 8 | install, uninstall, doctor, 4 self-tests, proxy restart |
| `docs/` | 8 | 00–07, current documentation (English) |
| `diagrams/` | 1 | `architecture.md` |
| Root | 4 | `README.md`, `CHANGELOG.md`, `VERSION`, `AGENTS.md` |

25 files. The byte counts below are the 2026-11-01 import snapshot: 346,164 bytes in the
original CRLF working copy, 330,150 bytes in git blobs after LF normalization (333,781 bytes
in the checkout at import). At import time every file in `src/` and `tools/` matched the V0.2
package. The V0.2.1 patch changed `src/retry_hook.py`, added `tools/selftest_hook.py`, and
bumped `VERSION` / `tools/install.py`; at migration time the tree matched the V0.2.1 asset.
Later versions are recorded in the project `CHANGELOG` and Releases.

### Path and link adjustments

- Project documentation was translated to English and moved from the legacy Chinese docs
  directory to `docs/`; the diagram moved to `diagrams/`, and all file names were standardized.
  All links were rewritten; a full Markdown link check reports zero broken links.
- The package's `docs/05` maintenance guide corresponds to `docs/06-ai-maintenance-guide.md`;
  links were mapped by number.
- Historical entries in `CHANGELOG.md` keep the paths as originally written; a note at the
  top of the file explains this. `docs/05-changelog.md` carries the same content as the root
  `CHANGELOG.md` (only the page title differs).
- Overlapping content between the package `docs/` and the local documentation was not
  imported twice; the local documentation is canonical.

### Deliberately excluded

| Content | Destination |
|---|---|
| Release current at migration time `*.zip` | GitHub Releases (`proj-zcode-persistence-v0.2.1`) |
| Historical release zips (11 files) | History import archive → Release (`...-v0.1-history`) |
| Historical docs (2 versions) and diagram (1 version) | Same history import archive |
| `proxy.log`, `restart.log`, `install-state.json`, `__pycache__` | Local runtime data |
| The whole local history directory | Kept locally, never deleted |

### Release record (2026-11-01)

> Historical snapshot. It describes the state at migration time; current versions are in
> the project `CHANGELOG` and Releases.

- [x] Created the private GitHub repository and pushed the initial commit (`main`, 55 files); the repository was made public on 2026-11-03
- [x] Created tags: `v0.1.0`, `proj-zcode-persistence-v0.2`,
  `proj-zcode-persistence-v0.1-history`; later added `proj-zcode-persistence-v0.2.1`
- [x] Uploaded the current archive to the `proj-zcode-persistence-v0.2` Release
  - Release title: `Zcode-Persistence V0.2`
  - Asset: `Zcode-Persistence-V0.2-20261101.zip` (ASCII name, because Chinese characters
    are rewritten to `.` by the platform)
  - Size: 126,779 bytes
  - sha256: `314df991f4c291611fa1c8e4d32b5b62a37d9f30e17aab07d555ac310fef3f38`
  - **Superseded**: this asset contains the pre-fix `retry_hook.py` and was deleted after
    the V0.2.1 asset passed verification.
- [x] Uploaded the V0.2.1 patch archive to the `proj-zcode-persistence-v0.2.1` Release
  - Release title: `Zcode-Persistence V0.2.1`
  - Asset: `Zcode-Persistence-V0.2.1-20261101.zip`
  - Size: 131,104 bytes
  - sha256: `7f3f382dc3ba69e79e48888eaf43eb8d2d1f0b1011a5bb57b4452b7a5a1ed24c`
  - Contains `retry_hook.py` sha256 `00f3f22e166dfc247f6b49626ae849c21d18a6ff790fdeddcba166de6243ae0b`
- [x] Uploaded the history import archive to the
  `proj-zcode-persistence-v0.1-history` Release
  - Release title: `Zcode-Persistence pre-import history`
  - Asset: `zcode-persistence-history-import.zip` (1,300,705 bytes, 28 entries)
  - sha256: `f9aaed855ac2b538b298dc88477c2360ae95939477fbb386fd87d3d25a4b27d9`
  - Extracts to `history/`, matching the local `Zcode-Persistence` history directory
