# Microsoft 365 MCP Server

通过 stdio 连接 Microsoft 365，提供 Outlook 邮件、日历、OneDrive、To Do 等工具。

## 启动方式（本机实测）

```text
command : C:\Program Files\nodejs\node.exe
args    : C:\Program Files (x86)\AI\ms-365-mcp-server\node_modules\@softeria\ms-365-mcp-server\dist\index.js
type    : stdio
timeout : 120000
```

## 认证

- 首次使用走 OAuth 设备码登录；
- 令牌缓存在 `%APPDATA%\ms-365-mcp-server\.token-cache.json`；
- 配置里**不需要**写账号、密码或 token。

令牌缓存属于运行时数据：不进仓库，也不随仓库迁移；换机器重新登录即可。

## 配置

复制 `mcp.json.example` 的内容到：

```text
C:\Users\<用户>\.zcode\cli\config.json  →  mcp.servers.ms365
```

写入前先备份 `config.json`，只合并 `ms365` 这一项，保留其他 server 与未知字段。

## 发信注意

- 发件地址必须显式指定为有权限的地址；用账号本名当 `From` 时，部分收件方
  （如 QQ 邮箱）会丢弃邮件，只留在“已发送”。
- 正文 `contentType` 使用 `text` / `html`，大小写按接口要求。
- 不要在本目录记录任何真实邮箱密码、应用密钥或刷新令牌。

## 验证

1. 重启 ZCode；
2. 新会话里调用一个只读工具（如列出邮箱文件夹）；
3. 失败时检查：Node 路径、服务安装路径、OAuth 缓存是否过期。

## 排障

| 现象 | 先看什么 |
|---|---|
| 工具列表为空 | 服务能否手动启动；`config.json` 的键名是否为 `ms365` |
| 401 / 需要登录 | 删除或重新生成 `.token-cache.json`，重新走设备码 |
| 发信成功但对方没收到 | `From` 是否为账号本名；换为有权限的地址 |
