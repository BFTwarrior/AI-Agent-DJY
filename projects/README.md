# Projects

| Project | Description | Version | Status | Docs |
|---|---|---|---|---|
| [zcode-persistence](zcode-persistence/) | ZCode retry toolkit: hook suggestions, local retry proxy, optional error email reports | V0.2 | Active | [00-总览](zcode-persistence/文档/00-总览.md) (Chinese) |

## Conventions

- Develop projects inside the repository: `git pull` → edit → test → commit → push.
- Projects keep `文档/` and `逻辑图/`; there is no `历史/` folder — old versions use tags
  and Releases.
- A project `README.md` is an index; factual content lives in `文档/`.
- Release archives go to Releases; names match the local file and sha256 is compared
  before upload.

## Adding a project

1. Create `projects/<name>/` and add `src/`, `tools/`, `文档/`, `逻辑图/` following
   [02-Inclusion Rules](../docs/02-inclusion-rules.md).
2. Write `README.md` (one line + version + links into `文档/`).
3. Update this table and the root `README.md`.
4. For the first release, tag `proj-<name>-vX.Y` and upload the archive.