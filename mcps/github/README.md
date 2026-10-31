# GitHub MCP Server

通过 stdio 连接 GitHub，提供仓库、Issue、PR、代码搜索等工具。

## 启动方式（本机实测）

```text
command : C:\Program Files\nodejs\node.exe
args    : C:\Program Files (x86)\AI\github-mcp-server\github-mcp-launcher.js
type    : stdio
timeout : 60000
```

launcher 自己处理认证（本机使用 `gh` 的登录凭据），配置里不需要写 token。

## 配置

复制 `mcp.json.example` 的内容到：

```text
C:\Users\<用户>\.zcode\cli\config.json  →  mcp.servers.github
```

把占位符换成实际路径；写入前先备份 `config.json`，只合并 `github` 这一项，
保留其他 server 与未知字段。

## 验证

1. 重启 ZCode；
2. 新会话里确认 `github` 的工具可用；
3. 失败时看 launcher 的 stderr，常见原因是 Node 路径变化或 `gh` 未登录。

## 安全

- 不把 `gh` token、token cache 复制进仓库；
- 不在模板里写账号名以外的个人信息；
- 需要更小权限时，在 `gh` 侧使用最小 scope 的 token。
