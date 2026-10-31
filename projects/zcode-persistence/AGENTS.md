# AGENTS.md — 给接手维护的 AI 读

你正在维护一个 ZCode 的"失败重试"工具包。先读 `README.md` 了解它是什么，再读 `文档/06-AI维护指南.md` 了解怎么改。

## 这个包的定位

两个主组件 + 一个可选旁路（默认关闭）：
- `src/retry_hook.py`：ZCode 的 `PostToolUse` 钩子（`PostToolUseFailure` 兜底），**只建议**模型重试工具调用，不执行任何重试。
- `src/retry_proxy.py`：本地 HTTP 代理（127.0.0.1:8787），**真的会**重发模型请求。
- `src/error_watch.py`：报错汇报（可选、默认关闭）。轮询会话库的 `session.last_outcome`，
  `error`（界面红点）时把原因邮件发到 `your-email@example.com`；`completed`/`interrupted` 不报。

## 绝对不能改坏的不变量

0. 钩子主挂载点是 **`PostToolUse`**，不是 `PostToolUseFailure`（后者对本客户端的超时/中断不派发）；两个都挂，靠 `toolCallId` 去重。
1. 心跳必须是 SSE **注释行**（`:` 开头）。改成可见的 `data:` 事件会污染模型回答。
2. 心跳必须由**独立时钟**驱动（`next_hb_at`），不能挂在"某次尝试失败"的边界上，否则首次心跳会晚到一整个尝试周期，错过客户端 95 秒窗口。
3. `retry_hook.py` 的所有代码路径**必须退出码 0**。钩子永不允许阻断会话。
4. 钩子识别必须按脚本 **basename 精确相等**，不能用子串（否则 `my_retry_hook.py` 会被误判/误删）。
5. `install.py` 必须**先校验后落盘**：任何 `die()` 之前不得写配置、不得复制文件。
6. `uninstall.py` 只有在"当前 baseUrl == 记录的 proxyBaseUrl"时才还原，其它情况只警告。
7. 代理**不得记录请求/响应正文**，只记状态行（时间、路径、状态码、字节数、首字节延迟）。
8. TLS 必须用 certifi 的 CA（Windows 自带根库缺 SSL.com，会校验失败）。
9. UA 兜底不能删：中转的 Cloudflare 会拦 `Python-urllib`（回 1010）。
10. 钩子的 stdout JSON **只能用 `additionalContext`**。`systemMessage` 只对用户可见、模型看不见 —— v0.3.0 就是栽在这里：钩子明明打了 `advise` 日志，模型却照旧不重试。客户端是 zod 解析（非 strict），未知键会被剥离——但被剥离等于白写，所以仍只输出这一个键。
11. 退避不能用"立刻重试"。实测失败里 85% 是上游 **HTTP 429（并发打满）**，必须按 `RETRY_INTERVAL`（20 秒）等；上游给了更长的 `Retry-After` 就听它的（上限 `RETRY_AFTER_CAP`=60 秒）。重试总量看 `RETRY_WINDOW`（180 秒）而不是次数。
12. **不要重新加回"按错误类型筛除"**。用户规格是"只要是报错就重试三次"：钩子对任何失败都建议重试，代理对任何非 2xx 都重发。v0.3.x 的 FATAL 过滤已删除，加回来就等于违背需求。
13. 心跳是"**80 秒没有任何上游输入**才发，之后每 80 秒一条，**不设次数上限**"。别改成固定次数，也别改成收到数据也发。响应头之前由主循环的独立时钟发；响应头之后由 `pipe_response` 的 reader 线程 + 主线程消费队列来发（静默满 `HEARTBEAT_INTERVAL` 发一条，静默满 `RETRY_WINDOW` 才判截断）。
14. 退避等待期间线程必须 `sleep`，不能空转（v0.3.1 曾在 50 秒退避里 97% 打满单核）。
15. 回写上游响应体必须用 `resp.read1(n)`，**不能用 `resp.read(n)`**。`read(n)` 会为凑满 n 字节一直等，SSE 会被压成 8KB 一块才发给客户端，看起来就是不流式。
16. 响应体阶段的读取必须放在**独立线程**里（`pipe_response` 的 `reader()` → `queue_`），主线程只消费队列、按时发心跳、到点判截断。不要用 socket 超时来判静默：一旦超时，http.client 的缓冲流就变成 unusable（"cannot read from timed out object"）；就算复位私有标记继续读，chunked 的块长度行由 `readline` 读，超时会丢掉半行、下一次必然失步（`IncompleteRead`）。
17. **不要试图从另一个线程 `close()`/`shutdown()` 来打断阻塞中的读**（Windows 实测无效，且 `resp.close()` 会等 `BufferedReader` 的锁，和阻塞读互等）。截止时间到了就让主线程收尾返回，读取线程在 `put` 处看到 `stop` 就退出；若正卡在阻塞读，只能等 socket 超时（`RETRY_WINDOW+30` 秒）。
18. 上游回 `Connection: close` 时 `conn.sock` 会变成 `None`（http.client 已 close 连接对象，fd 由 makefile 的引用计数维持）。要拿 socket 必须走 `body_socket()`，它会在 `conn.sock` 为空时回退到 `resp.fp.raw._sock`；取不到时会在日志里写一条告警。

19. **503 才带 `retryable:true`，400 必须回 `retryable:false`**。503 是代理耗尽重试，
    要让客户端自己续写；400 是客户端写错了前缀/请求体，标成可重试只会被重发 10 次。
20. **`error_watch` 的 `seen` 只在邮件发送成功后推进**。被冷却/限流挡住、发信失败、
    `--once`/`--no-send` 都不许推进——否则那条报错永久丢失（2026-10-31 踩过：连发 8 封后又静默丢）。
21. **代理日志时间戳必须带日期**（`%Y-%m-%d %H:%M:%S`）。报错汇报靠它把 `gave up` 与报错时刻对齐，
    只有时分秒时跨天会把上一次故障写成这次的原因。
## 当前定稿参数（v0.4.0）

`RETRY_WINDOW=180`（秒，时间窗）、`RETRY_INTERVAL=20`（秒，固定间隔；`MAX_ATTEMPTS` 只作防跑飞保险丝，默认 200）、`SILENCE_TIMEOUT=30`、`HEARTBEAT_START=80`、`HEARTBEAT_INTERVAL=80`（无次数上限）、`PROXY_RETRY_WINDOW` / `PROXY_RETRY_INTERVAL` 覆盖窗口与间隔、`RETRY_AFTER_CAP=60`、端口 8787。

改这些默认值等于改产品规格，**必须**同步更新 `README.md`、`文档/02-维护手册`、`文档/04-测试记录` 和 `CHANGELOG.md`。

## 改完必须做的事

1. 跑 `文档/06-AI维护指南.md` 第 4 节的加速测试（四项断言全过）。
2. 跑 `python -I tools/selftest_proxy_429.py`、`tools/selftest_stream.py`、`tools/selftest_watch.py`
   （重试 5 场景 + 流式 7 场景 + 报错汇报 12 断言全过）。改了 `pipe_response` 必须跑流式那套；
   改了 `error_watch.py` 必须跑第三套。
3. 升 `VERSION` 与 `tools/install.py` 的 `VERSION`。
4. 在 `CHANGELOG.md` 记一笔"改了什么 + 为什么"。
5. 重新打包，**排除** `__pycache__`、`*.pyc`、`*.log`。
6. 交给独立子代理复核：综合与代码两项均 ≥4.5/5 才放行，低于就改完重来。

## 继续开发从这里开始（给下一个 AI / 工程师）

**先搞清版本号**：对外发正式版号（V0.2），代码里的 `0.4.0` 是构建线迭代号，
两者不是一套东西。`VERSION` 文件与 `tools/install.py` 的 `VERSION` 都写正式版号；
`CHANGELOG.md` 顶部的映射条目会告诉你当前正式版对应哪条构建线。

**五分钟上手**

1. 读 `README.md` 的「它是什么 / 限制」两节。
2. 读本文件（`文档/06-AI维护指南.md`）第 2 节代码地图和第 3 节不变量。
3. 跑一次体检：`python <安装目录>/doctor.py`，应 11 项通过、0 失败。
4. 跑一次自检：`python tools/selftest_proxy_429.py`，5 个场景应全 PASS。

**改代码前必须知道的三件事**

- 钩子只“建议”重试，真正重发的是代理；两者互不依赖，可以单独装。
- 钩子输出**只能用 `additionalContext`**；写成 `systemMessage` 模型看不见（v0.3.0 踩过）。
- **不许按错误类型筛除**。任何失败都建议重试；代理对任何非 2xx 都重发。

**改完的标准动作**

1. `python -m py_compile src/*.py tools/*.py`
2. `python -I tools/selftest_proxy_429.py`
3. 跑 `文档/06-AI维护指南` 第 4 节的心跳配方（四条断言）
4. `python tools/install.py --with-proxy --provider-id new-provider`
5. 重启代理（改的是 `retry_proxy.py` 才需要）：**不要手写 taskkill**——用
   `<安装目录>/restart_proxy_idle.py`（源码项目里在 `运维/` 下，安装器会复制到安装目录），它只在没有在飞请求时动手，
   且确认旧进程消失或 8787 端口释放（以端口为准）才拉起新进程（Windows 的 SO_REUSEADDR 允许两个监听并存，
   健康检查会由旧进程应答，看起来成功其实是双份）。等不到静默窗口才加 `--force`：
   只跳过等待，上面的检查一条不少，代价是在飞请求被掐断一次。
6. `doctor.py` 确认「代理运行参数」与脚本一致
7. 更新 `CHANGELOG.md`；正式发版时升 `VERSION` 与 `install.py` 的 `VERSION`
8. 重新打包，确认包 / zip / 已装副本三者 sha256 一致

**常见故障对照**

| 现象 | 先看什么 |
|---|---|
| 模型完全连不上 | 8787 有没有监听；`doctor.py` 的「代理运行参数」 |
| 仍弹 `Turn execution failed` | `proxy.log` 里 `gave up` 的 `reasons=`（status=429 风暴 / silence=上游挂了） |
| 建议了但模型没重试 | `hook.log` 有没有 `advise`；有就是输出字段错，没有就是钩子没触发 |
| 钩子完全不触发 | `doctor.py` 的 matcher 与脚本路径两项 |

## 不要做的事

- 不要再引入"无限重试"（v1.1.0 试过，已回退）。
- 不要把心跳做成可见内容。
- 不要跨事件子串匹配钩子。
- 不要在钩子里调用网络或做耗时操作（超时 5 秒会被杀）。
