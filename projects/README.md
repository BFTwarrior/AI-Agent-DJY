# Projects

| Project | Description | Version | Status | Docs |
|---|---|---|---|---|
| [zcode-persistence](zcode-persistence/) | ZCode retry toolkit: hook suggestions, local retry proxy, optional error email reports | V0.2.12 | **Deprecated** — use zcode-community-retry plugin V0.4.5+ | [00-Overview](zcode-persistence/docs/00-overview.md) |
| [zcode-community-retry](zcode-community-retry/) | ZCode plugin: every model failure retried at most three times, then the last response is returned (fork of tangyixiao/zcode-community-retry) | V0.4.5 | Active | [README](zcode-community-retry/README.md) |
| [ai-agent-teams](ai-agent-teams/) | Team control plane for ZCode: one captain, two teams, attempt-tokened task graph, leases, quality gates, layered isolation | 0.2.2 (unreleased) | Active | [Overview](ai-agent-teams/docs/overview.md) |

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
4. For the first release, tag `proj-<name>-vX.Y[.Z]` and upload the archive.
