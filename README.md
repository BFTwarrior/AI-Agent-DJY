# AI-Agent-DJY

Skills, MCP servers and projects for AI agents — one repository, one source of truth.

> 主页只放总览与索引。每个资产怎么用、为什么这样设计、维护时要注意什么，都在
> [`docs/`](docs/) 的分页里；项目自身的说明在对应项目目录的 `文档/` 下。

## 里面有什么

### Skills

| 技能 | 用途 | 来源 | 状态 |
|---|---|---|---|
| [code-review-and-quality](skills/code-review-and-quality/) | 多维代码审查：正确性、可读性、架构、安全、性能 | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)（MIT） | 在用 |
| [code-simplification](skills/code-simplification/) | 行为不变地降低复杂度 | 同上（正文注明受 Anthropic code-simplifier 启发） | 在用 |
| [constraint-driven-development](skills/constraint-driven-development/) | 把项目质量门槛写成 `CONSTRAINTS.md` 并防止被悄悄降低 | 同上（MIT） | 在用 |

### MCP Servers

| 服务 | 用途 | 类型 | 状态 |
|---|---|---|---|
| [github](mcps/github/) | GitHub 仓库、Issue、PR 操作 | 第三方 launcher + 配置模板 | 在用 |
| [ms365](mcps/ms365/) | Outlook 邮件、日历、OneDrive | 第三方服务 + 配置模板 | 在用 |

### Projects

| 项目 | 说明 | 当前版本 | 文档 | 发行版 |
|---|---|---|---|---|
| [zcode-persistence](projects/zcode-persistence/) | ZCode 失败重试工具包：钩子建议、本地重试代理、可选的报错邮件 | V0.2 | [文档](projects/zcode-persistence/文档/00-总览.md) | [Release](https://github.com/BFTwarrior/AI-Agent-DJY/releases/tag/proj-zcode-persistence-v0.2) |

## 怎么用

- **技能**：仓库是源，运行时副本在 `~/.zcode/skills/<name>/`。部署链路与同步规则见
  [部署与同步](docs/03-部署与同步.md)。
- **MCP**：仓库只存配置模板，真实配置在 `~/.zcode/cli/config.json` 的 `mcp.servers`，
  密钥不进库。每个服务的启动方式见对应目录的 `README.md`。
- **项目**：直接在 `projects/<name>/` 里开发，`git pull` → 修改 → 提交 → 推送；
  发行包走 Releases，不进 git 历史。

## 文档索引

| 页面 | 内容 |
|---|---|
| [00-总览](docs/00-总览.md) | 仓库定位、边界、三类资产的关系 |
| [01-目录与命名](docs/01-目录与命名.md) | 目录结构、命名规范、tag 规范 |
| [02-收录规范](docs/02-收录规范.md) | 什么样的技能/MCP/项目可以进来，模板长什么样 |
| [03-部署与同步](docs/03-部署与同步.md) | 仓库 → AI 安装层 → ZCode 运行时的链路与安全规则 |
| [04-迁移记录](docs/04-迁移记录.md) | 2026-11-01 首次导入的清单、排除项与校验值 |
| [05-许可证与来源](docs/05-许可证与来源.md) | 第三方内容的许可证、版权行与收录边界 |
| [06-维护与验收](docs/06-维护与验收.md) | 改完怎么测、提交前查什么、发版检查表 |

## 约定速览

- 目录名统一小写 kebab-case；技能目录名必须与 `SKILL.md` 的 `name` 一致。
- 第三方技能必须同时有 `LICENSE`（含版权行）和 `UPSTREAM.md`（来源、hash、改动）。
- 任何密钥、token、真实 `config.json` 都不进库；只提交 `*.example`。
- 项目的旧版本用 tag 与 Releases 固定，仓库内不建物理“历史”目录。
- 提交前跑一次全工作树密钥扫描，细则见 [06-维护与验收](docs/06-维护与验收.md)。

## 许可证与私有性

本仓库暂无根许可证（默认保留所有权利）。`skills/` 下的第三方内容各自保留原许可证，
见 [05-许可证与来源](docs/05-许可证与来源.md)。如需开源，先补根 `LICENSE` 并逐项确认。

**项目源码包含真实收件邮箱**（`projects/zcode-persistence/src/error_watch.py`），
本仓库必须保持私有；公开或分享前先把邮箱改为环境变量注入，并清理文档中的地址。
