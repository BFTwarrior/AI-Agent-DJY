# Zcode-Persistence V0.2 正式版

**项目名：Zcode-Persistence**（ZCode 失败重试工具包）

给 ZCode 加三件事：**工具失败时自动建议重试**、**模型请求失败时自动重发**，以及（默认关闭）**会话报错时把原因发到邮箱**。

- 版本：V0.2 正式版（构建线 0.4.0）
- 构建日期：2026-10-30（2026-10-31 增补：放弃错误体改为可重试、报错监听、健康探针 root）
- 适用：ZCode Desktop（Windows），Python 3.9+
- 依赖：仅 Python 标准库；代理模式的 TLS 校验会优先使用 certifi（若已安装）

---

## 两种模式，先弄清区别

| | 模式 A：失败建议钩子 | 模式 B：本地重试代理 |
|---|---|---|
| 解决什么 | **工具调用失败**后，提示模型原样重试 | **整轮模型请求失败**后，自动重发 |
| 能自动重发吗 | 不能，只是建议 | **能，完全自动** |
| 覆盖范围 | 只覆盖 Bash 工具 | 覆盖所有经过它的模型请求 |
| 副作用 | 无 | 请求依赖本机代理进程，代理停则模型不可用 |
| 安装复杂度 | 低（只改一个配置文件） | 中（还要改 provider 的 baseUrl） |

**只想低风险试用 → 装模式 A。**
**确实受够了"上游 95 秒没有产出"的弹窗 → 装模式 B。**

### 可选的第三件事：报错汇报（默认关闭）

`src/error_watch.py` 监视 ZCode 会话库的 `session.last_outcome`，看到 `error`
（左侧会话列表 / 通知区亮红点）就把"这次为什么失败"发到 `your-email@example.com`：

- 只认 `error`。`completed`（正常结束）和 `interrupted`（用户停止 / 暂停）一律不报。
- 原因取自 `proxy.log` 里**与报错时刻对得上**（前后 15 分钟）的 `gave up` 记录；
  对不上就如实写"不是代理耗尽重试导致的"，不硬编原因。
- 发信走 outlook MCP（`ms-365-mcp-server` 的 stdio JSON-RPC），发件人固定
  `your-sender@example.com`（用账号本名 `your-email@example.com` 当 From 会被 QQ 侧丢弃）。
- 防刷屏：同一会话 10 分钟内只报一次；每小时最多 8 封；发信失败不推进状态，1 分钟后重试。
- **默认不自启**：只有设置环境变量 `ZCODE_PERSISTENCE_WATCH=1` 才会由 SessionStart 拉起。
  手动跑：`python error_watch.py`（`--once` 只打印、`--test-mail` 发自检信）。

---

## 快速开始

### 模式 A（只装钩子）

```bash
python tools/install.py
python tools/doctor.py
```

新开一个 ZCode 会话即可生效。

### 模式 B（钩子 + 代理）

```bash
# AP 通道（upstream-a.example.com）：前缀自动识别为 /ap
python tools/install.py --with-proxy --provider-id new-provider

# upstream-b 通道（upstream-b.example.com）：前缀自动识别为 /cm
python tools/install.py --with-proxy --provider-id new-provider-3

# 原始地址识别不出来时，必须显式指定前缀，否则安装器拒绝执行
python tools/install.py --with-proxy --provider-id my-relay --proxy-prefix ap

python tools/doctor.py
```

**前缀选择规则**：`--proxy-prefix` 省略时按原始 `baseUrl` 自动判断——含 `upstream-b.example.com` 用 `/cm`，含 `upstream-a.example.com` 用 `/ap`；两者都不匹配则**报错退出，不做任何改动**。绝不静默默认成某个上游，否则会把 A 通道的请求发到 B 通道。

新开一个 ZCode 会话后，`doctor.py` 应显示"provider 走代理"和"代理端口监听中"。

### 卸载

```bash
python tools/uninstall.py            # 撤销钩子和 provider 改动，保留脚本文件
python tools/uninstall.py --purge    # 连同安装目录一起删除
python tools/uninstall.py --dry-run  # 先看会做什么
```

---

## 目录结构

```
Zcode-Persistence-V0.2-正式版/
├─ AGENTS.md                给接手维护的 AI 的硬约束速查（先读这个）
├─ README.md                本文件：是什么、怎么用、限制
├─ VERSION                  版本号
├─ CHANGELOG.md             变更记录
├─ src/
│  ├─ retry_hook.py         钩子：PostToolUse 主 + PostToolUseFailure 兜底（模式 A）
│  ├─ retry_proxy.py        本地重试代理（模式 B）
│  ├─ ensure_proxy.py       SessionStart 钩子：确保代理在跑；报错监听默认不启
│  └─ error_watch.py        报错汇报：红点 → 邮件（默认关闭，需 ZCODE_PERSISTENCE_WATCH=1）
├─ tools/
│  ├─ install.py            安装（幂等，自动备份）
│  ├─ uninstall.py          卸载（精确还原）
│  ├─ doctor.py             健康检查
│  ├─ selftest_proxy_429.py 自检：重试语义五场景（含 400 不可重试）
│  ├─ selftest_stream.py    自检：流式回写七场景（含放弃时的可重试错误体）
│  ├─ selftest_watch.py     自检：报错汇报 12 条断言（冷却/限流/失败重试/原因归属/--once 不落盘）
│  └─ restart_proxy_idle.py 换进程：只在空闲窗口动手（--force 可立即换），旧进程死透才拉新
└─ 文档/
   ├─ 01-安装与回滚.md
   ├─ 02-维护手册.md
   ├─ 03-架构说明.md
   ├─ 04-测试记录.md
   └─ 05-AI维护指南.md       完整接手手册：代码地图/不变量/测试配方/故障定位
```

---

## 模式 A：失败建议钩子的规则

挂载点：ZCode 的 **`PostToolUse`**（主）+ **`PostToolUseFailure`**（兜底），`matcher = "Bash"`。

> 为什么不是只用 `PostToolUseFailure`：实测这个客户端对"被中断/超时的工具调用"不会派发该事件，
> 只有 `PostToolUse` 一定会来，而且带 `exitCode` / `timedOut` / `stderr`。
> 两个都挂，并用 `toolCallId` 去重，避免同一次调用被建议两遍。

**建议重试的范围：任何失败**

v0.4.0 起不再按错误类型筛除——只要 Bash 调用失败（退出码非 0、真超时、被取消、或状态明确是 failed/error），就会建议重试。旧的"permission denied / no such file / syntax error 不重试"白名单已删除。

| 情形 | 判定依据 | 建议文案 |
|---|---|---|
| 超时 | `timedOut=true`（即使输出为空） | 原样重试同一条命令 |
| 上游没有产出 | 错误文本命中 `UPSTREAM_PATTERNS`（upstream_deadline / turn execution failed / 没有产出 / overloaded / provider_code / capacity） | 先 `sleep 180` 等 3 分钟再重试（该命令超时设到 200000 毫秒以上） |
| 其它一切失败 | 退出码非 0 / status=failed / 被取消 | 原样重试同一条命令 |
| 成功 | 退出码 0 且 status 是 completed/success/ok | 静默 |

`UPSTREAM_PATTERNS` 只影响文案（要不要先等 3 分钟），**不影响是否重试**。

**次数控制**：同一条命令最多建议 3 次；距上次失败超过 10 分钟计数归零；状态文件超过 1 天自动清理。

**安全边界**：钩子永不阻断会话，所有路径退出码 0；只输出一句 `additionalContext`（模型可见；`systemMessage` 模型看不到，v0.3.0 已踩过坑）；匹配前剔除 `tool_input` 与元数据字段（`session_id`、`toolCallId`、`requestId` 等）：`UPSTREAM_PATTERNS` 只用来决定“要不要先等 3 分钟”，不该被命令文本或 ID 里的词干扰。

---

## 模式 B：本地重试代理的规则

```
ZCode ──► 127.0.0.1:8787 ──► 真实中转 ──► 上游
任何报错都重发：最长 3 分钟，每 20 秒一次，窗口到点才放弃
```

路径前缀决定上游：

| 前缀 | 目标 |
|---|---|
| `/ap/...` | `https://upstream-a.example.com/v1/...` |
| `/cm/...` | `https://upstream-b.example.com/v1/...` |

所以 provider 的 baseUrl 要改成 `http://127.0.0.1:8787/ap/v1`（或 `/cm/v1`）。

**会重试的三种情况**

1. 连不上或连接被断
2. 上游返回**任何非 2xx**（含 4xx；用户规格是任何报错都重试）
3. 上游 30 秒内一个字节都不吐

**重试次数**

不按次数，按时间窗：**持续重试 3 分钟，每 20 秒一次**（窗口内约 9 次尝试），流式和非流式一致。
两次尝试之间等 **20 秒**；上游返回更长的 `Retry-After` 时就按它的（上限 60 秒）。窗口到点不再发起新尝试；
已经在飞的那一次允许跑完（建连 10 秒 + 发送 90 秒 + 等头 30 秒上限），所以总耗时可能比窗口略长。
实测失败以 **HTTP 429（并发打满）** 为主，等几秒再发基本都能过。


**放弃时回什么（2026-10-31 改动，重要）**

窗口耗尽后代理回给客户端的不再是 `upstream_unavailable`，而是：

```json
{"message": "已持续重试 … 秒仍失败（…）", "type": "server_error",
 "code": "model_server_error", "reason": "server_error", "retryable": true}
```

原因：ZCode 客户端（`zcode.cjs` 的 `z7a()`）只认
`retryable===true`、`code ∈ {model_request_timeout, model_rate_limited, model_server_error, model_network_error}`
或 `reason ∈ {stream_idle_timeout, rate_limited, server_error, network_error, timeout}`。
旧错误码 `upstream_unavailable` 不在任何集合里，客户端判成不可重试，整轮直接结束、亮红点。
改后客户端会用自己的流恢复重试（最多 10 次），并带 `previous-message-anchor` 接着上次的内容往下写，
等价于自动发一条"继续"。**只对 503（代理耗尽重试）生效**；400（客户端自己写错前缀/请求体）
回 `invalid_request` + `retryable:false`，避免确定性的错误被重发 10 次。

流式请求如果已经进入心跳模式（200 已发出），放弃时只能把同样的错误体塞进 SSE `data:` 事件，
末尾补 chunked 终止块——`tools/selftest_stream.py` 第 7 个场景专门盯这段。

**心跳保活**

流式请求满 **80 秒**仍没有任何上游输入时，代理往对话里写一条 SSE 注释行（`: keepalive`）：
客户端会忽略内容，但能看到字节到达，因此不会因为"95 秒没有产出"直接中断。
响应头已经回来之后同样有效：中途上游停住时，每 80 秒补一条心跳继续等，
累计静默到 3 分钟才判截断（已经收到的内容不会丢）。
**前提**：响应必须是 `Content-Type: text/event-stream`（正常流式请求都是）；
不是这个类型时插注释行会写坏正文，只能按 30 秒静默截断。
客户端读得慢只会让整条流变慢（代理用队列形成背压），不会丢块；
完全不读且不断开的半开连接会一直阻塞（直到恢复读取或 TCP 报错），这是没有客户端写超时的代价。
之后**每 80 秒**没有输入就再补一条，**不设次数上限**。心跳由独立时钟驱动，不等某次尝试失败才发。

**不会重试**：已经开始向客户端回写字节之后断流——此时重发会造成内容重复。这种情况下代理不会补写 chunked 终止块，客户端会看到流未正常结束，从而知道被截断，而不是误以为完成。

**已知要求**

- 中转的 Cloudflare 会拦 `Python-urllib` 这类 UA 并返回 1010，代理会自动替换为常规浏览器 UA。
- TLS 校验优先用 certifi 的 CA 包；Windows 自带根证书库缺少部分根（如 SSL.com），会导致校验失败。
- 每次尝试各自有独立超时：建连 10 秒、发送请求体 90 秒（上下文体量大，不能沿用连接超时）、等首字节 30 秒。
- 不记录任何请求/响应内容，只写状态行（时间、路径、状态码、字节数、首字节延迟）。

---

## 出问题怎么查

```bash
python tools/doctor.py
```

它会逐项检查：脚本是否齐全、解释器是否存在、钩子是否注册、provider 指向哪里、代理端口是否监听，并打印 `proxy.log` 最后 5 行。

**三种典型故障**

| 现象 | 原因 | 处理 |
|---|---|---|
| 新会话里模型完全连不上 | 代理没在跑，但 provider 已指向 8787 | 手动运行 `src/retry_proxy.py`，或检查 SessionStart 钩子；急着用就 `uninstall.py` 回滚 |
| 钩子不触发 | 新会话没开 / `hooks.enabled` 被关 / Bash 以外工具失败 | 看 `doctor.py` 输出；钩子只认 Bash |
| 代理日志里有 attempt fail 但最终成功 | 正常，说明代理在重发 | 无需处理，看 `ok ... first=x.xxs` 那行 |
| 代理日志出现 `truncated` | 已经开始回写后断流，不能重试 | 正常现象；客户端会看到不完整的流 |

---

## 边界与限制（务必读）

1. **模式 A 不能真的重发**。钩子只能注入建议，由模型决定是否重试。模型不听就等于没做。
2. **模式 B 不能覆盖所有失败**。ZCode 客户端在整轮失败时会直接抛错；代理只能覆盖"请求还没开始回数据就失败"这一类。如果失败发生在响应流中途，代理无法重试。
3. **95 秒是客户端超时**。流式请求满 80 秒没数据就发心跳，所以 3 分钟的窗口能撑住；非流式没法插心跳，客户端可能在自己超时时先放弃。
4. **provider 配置可能被 ZCode 界面重写**。如果你在界面里改过通道设置，`baseUrl` 可能被覆盖回官方地址，此时重新执行 `install.py --with-proxy` 即可。
5. **两个配置文件的路径**：`~/.zcode/cli/config.json`（钩子）、`~/.zcode/v2/provider_config.json`（provider）。安装器只碰这两处，改前都备份。
6. **报错汇报默认不跑**。`error_watch.py` 会被安装到安装目录，但只有 `ZCODE_PERSISTENCE_WATCH=1` 时才由 SessionStart 拉起；
   它是靠轮询 `~/.zcode/cli/db/db.sqlite` 的 `session.last_outcome` 判断红点的，ZCode 改表结构就会失效——
   失效时会在 `error_watch.log` 里写 `db: 查询 session 失败`，不会静默假活。
7. **邮件发件人不能改**。outlook MCP 的账号是 `your-email@example.com`，但 `From` 必须显式写成
   `your-sender@example.com`；写成账号本名时邮件只会留在"已发送"，QQ 侧收不到（2026-10-31 实测）。
8. **本项目不是官方组件**，失败时的兜底永远是 `uninstall.py` + 配置备份。
9. **以下两件事尚未实测，只做了本端断言**：真实 ZCode 客户端对 503 / SSE 错误体的
   "自动续写"（要等下一次真实耗尽重试才能看到）、MCP 发信失败路径的恢复行为。
   `restart_proxy_idle.py` 的实际换进程已在 2026-11-01 02:58 验证（旧进程终止、单监听、`root` 正确）。

---

## 版本与维护

**接手维护请先读 `AGENTS.md`（硬约束）和 `文档/06-AI维护指南.md`（完整手册）。** 后者包含代码地图、完整不变量清单、可直接运行的测试配方、故障定位表和历史坑防回归清单。


- 每次改动请更新 `VERSION` 和 `CHANGELOG.md`。
- 新增措辞规则：只改 `src/retry_hook.py` 顶部的 `UPSTREAM_PATTERNS`（命中则建议先等 3 分钟）。v0.4.0 起没有“按错误类型决定重不重试”的列表了：任何失败都重试。改完重跑 `install.py`（幂等，会覆盖脚本）。
- 新增上游：改 `src/retry_proxy.py` 的 `UPSTREAMS`，并在 `tools/install.py` 里补对应前缀。
- 改完必须跑一遍 `文档/04-测试记录.md` 里的用例，全部通过再发版。
