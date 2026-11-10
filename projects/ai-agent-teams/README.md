# ai-agent-teams

A team control plane for ZCode: one captain, two teams, a persistent task graph with
attempt tokens, leases and quality gates, and layered isolation from git worktree up to
containers.

Version: **0.2.2** (unreleased source; last formal release `0.1.8`) — see `VERSION` and
[CHANGELOG](CHANGELOG.md).

> This `README.md` is an index only. Behaviour, contracts and acceptance records live in
> `docs/`.

## Start here

| Document | Contents |
|---|---|
| [Overview](docs/overview.md) | Full product overview: mission, capabilities, isolation layers, UI surfaces, known boundaries |
| [START-HERE](docs/guides/START-HERE.md) | One-screen routing for a first-time reader |
| [Install](docs/guides/INSTALL.md) | Installation and configuration |
| [Install with an AI](docs/guides/INSTALL-WITH-AI.md) | Install with an AI agent driving the wizard |
| [Constraints](docs/guides/CONSTRAINTS.md) | Quality bar; do not weaken it to make a change pass |
| [Contributing](docs/guides/CONTRIBUTING.md) | Contribution flow and local checks |
| [Localization](docs/guides/LOCALIZATION.md) | Locales, time zone, English-prompt rule |
| [Migration](docs/guides/MIGRATION.md) | Upgrade and migration steps |

## Reference

| Document | Contents |
|---|---|
| [SPEC](SPEC.md) | Target design and numbered invariants (target, not runtime status) |
| [Contracts](docs/contracts.md) | HTTP / SSE / SQL / discovery / protocol contracts |
| [Decisions](docs/decisions.md) | Architecture decision records |
| [Test matrix](docs/test-matrix.md) | Scenario coverage matrix |
| [Verification](docs/verification.md) | Verified ZCode facts and commands |
| [Known limits](docs/known-limits.md) | Physical and environmental limits |
| [Glossary](docs/glossary.md) | Terms |
| [Roadmap](docs/roadmap.md) | Milestones |
| [Status](docs/status/STATUS.md) | Component status matrix |
| [Handoff](docs/status/HANDOFF.md) | Current state, next tasks, verification |
| [Changelog](CHANGELOG.md) | Change log |

## Layout

```text
ai-agent-teams/
├─ src/               runtime: daemon, scheduler service, MCP server, domain rules, adapters
├─ test/              Node built-in test suite
├─ scripts/           structural checks, UI build, packaging, supervisors
├─ config/            JSON Schema and example team configurations
├─ prompts/           captain, team-lead, member, reviewer, shadow, handoff prompts
├─ skills/ commands/  ZCode plugin resources
├─ agents/            shared worker model entry
├─ locales/           zh-CN, ja-JP, ko-KR, en-US
├─ assets/ ui-src/    team panel and web console sources plus built assets
├─ deploy/            worker container image definition
├─ examples/          sample task graph
├─ docs/              current documentation and project notes
├─ diagrams/          current Markdown diagrams
└─ tools/             entrypoint map to the canonical scripts/ directory
```

Workspace-only notes and XMind source files are not included in this repository. Runtime
workspace paths remain documented as data where relevant; see
[docs/guides/LOCALIZATION.md](docs/guides/LOCALIZATION.md).

## Checks

```bash
npm test            # node --test test/*.test.mjs
npm run check       # required files, JSON, config invariants, SPEC headings
npm run validate    # validate the canonical config
npm run plan        # print a deterministic dispatch plan
npm run package     # build the plugin ZIP and marketplace ZIP
```

## License

MIT. See [LICENSE](LICENSE).
