# 变更记录

> 2026-11-01 迁移到 AI-Agent-DJY 仓库：原 `docs/` 目录改名为 `文档/`；本文件的历史条目保留当时的路径写法。

> **版本号约定**：对外只发布正式版号（V0.1、V0.2…），括号里的构建线是内部迭代号。
> V0.2 正式版 = 构建线 0.4.0 的全部内容，功能与本文件 0.4.0 条目一致。

## V0.2 正式版 — 2026-10-31

### 客户端自动续写（2026-10-31 晚）

**问题**：用户弹窗显示 `provider_code=upstream_unavailable … retryable=false`，整轮被强制结束、
左侧会话列表亮红点。旧错误码不在客户端的可重试集合里，所以 3 分钟的重试白做了。

- `retry_proxy.py` 新增 `error_body()`：放弃时回
  `{type:"server_error", code:"model_server_error", reason:"server_error", retryable:true}`。
  客户端 `z7a()` 判定链命中后会用流恢复重试（最多 10 次），并带 `previous-message-anchor`
  接着上次输出往下写，等价于自动发一条"继续"。
- 新增 `invalid_body()`：**400 仍回 `retryable:false`**。未知前缀、请求体畸形是客户端自己写错，
  标成可重试只会让确定性失败被重发 10 次（独立审查 P1-3）。
- 健康探针 `/__zp_health` 增加 `root`（脚本所在目录），换进程后能确认跑的是哪份代码。
- 代理日志时间戳从 `HH:MM:SS` 改为 `YYYY-MM-DD HH:MM:SS`，供报错汇报按时间对齐。

### 报错汇报（默认关闭）

新增 `src/error_watch.py`：轮询 `~/.zcode/cli/db/db.sqlite` 的 `session.last_outcome`，
`error`（红点）时把原因邮件发到 `your-email@example.com`；`completed` / `interrupted` 不报。

- 只认与报错时刻前后 15 分钟内对得上的 `gave up` 记录，对不上就如实说明，不硬编原因。
- 走 outlook MCP（ms-365-mcp-server 的 stdio JSON-RPC）；`From` 必须固定
  `your-sender@example.com`，用账号本名发会被 QQ 侧丢弃（实测）。
- 防刷屏：`seen` 只在发送成功后推进；同一会话冷却 600 秒；每小时上限 8 封；
  发信失败退避 60 秒且不推进状态；`--once` 只打印、不落盘。
- **默认不自启**：`ensure_proxy.py` 仅在 `ZCODE_PERSISTENCE_WATCH=1` 时拉起。
  2026-10-31 曾因去重只比时间戳导致同一故障连发 8 封，已停用并改为显式开关。

### 发布前修整（复审 P1/P2，2026-11-01）

- **修 `FAIL_RE` 对带日期日志失效**：代理日志改成 `YYYY-MM-DD HH:MM:SS` 后，正则仍以
  `^(\d{2}:\d{2}:\d{2})` 锚定，导致"失败明细"永远为空，还会把"代理在失败"误判成
  "不是代理导致的"。改为日期可选，自检拆成 7a（只有成功行）/7b（新格式有失败无放弃）/7c（旧格式同内容）。
- **日志节流**：冷却/限流/发送失败/`--no-send` 的提示按会话或会话集合节流（默认 600 秒），
  同一会话连续报错 10 分钟只留 3 行日志（此前 121 行）。
- **假活可见**：`connect_db` 打不开库也写 `db: …`（同消息 10 分钟一次）；`new_errors` 查询失败
  返回 `None` 且**不置基线**，避免库恢复后把历史红点整批发出。
- **`--once`**：绕开冷却/限流、只打印、不落盘（自检第 10 条改成跑完整 `main()`）。
- **换进程复核**：`single_listener()` 在健康探针缺少 `root`（升级前的旧代理）时判失败。
- **生命周期补全**：`uninstall.py --purge` 会按命令行结束 `error_watch.py`（不再按进程名过滤）；
  `doctor.py` 增加"报错监听"一项，并用命令行核对锁文件里的 PID 是否真的是监听进程。
- **状态文件裁剪**：`seen` 超过 200 条时只保留当前库里仍存在的会话，避免无限增长。
- **换进程脚本随包发布**：`tools/restart_proxy_idle.py` 会由 `install.py` 复制到安装目录，
  文档里的重启命令不再指向包外的私有路径。
- **文档计数统一**：自检数量统一为 5 / 7 / 12；组件口径统一成"两个主组件 + 一个可选旁路"。

### 逐块代码复核（2026-11-01 凌晨）

按"正常的不要动、只改错的"逐文件核对，发现并修两处：

- **钩子假阳性**：`retry_hook.failure_of()` 在既没有 `tool_response`、也没有任何
  `error*` 字段时，会把 `tool_name`/`session_id` 等元数据拼成"错误文本"，
  从而把成功的 Bash 调用判成失败并建议重试。现在这种情况一律不判失败；
  `tool_response` 是非字典字符串时按内容判断。新增用例 24/25。
- **卸载器杀进程不可靠**：`uninstall.py` 原来用 `taskkill`，2026-10-31 实测它返回 0
  却没杀掉代理，导致 `--purge` 删了目录进程还在跑。改为 ctypes `TerminateProcess` +
  确认退出码，`taskkill` 只作兜底；`kill_watcher()` 同步改用同一路径。

### 热更新（2026-11-01 凌晨）

- **`restart_proxy_idle.py` 新增 `--force`**：等不到空闲窗口时立即换进程。2026-11-01 实测：
  另一个会话的团队一直占着 5–7 条上游 `ESTABLISHED`，`proxy.log` 静默始终不到 1 秒，
  空闲窗口永远等不来。`--force` 只跳过"等空闲窗口"（在飞连接、日志静默、`MIN_ALIVE` 三项），
  `kill:` 验证旧进程真的消失、8787 只剩一个监听、`root` 指向安装目录这些检查一条不少；
  代价是在飞请求被掐断一次。换进程前会把目标 PID、在飞连接数、静默秒数写进 `restart.log`。
- **首次热更新落地**：旧 PID <pid>（改名前的代码，`/__zp_health` 回小写名、无 `root`）
  → 新 PID <pid>；健康探针返回 `{"name":"Zcode-Persistence", "root":"C:\\Program Files (x86)\\AI\\Zcode-Persistence"}`，
  8787 单监听，换完立即接住请求（`ok ... status=200`）。**Option A 的 503 可重试错误体自此生效。**
- **独立审查后的修正（同日）**：`netstat` 读不到时不再当成"无监听"假报成功（改为 `abort` + 退出码 1）；
  杀进程失败但端口已空时以端口为准继续拉起，不再误报"仍占用"；残留清理改为逐个验明正身、
  清完复查端口，没清干净就停止继续拉起（堵住双监听窗口）；脚本自身异常退出码改为 2（与成败 0/1 区分）；
  模块 docstring 补 `--force` 与退出码说明。上述分支已用注入替身的只读测试逐条验证。

### 测试

- `tools/selftest_watch.py`（新）：12 条断言（7 拆成 7a/7b/7c），覆盖基线、去重、冷却、限流、发信失败重试、
  `--once` 不落盘、合并多会话、无原因措辞。
- `tools/selftest_proxy_429.py`：新增场景 5（未知前缀 400 → `retryable:false`）。
- `tools/selftest_stream.py`：新增场景 7（心跳模式下放弃，SSE 错误体必须带
  `retryable:true` / `model_server_error` 且补终止块）。

### 流式回写修复（2026-10-31，独立复审 P1）

复审实测发现三处真问题，都在 `pipe_response`：

- **SSE 被 8KB 攒批**：`resp.read(8192)` 会等攒满 8KB 或流结束才返回，一条几十字节的
  SSE 事件被压到 8KB 才发给客户端，表现为"不流式"。改为 `resp.read1(8192)`。
- **流中静默 30 秒就截断**：响应头之后 socket 超时仍按 `SILENCE_TIMEOUT` 生效，
  而"80 秒无输入才发心跳"只覆盖响应头之前。更麻烦的是 `http.client` 的缓冲流一旦超时
  就变成 unusable（`cannot read from timed out object`），超时后无法续读。
  改为 **reader 线程 + 主线程消费队列**：读取线程只做阻塞读，主线程每 0.5 秒看一次队列，
  静默满 `HEARTBEAT_INTERVAL`（80 秒）发一条 `: keepalive`，累计静默满 `RETRY_WINDOW`
  （180 秒）才收尾判截断，已收到的内容不丢。
  （中途试过“看门狗线程关连接打断阻塞读”和“超时后复位标记续读”，两者实测都不可行：
   Windows 上 shutdown/close 叫不醒阻塞读；复位续读会让 chunked 的 readline 丢半行。）
- **定长响应短读被当成成功**：上游声明 `Content-Length: 100` 只发 20 字节，`read1` 不抛
  异常，旧代码会补 `0\r\n\r\n` 并记 `ok`，客户端把截断的 JSON 当完整响应。改为用
  `resp.length` 判断剩余字节，短读按 `truncated` 收尾、不补终止块。
- 配套：`body_socket()` 解决上游回 `Connection: close` 时 `conn.sock` 为 `None`、改不到
  真正在用的 socket；`_safe_handle()` + `Server.handle_error()` 把"用户在生成中途取消"
  收成一行日志，不再往 `proxy.log` 打整段 traceback。
- 新增 `tools/selftest_stream.py`（六场景：逐条透传 / 流中静默续命 / 定长短读判截断 /
  正常收尾 / 静默到窗口判截断 / 慢客户端不丢数据
  正常收尾），改 `pipe_response` 必跑。

### 代码优化（2026-10-31，V0.2 已发布后复审）

- **修掉窗口到期时的零睡眠空转**：若进程在退避期间被挂起（休眠/调试器），醒来后已越过
  时间窗，启动条件为假、失败分支又走不到，主循环会空转。主循环顶部加“窗口到期且没有
  在飞的尝试就收尾”，并已用 2 秒窗口 + 5 秒间隔复现验证（2 秒即返回 503）。
- 启动行与 backoff 行改用 `%gs`，小数间隔（测试里的 0.2）也能如实打印，与 `doctor.py`
  的默认值比对一致。
- 文档与注释对齐时间窗语义：`src/retry_proxy.py` 模块说明、`AGENTS.md` 不变量 11、
  `README.md` 模式 B 示意图、`docs/02` `docs/03` `docs/04` `docs/05` 全部去掉
  “4 次尝试 / RETRY_DELAYS / 退避表”这类过期表述。
- `install.py`/`uninstall.py` 的 `load_json` 文档字符串改为如实说明“会抛异常”；
  `uninstall.py` 的端口全部改由 `PROXY_HOST` 推导；`doctor.py` 去掉重复的 `import re`
  并修正 `resolve_prefix` 的说明；`selftest_proxy_429.py` 删除两个未使用的端口常量、
  模块说明改为四场景。

### 改为时间窗重试（2026-10-31，V0.2 试运行）

- 用户要求：**不按次数走，持续重试 3 分钟，每 20 秒一次**。
- `MAX_ATTEMPTS` 不再决定放弃时机，改由 `PROXY_RETRY_WINDOW=180`（秒）控制；
  间隔固定 `PROXY_RETRY_INTERVAL=20`（秒）。`MAX_ATTEMPTS` 降级为防跑飞的保险丝（默认 200）。
- 实测（加速参数 1 秒窗口 / 0.2 秒间隔）：4 个自检场景全 PASS；持续失败时窗口结束才放弃。
- 放弃文案改为“已持续重试 N 秒仍失败（共 M 次尝试：…）”。
- 边界：流式请求靠 80 秒心跳撑满 3 分钟；非流式插不了心跳，客户端可能先超时。

### 慢重试调参（2026-10-31，V0.2 试运行）

- 现场：上游在 **TLS 握手阶段**被掐断（`SSLEOFError: UNEXPECTED_EOF_WHILE_READING`），
  连续 4 次尝试全部是 `connect` 失败，用户看到“已自动重试 3 次仍失败（other,connect,connect,connect）”。
- 处理：重试间隔从 5/15/30 秒改为**每次固定 10 秒**（`PROXY_RETRY_DELAYS=10,10,10`），
  4 次尝试的总窗口约 30 秒 + 各次握手耗时，给上游恢复留时间。
- 说明：这只改变重试节奏，不能修复上游故障；若 4 次全失败仍会报错，属预期。


首个对外正式版，包含：

- 任何报错自动重试 3 次（钩子建议 + 代理重发，代理退避 5/15/30 秒）
- 连续 80 秒无上游输入发心跳（`: keepalive`），之后每 80 秒一条，不限次数
- 钩子输出 `additionalContext`（模型可见），日志不落错误正文
- 安装/卸载/自检/健康检查全套：`install.py`、`uninstall.py`、`doctor.py`、`selftest_proxy_429.py`


## 0.4.0 — 2026-10-30（规格对齐：任何报错都重试三次；心跳 80 秒）

用户重新下发的两条硬规格，这一版按字面实现：

### 一、任何报错都自动重试三次

- **钩子**：删掉 FATAL 过滤（旧版把 `permission denied`、`not found`、`syntax error` 等判为"确定性错误"直接放弃）。现在只要 Bash 调用失败就建议重试，上限仍是 3 次（第 4 次失败后不再建议，要求模型向你说明卡点）。上游没产出一类仍建议先等 3 分钟再发，因为立即重发基本还是失败。
- **代理**：重试条件从固定白名单 `{408,425,429,500,502,503,504}` 改为**任何非 2xx**。代价是明确的：`400/401/404` 这类重发也没用的错误，也会等 5+15+30 秒才把原错误报给你。这是按"所有报错都重试"的规格主动接受的。

### 二、心跳改为 80 秒、无次数上限

- `HEARTBEAT_START` 与 `HEARTBEAT_INTERVAL` 统一为 **80 秒**：连续 80 秒没有任何上游输入才发第一条 `: keepalive`，之后仍是每 80 秒一条，**不封顶**。
- 80 秒而不是 90 秒，是给客户端 95 秒首字节超时留 15 秒余量。

### 三、审查发现的必修项（均来自独立子代理的 v0.3.1 审查报告）

- **P0 修掉忙等**：退避等待时主循环 `q is None` 分支不睡，实测 50 秒退避吃掉 97% 单核。现在改为睡到"下次尝试"或"下次心跳"里先到的那个（实测 2 秒退避只耗 0.25 秒 CPU）。
- **P1 修掉空退避表崩溃**：`PROXY_RETRY_DELAYS=""` 会让 `RETRY_DELAYS` 为空表，`[-1]` 直接 IndexError、连接无响应。改为解析失败/空表回落到 `5,15,30`。
- **P1 文档对齐**：`docs/02` 的默认值表（3 次、90 秒、已删除的 `PROXY_RETRY_DELAY`/`PROXY_MAX_BACKOFF`）、`docs/05` 里永远不成立的英文断言、`docs/04` 结果列的 502/3 次，全部按 0.4.0 重写；第二轮复审又发现 README 的"不会建议重试"清单、docs/03 的 FATAL 流程图、docs/02 的回归样本表仍描述旧模型，一并在本版修掉。
- **P2**：`Retry-After` 支持 HTTP 日期形式；`HOP_BY_HOP` 加入 `server`/`date` 避免重复响应头；钩子输出改 `ensure_ascii=True` 规避 Windows 管道 GBK 码页。
- **测试**：`tools/selftest_proxy_429.py` 扩到 4 个场景（429 恢复 / 持续 429 / 400 恢复 / 持续 400），端口自动选取。恢复场景断言第 3/4 次命中后返回 200，持续失败场景断言 4 次尝试后返回 503 错误体。

### 四、发版前最后一轮（终验意见）

- **trailer 超限不再污染连接**：chunked 的 0 块之后最多读 100 行 trailer，超出直接按畸形请求返回 400（此前多余字节会被 keep-alive 当成下一个请求，实测报 `Bad HTTP/0.9 request type`）。
- **端口占用可识别**：代理新增 `GET /__zp_health` 探针；`ensure_proxy.py` 在端口已被占用时先探测身份，不是本代理就在 `proxy.log` 告警，避免"别的进程占着 8787，provider 打到错误服务"却毫无痕迹。
- **钩子日志不再落错误正文**：`hook.log` 只记次数与类型（`advise: 1/3 kind=error`），不写错误首行；异常分支也只记异常类型，不写原始输入。
- **重装会改写旧钩子**：`install.py` 的 `ensure_hook()` 对已存在的同脚本钩子比对 `command`/`args`/`matcher`/`timeoutMs`/`statusMessage` 并就地修正；换 `--prefix` 重装不再留下指向旧目录的钩子。
- **doctor 校验更严**：两个工具钩子除 basename 外还检查 `matcher == "Bash"`，三处钩子都检查脚本路径是否存在，并新增 `hooks.enabled` 展示；「代理运行参数」比对 `attempts`/`silence`/`heartbeat>=`/`every` 四项。
- **环境变量加上下界**：`PROXY_PORT=65536`、`MAX_ATTEMPTS=1e308` 这类"有限但非法"的值也回落默认值。


## 0.3.1 — 2026-10-30（真正会重试了：两个"假修复"一起解决）

**0.3.0 有两个坑，现场证据如下，都已修掉。**

### 坑一：钩子输出了模型看不到的字段

- 现场：新会话跑测试命令，`hook.log` 里明明写了 `advise: 1/3 (timed out) kind=transient`，模型却回"命令已按原样执行完毕，没有重试"。
- 原因：输出了 `{"systemMessage": ...}`。这个字段只对用户可见，**不注入模型上下文**，模型根本收不到。
- 修复：改为 `{"additionalContext": ...}`（ZCode 钩子文档明确写了该字段会注入会话）。JSON schema 是严格的，只输出这一个键。

### 坑二：上游 429 被"立刻重试"白烧掉

- 现场统计（`proxy.log`，1771 次成功请求）：失败尝试 994 次，其中 **849 次是 HTTP 429**；`gave up` 230 次里有 **201 次是 `status,status,status`**，即三次全撞 429。用户看到的 `Turn execution failed ... retryable=false` 弹窗就是这么来的：代理放弃了，客户端又声明不可重试。
- 原因：旧逻辑对 429 也是"立刻重试、退避上限 10 秒"，而 429 的真实含义是上游并发打满，需要等。
- 修复：
  - `MAX_ATTEMPTS` 3 → **4**（首次 + 3 次重试），对上"任何报错自动重试三次"。
  - 新增 `RETRY_DELAYS=5,15,30` 递进退避；上游给 `Retry-After` 就取较大值（上限 `RETRY_AFTER_CAP=60`）。
  - `HEARTBEAT_START` 90 → **60**（秒）：退避期间先把 SSE 心跳挂上，客户端不会在等待中先超时。
  - 放弃时返回 **503 + OpenAI 形状错误体**（`type=server_error`），不再是纯文本 502。
    （当时 `code=upstream_unavailable`；2026-10-31 起改为 `model_server_error` + `retryable:true`，
    见下方"客户端自动续写"条目。）

### 其他

- 新增 `tools/selftest_proxy_429.py`：本机回环自检 429 重试链路，两个场景（429 两次后恢复 / 持续 429）全自动断言，不需要真实中转。
- `AGENTS.md` 增补不变量 10、11（字段只能用 `additionalContext`；退避不能立刻重试）。
- 文档：本轮只同步了 `README.md` 的数字与 `docs/05` 的断言文案；`docs/02`、`docs/03`、`docs/04` 仍残留按错误类型筛除的旧模型，已在 0.4.0 修完（见下）。

## 0.3.0 — 2026-10-30（钩子真正能触发了）

**这是一个实质性修复。0.2.0 及之前，钩子在真实使用中一次都没有触发过。**

- 实测：本客户端对"被中断 / 超时"的 Bash 调用**不派发** `PostToolUseFailure`；命令非零退出也不算工具失败。所以只挂 `PostToolUseFailure` 等于永远不生效。
- 改为主挂 `PostToolUse`（`matcher=Bash`），从 `toolResponse` 的 `exitCode` / `timedOut` / `status` / `stderr` 判断失败；`PostToolUseFailure` 保留为工具抛异常时的兜底。
- 新增按 `toolCallId` 去重（120 秒窗口），避免两个事件同时触发导致建议两遍。
- 错误文本改为只取 `stderr` + `stdout`（不再扫整个 payload），从根上消除元数据误报。
- `doctor.py` 同时检查主挂载点与兜底挂载点。

## 0.2.0 — 2026-10-30（项目改名为 Zcode-Persistence）

**改名版本，代码逻辑与 0.1.2 完全一致，只改标识与路径。**

- 项目目录：`zcode-retry-hook` → `Zcode-Persistence`
- 包目录 / ZIP：`zcode-retry-hook-v0.1.2` → `Zcode-Persistence-v0.2.0`
- 安装目录：`C:\Program Files (x86)\AI\zcode-retry-hook` → `...\AI\Zcode-Persistence`
- 钩子状态与日志目录：`%TEMP%\zcode-retry-hook` → `%TEMP%\Zcode-Persistence`
- 所有文档、脚本默认值、AGENTS.md 同步更新
- 升级方式：先跑旧包的 `uninstall.py`，再用新包 `install.py`，最后删除旧安装目录

## 0.1.2 — 2026-10-30

- 修正 `docs/05-AI维护指南.md` 中的时间估算：加速配方三次尝试实测 9.7 秒（原写"约 11 秒"），并写明计算式。
- 无代码改动，运行行为与 0.1.1 完全一致。

## 0.1.1 — 2026-10-30

仅维护性修复，行为与 0.1 一致，参数未变。

- `src/retry_proxy.py`：修正过期注释（心跳早已是独立时钟 + 90 秒间隔，注释仍写"每次失败都发、不设上限"）；日志统一抹掉 query 串，避免上游把密钥放在 URL 参数时落盘。
- `tools/doctor.py`：钩子检测改为按脚本 basename 精确匹配，与 install/uninstall 一致（原先子串匹配会把 `my_retry_hook.py` 误判为已安装）。
- `tools/install.py`：把"写入之后才 die"的异常路径改为只警告、不改动，消除结构性隐患。
- 文档：新增 `AGENTS.md` 与 `docs/05-AI维护指南.md`；重写测试配方（四条断言可自动判定）；订正 `docs/02` 中不存在的符号名与 `docs/04` 的加速参数。

## 0.1 — 2026-10-30（首个正式版）

定稿参数：

- **重试**：最多 3 次尝试（含首次，即失败后重试 2 次），流式与非流式一致。
- **心跳**：流式请求满 90 秒无数据时发第一条 `: keepalive`，之后每 90 秒一条。
- **退避**：1 秒起翻倍，上限 10 秒。
- 心跳由独立时钟驱动，不等某次尝试失败才发。
- 全部节奏可用 `PROXY_*` 环境变量覆盖（`MAX_ATTEMPTS` 最小为 1）。

文档补全：新增 `AGENTS.md`（硬约束速查）与 `docs/05-AI维护指南.md`（代码地图、不变量、测试配方、故障定位、防回归清单），供任意 AI 接手维护。

版本号按用户要求定为 0.1。开发过程中的 1.0.x / 1.1.0 均为内部迭代，对应安装包已删除，不对外保留。
