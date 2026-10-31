# AI-Agent-DJY 维护规则

给接手维护的 AI 的硬约束。动手前先读 [`README.md`](README.md) 与 [`docs/`](docs/)。

## 目录职责

- `skills/<name>/`：自包含技能；`SKILL.md` 的 `name` 必须与目录名一致。
- `mcps/<name>/`：只放自写服务或配置模板；第三方服务只记录版本与启动方式。
- `projects/<name>/`：完整项目；源码 + `文档/` + `逻辑图/`，不建 `历史/`。
- `docs/`：仓库级规范，不放项目细节。
- `shared/`：跨项目脚本与提示词。

## 不许做

1. 不许提交任何密钥、token、`.env`、真实 `config.json`、日志、sqlite、zip、xmind。
2. 不许删除或改写第三方技能的 `LICENSE` 与 `UPSTREAM.md`；升级先另开提交。
3. 不许在仓库内直接改 `~/.zcode/skills/` 的运行时副本——改仓库，再同步。
4. 不许把 `projects/<name>/历史/` 建进仓库；旧版用 tag 与 Releases。
5. 不许为了“简化”删掉测试、断言或 `CONSTRAINTS.md` 里的门槛；见
   `skills/constraint-driven-development/SKILL.md`。
6. 不许直接推 `main`：改分支、提 PR、合并后再推。

## 改完的标准动作

1. 改了技能：检查 `SKILL.md` frontmatter、`UPSTREAM.md` 是否仍准确。
2. 改了 MCP 模板：确认模板无真实值，字段与 `~/.zcode/cli/config.json` 一致。
3. 改了项目：按项目 `文档/` 里的测试配方跑一遍，更新 `CHANGELOG`。
4. 提交前跑全工作树密钥扫描（命令见 `docs/06-维护与验收.md`）。
5. 发版：更新 `VERSION`/`CHANGELOG`，打 tag，上传 Release 资产。

## 提交信息

`<type>: <中文简述>`，type 用 `feat` / `fix` / `docs` / `chore` / `import`。
一个提交只做一件事；导入第三方内容用 `import:` 并在正文写来源与许可证。
