# 05 Licenses and Sources

## Root license

This repository is released under the [MIT License](../LICENSE). The root license covers
original content only — not the third-party code vendored under `skills/`, which keeps its
own license.

Before adding third-party content, confirm:

1. The license permits redistribution.
2. The directory keeps its `LICENSE` and copyright line.
3. The source, license and handling are recorded in the register below.

## Third-party register

| Content | Source | License | Handling |
|---|---|---|---|
| code-review-and-quality | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | MIT, Copyright (c) 2025 Addy Osmani | Included; LICENSE and UPSTREAM.md kept |
| code-simplification | Same | MIT | Included; body credits [Anthropic code-simplifier](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md) |
| constraint-driven-development | Same | MIT | Included; LICENSE and UPSTREAM.md kept |
| Karpathy skill | `multica-ai/andrej-karpathy-skills` | **No LICENSE** | **Not included**; link only |
| Anthropic official plugins | `anthropics/claude-plugins-official` | Verify per item before inclusion | Not copied until verified |
| ms-365-mcp-server | npm `@softeria/ms-365-mcp-server` | Per npm package declaration | No source copied; startup details only |
| github-mcp-server launcher | Local `AI\github-mcp-server` | Per that directory's declaration | No source copied; startup details only |

## Principles

- Content without an explicit license is never copied; only a source link is recorded.
- MIT / Apache-2.0 content may be included, but the license and copyright line must stay.
- When modifying a third-party skill, describe the change under "Local changes" in
  `UPSTREAM.md`; do not remove the original copyright.
- Third-party documentation, images and sample code are also copyrighted. When in doubt,
  do not commit them.

## MCP specifics

- The repository stores templates and self-written servers only; third-party MCP source
  is not vendored.
- Templates contain no tokens, accounts or usernames in paths.
- OAuth token caches (such as ms365) are runtime data: they do not enter the repository
  and do not migrate with it.

## Privacy requirement

The repository is public and must not contain real email addresses or other personal
contact data. `projects/zcode-persistence/src/error_watch.py` reads the recipient and sender
from `ZCODE_PERSISTENCE_MAIL_TO` / `ZCODE_PERSISTENCE_MAIL_FROM`; the committed defaults
are placeholders.

- Never commit a real address, token or machine-specific path.
- Release assets are sanitized copies: scan every entry before uploading.
- Do not add complete email addresses to documentation, changelogs or examples.
- If an address is committed, remove it from the working tree; if it reached history,
  rewrite history and force-push before relying on deletion.
