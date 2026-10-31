# 05 Licenses and Sources

## Root license

This repository has **no root LICENSE** and is therefore "all rights reserved".
A root license, once chosen, covers original content only — not the third-party code
vendored under `skills/`.

Before open-sourcing, confirm:

1. Which license applies to original content (MIT / Apache-2.0 / other).
2. Whether each third-party directory may be redistributed.
3. That every third-party directory keeps its `LICENSE` and copyright line, recorded here.

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

`projects/zcode-persistence/src/error_watch.py` contains real sender and recipient email
addresses, and they are also referenced in the project README, CHANGELOG and docs.
Therefore:

- **This repository must remain private** and must not be published or shared.
- Before publishing, move the addresses to environment variables or local config; keep
  only placeholders in the repository.
- Do not add complete email addresses to documentation; clean up existing ones before any
  public release.
