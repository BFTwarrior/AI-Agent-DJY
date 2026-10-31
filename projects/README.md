# Projects

| 项目 | 说明 | 当前版本 | 状态 | 文档 |
|---|---|---|---|---|
| [zcode-persistence](zcode-persistence/) | ZCode 失败重试工具包：钩子建议、本地重试代理、可选的报错邮件 | V0.2 | 在用 | [00-总览](zcode-persistence/文档/00-总览.md) |

## 约定

- 项目直接在仓库内开发：`git pull` → 修改 → 测试 → 提交 → 推送。
- 项目内沿用 `文档/`、`逻辑图/`；不建 `历史/`，旧版用 tag 与 Releases。
- 项目 `README.md` 只做索引，事实性内容放 `文档/`。
- 发行包上传 Releases，文件名与本地一致，上传前比对 sha256。

## 新增项目

1. 建目录 `projects/<name>/`，按 [02-收录规范](../docs/02-收录规范.md) 放置 `src/`、
   `tools/`、`文档/`、`逻辑图/`；
2. 写 `README.md`（一句话 + 版本 + 指向 `文档/`）；
3. 更新本表与根 `README.md`；
4. 首次发版打 tag `proj-<name>-vX.Y`，上传发行包。
