# Projects

| Project | Description | Version | Status | Docs |
|---|---|---|---|---|
| [zcode-persistence](zcode-persistence/) | ZCode retry toolkit: hook suggestions, local retry proxy, optional error email reports | V0.2 | Active | [00-Overview](zcode-persistence/docs/00-overview.md) |

## Conventions

- Develop projects inside the repository: `git pull` → edit → test → commit → push.
- Projects keep `docs/` and `diagrams/`; there is no `history/` folder — old versions use tags
  and Releases.
- A project `README.md` is an index; factual content lives in `docs/`.
- Release archives go to Releases; names match the local file and sha256 is compared
  before upload.

## Adding a project

1. Create `projects/<name>/` and add `src/`, `tools/`, `docs/`, `diagrams/` following
   [02-Inclusion Rules](../docs/02-inclusion-rules.md).
2. Write `README.md` (one line + version + links into `docs/`).
3. Update this table and the root `README.md`.
4. For the first release, tag `proj-<name>-vX.Y` and upload the archive.