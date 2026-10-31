# MCP Servers

| 服务 | 用途 | 类型 | 配置 |
|---|---|---|---|
| [github](github/) | 仓库、Issue、PR、代码搜索 | 第三方 launcher | `mcp.servers.github` |
| [ms365](ms365/) | Outlook、日历、OneDrive、To Do | 第三方服务 | `mcp.servers.ms365` |

## 约定

- 仓库只存 `README.md` 与 `mcp.json.example`，真实配置在
  `C:\Users\<用户>\.zcode\cli\config.json`，不进库。
- 模板中的路径是占位示例，落盘前按本机实际路径替换。
- **ZCode 不会展开配置里的 `${VAR}`**；需要变量时由部署脚本或手工替换。
- 第三方服务不复制源码；自写服务放 `src/`，并按项目规范补文档。

## 新增 MCP

1. 建目录 `mcps/<name>/`，名字与 `mcp.servers` 的键一致；
2. 写 `README.md`（用途、启动、认证、验证、排障）与 `mcp.json.example`；
3. 有环境变量时补 `.env.example`，只放占位符；
4. 更新本表与根 `README.md`；
5. 按 [03-部署与同步](../docs/03-部署与同步.md) 合并到真实配置，写前备份。
