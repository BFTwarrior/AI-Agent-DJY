<p align="center"><img src="assets/logo.webp" width="192" height="192" alt="ZCode Community Retry logo"></p>

<h1 align="center">ZCode Community Retry</h1>

<p align="center">Retry supported transient failures in ZCode main chat, with a configurable interval, cancellation and an optional Keeper.</p>

<p align="center"><a href="https://github.com/tangyixiao/zcode-community-retry"><img src="docs/assets/banner-en.svg" width="100%" alt="ZCode Community Retry — Project and usage guide"></a></p>

<p align="center"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

[![Stars](https://img.shields.io/github/stars/tangyixiao/zcode-community-retry?style=flat)](https://github.com/tangyixiao/zcode-community-retry/stargazers) [![CI](https://img.shields.io/github/actions/workflow/status/tangyixiao/zcode-community-retry/test.yml?branch=main)](https://github.com/tangyixiao/zcode-community-retry/actions/workflows/test.yml) [![License](https://img.shields.io/github/license/tangyixiao/zcode-community-retry)](LICENSE)

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-1-en-dark.svg"><img src="docs/assets/feature-1-en-light.svg" width="260" alt="Main-chat retries: Retry only before content is delivered"></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-2-en-dark.svg"><img src="docs/assets/feature-2-en-light.svg" width="260" alt="Configurable waits: Respect stop and longer Retry-After"></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-3-en-dark.svg"><img src="docs/assets/feature-3-en-light.svg" width="260" alt="Optional Keeper: Explicit user-scope enable and revoke"></picture>
</p>

## Get started

```text
https://github.com/tangyixiao/zcode-community-retry
```

Add this repository URL in ZCode Plugin Market, install `zcode-community-retry@tangyixiao-zcode-community`, and enable it in user scope. Start a new chat and inspect `/retry-status` for the current Agent. Keeper is separately optional.

## Status and compatibility

| Item | Current source of truth |
| --- | --- |
| Source version | `0.4.5` · 以 [package.json](package.json) 为准 |
| Distribution | `native` · [Releases](https://github.com/tangyixiao/zcode-community-retry/releases) |
| Node.js | `>=22` |
| Development | [Open issues](https://github.com/tangyixiao/zcode-community-retry/issues?q=is%3Aissue+is%3Aopen) · [CI](https://github.com/tangyixiao/zcode-community-retry/actions) |

Native integration targets Windows ZCode Desktop and npm CLI and depends on internal interfaces. Balance, authentication and lasting permission errors are terminal. With Keeper enabled, disabling Retry alone is reversed; disable Keeper first to revoke that policy.

[Native Retry guide](community/README.md)

## Development and participation

```sh
npm test
node tools/check-repository.mjs
```

[Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Questions](https://github.com/tangyixiao/zcode-community-retry/discussions) · [Report a bug](https://github.com/tangyixiao/zcode-community-retry/issues/new/choose) · [Security](SECURITY.md) · [Maintenance](docs/maintenance.md)

## Star History

<picture><source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=tangyixiao/zcode-community-retry&amp;type=date&amp;theme=dark&amp;legend=top-left"><img src="https://api.star-history.com/chart?repos=tangyixiao/zcode-community-retry&amp;type=date&amp;legend=top-left" width="900" alt="ZCode Community Retry Star History"></picture>

[Interactive chart](https://www.star-history.com/?repos=tangyixiao%2Fzcode-community-retry&type=date) · [GitHub Stars](https://github.com/tangyixiao/zcode-community-retry/stargazers)

The external chart uses real star records and may be cached or unavailable; no development percentage is inferred.

## Origin and licenses

[Software license](LICENSE) · [Logo artwork and attribution](assets/NOTICE.md)
