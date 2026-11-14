<p align="center"><img src="assets/logo.webp" width="192" height="192" alt="ZCode Community Retry logo"></p>

<h1 align="center">ZCode Community Retry</h1>

<p align="center">在 ZCode 主聊天中重试受支持的暂时失败，可调间隔、遵守停止操作，并提供可选 Keeper。</p>

<p align="center"><a href="https://github.com/tangyixiao/zcode-community-retry"><img src="docs/assets/banner-zh-CN.svg" width="100%" alt="ZCode Community Retry — 查看项目与使用说明"></a></p>

<p align="center"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

[![Stars](https://img.shields.io/github/stars/tangyixiao/zcode-community-retry?style=flat)](https://github.com/tangyixiao/zcode-community-retry/stargazers) [![CI](https://img.shields.io/github/actions/workflow/status/tangyixiao/zcode-community-retry/test.yml?branch=main)](https://github.com/tangyixiao/zcode-community-retry/actions/workflows/test.yml) [![License](https://img.shields.io/github/license/tangyixiao/zcode-community-retry)](LICENSE)

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-1-zh-CN-dark.svg"><img src="docs/assets/feature-1-zh-CN-light.svg" width="260" alt="主聊天重试: 只在尚未交付内容时重试"></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-2-zh-CN-dark.svg"><img src="docs/assets/feature-2-zh-CN-light.svg" width="260" alt="可调等待间隔: 遵守停止与更长 Retry-After"></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-3-zh-CN-dark.svg"><img src="docs/assets/feature-3-zh-CN-light.svg" width="260" alt="可选 Keeper: 用户范围显式启用与撤销"></picture>
</p>

## 开始使用

```text
https://github.com/tangyixiao/zcode-community-retry
```

在 ZCode「插件市场 → 添加」中输入本仓库 URL，安装 `zcode-community-retry@tangyixiao-zcode-community` 并在用户范围启用。新建聊天后用 `/retry-status` 核对当前 Agent；Keeper 是独立的可选插件。

## 当前状态与兼容性

| 项目 | 当前依据 |
| --- | --- |
| 源码版本 | `0.4.5` · 以 [package.json](package.json) 为准 |
| 分发方式 | `native` · [Releases](https://github.com/tangyixiao/zcode-community-retry/releases) |
| Node.js | `>=22` |
| 开发状态 | [Open issues](https://github.com/tangyixiao/zcode-community-retry/issues?q=is%3Aissue+is%3Aopen) · [CI](https://github.com/tangyixiao/zcode-community-retry/actions) |

当前原生接入针对 Windows ZCode Desktop 与 npm CLI；依赖内部接口，不承诺未来版本自动兼容。余额不足、认证和长期权限错误不能靠重试解决。Keeper 开启后仅关闭 Retry 会被恢复；撤销时先关闭 Keeper。

[详细使用、配置与故障排查](docs/guide.zh-CN.md) · [原生 Retry 说明](community/README.md)

## 开发与参与

```sh
npm test
node tools/check-repository.mjs
```

[Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Questions](https://github.com/tangyixiao/zcode-community-retry/discussions) · [Report a bug](https://github.com/tangyixiao/zcode-community-retry/issues/new/choose) · [Security](SECURITY.md) · [Maintenance](docs/maintenance.md)

## Star History

<picture><source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=tangyixiao/zcode-community-retry&amp;type=date&amp;theme=dark&amp;legend=top-left"><img src="https://api.star-history.com/chart?repos=tangyixiao/zcode-community-retry&amp;type=date&amp;legend=top-left" width="900" alt="ZCode Community Retry Star History"></picture>

[Interactive chart](https://www.star-history.com/?repos=tangyixiao%2Fzcode-community-retry&type=date) · [GitHub Stars](https://github.com/tangyixiao/zcode-community-retry/stargazers)

图表由外部服务按真实星标数据生成，可能缓存或暂时不可用；未填造开发百分比。

## 来源与许可

[Software license](LICENSE) · [Logo artwork and attribution](assets/NOTICE.md)
