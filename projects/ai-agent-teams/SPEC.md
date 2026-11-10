# Ai-Agent-Teams-Zcode - 完整逻辑与交付规格

Spec revision: 2026-10-28 (historical target-design revision)

Status: **target specification, not an implementation or release claim**. The current working source/package metadata is `0.2.2` and is unreleased; `VERSION`, `package.json`, plugin metadata, and marketplace metadata agree (`npm run check`, 2026-11-11). Current implementation and acceptance status are tracked in `docs/contracts.md`, `docs/test-matrix.md`, and `docs/status/STATUS.md`.

Audience: the next implementing model, the host team building the native tab, and the maintainer.

---

> v0.6 addendum: lazy members, licenses, warm/cold lifecycle, contractors, post-merge review, and captain patrol are implemented in `config/example.v06.json` and `docs/design-v0.6-roster-and-licenses.md`. Legacy configs keep the 6/3-3 behavior described in the main spec. Where this spec and the v0.6 design differ, the design document is authoritative for v0.6 configs.

## 0. 怎么用这份文档

- 本文是**目标规格**，不是当前运行契约或实现状态表；不得以本文推断功能已实现。已实现行为以源码、`config/schema.json`、测试及 `docs/contracts.md` 为准；`docs/test-matrix.md` 记录目标与测试覆盖差距，`docs/status/STATUS.md` 记录当前工作状态。
- 文中 API、SQL、里程碑和发布步骤是目标设计或历史计划，不保证与当前实现一致；涉及具体现状时须对照上述实现证据。
- 只有引入新的架构决策时才需要新增 ADR；不得为记录既有行为或改写历史而回填/重写 ADR。
- 阅读顺序：第 1 节（产品）→ 第 2 节（与原作品的差距核查）→ 第 3 节（领域模型）→ 第 4 节（调度）→ 第 5 节（质量门禁）→ 其余按需。
- 不要把本文当成“已经实现”的宣传材料。它描述的是**目标逻辑**，不是运行结果。

---

## 1. 产品定义

### 1.1 目标

给 ZCode 提供一个团队控制面：

- 1 个队长（captain）指挥 2 支队伍（team）。
- 全局最多 1 个可选的小队长（shadow，影子主代理）：主代理分身乏术时按需启动，任务完成即关闭；权限等同 captain，但以自己的 memberId/licenseId 留痕，不冒充 captain 席位。
- 每队 1 个 lead，员工编制 8–32 人，默认 16 人、上限 32 人；编制是 roster 容量，不等于并发槽位。
- 两个固定外包岗位：巡查（`patrol`）与合并审核（`merge`），各 cap 1，合计不超过 `contractors.maxConcurrent`；旧配置的 `main` 仅作为 `patrol` 的 legacy alias。
- 全局默认 6 个“真正干活”的活跃成员槽位，可调；小队长不占交付任务槽位。
- 每个成员是一个独立的 ZCode 会话，由 daemon 通过 ZCode Protocol 或 CLI 唤醒。
- 任务持久化、带依赖、带 attempt 令牌、带质量门禁、可恢复。
- 隔离分层：worktree → 容器 → 微 VM。
- 打断分层：queue → guide → stop。
- 原生团队 tab 由宿主团队实现；daemon 提供稳定 HTTP/SSE API。

### 1.2 非目标

- 不是当前聊天窗口内的原生插件；团队在原生 tab 里。
- 不依赖隐藏 subagent API；只使用公开 CLI 和 ZCode Protocol。
- 不宣称生产可用、绝对安全或 32 并发。
- 不替代 ZCode 本身的模型、工具、权限系统；只做团队控制面。

### 1.3 硬性编制

| 项 | 默认 | 上限 | 说明 |
| --- | --- | --- | --- |
| Captain | 1 | 1 | 指挥两队 |
| Shadow / workspace | 0（按需启动） | 1 | 影子主代理；权限等同 captain，不占交付槽；完成即停 |
| Team | 2 | 2 | 每队一个 lead |
| Lead | 1 / team | 1 / team | 控制会话，不默认占 6 个 worker 槽 |
| Member / team | 16 | 32（下限 8） | 数据库里的工位，不是进程；编制范围 8–32 |
| Total members | 32 | 64（下限 16） | 2 × 8 至 2 × 32 |
| Contractor slots | 2 | 2 | `patrol`（巡查）与 `merge`（合并审核），各 cap 1 |
| Active worker slots | 6 | 可调 1–32 | 全局共享；默认动态分配，`dynamicTeams=false` 时才是 3/3 |
| Active containers | 6 | 同 active slots | 只有干活的成员才开 |

**“编制”与“并发”必须分开。** 每队 8–32 个工位不等于 32 个容器；默认只有 6 个 worker 在跑，其余排队。`zcode.maxConcurrentSessions` 只统计 worker session；captain、shadow 和两个 lead 是控制会话，不占这个预算；它必须 >= `scheduler.activeWorkerSlots`。小队长在同一时刻只能有一个实例，启动时复用同一个 seat，停止后保留 seat 以便再次启动。

### 1.4 成功标准

- 6 个活跃成员的完整 e2e：建队 → 审批 → 派工 → 依赖 → 评审 → 修复 → 合并 → 归档。
- 32 编制、6 活跃时，调度公平、无饥饿、无孤儿任务。
- 任意成员崩溃/卡住/被移除，都能在 lease 内收敛，不静默停摆。
- 交付审计能拒绝“没被审过的代码”“越界修改”“没有 verify 的实现”。
- 下一个模型只读仓库文档即可继续实现，不需要口头上下文。

---

## 2. 与原作品的差距核查

### 2.1 本次再次核查发现的 12 个深层行为

这些行为在 dsh-agent-teams 的源码里存在，但 README 没有完整写出。之前的设计只覆盖了概念，没有写成规则：

1. `handoffId` / `handoffFromMemberId` / `reassigning`：转派不是“改 assignee”，而是撤销旧能力、等待旧成员静止、再启动新 attempt。
2. `supplementalEvidence`：终态任务只能追加证据，不能改 verdict，也不能重开。
3. `contractSnapshot` + `contractStaleness` + work-order warning：自动生成的合同引用的文件变了，派工时要警告，不能盲改。
4. `verdictStartSnapshot` + `reviewedArtifacts` + `reviewedGaps` + `reviewedScope` + `reviewedDuringDrift`：verdict 绑定到具体字节，不绑定到任务 id。
5. `canDeclareDelivery`：交付是独立门禁，检查失败门禁是否有后续 repair、完成的 implementation 是否有 passing review、是否有 artifact gap。
6. `amendTaskContract` + `revisions` ledger：队长可改合同，但只能改非终态任务，通过 review 后冻结。
7. `ReviewPolicy`：`requiredReviewers`、requirements 最小/最大轮次、code 最大轮次、最大修复次数。
8. `classifyMemberFailure` / `failMemberOpenAttempt` / fallback route / `spawnError` / `stopping`：成员失败不是一个 `error` 字符串。
9. Tool policy 的内置 deny：captain 工具永不开放、四个协调工具永远保留、policy 只能选 id。
10. Mail 的 delivery claim / discard / current-mail 作用域：过期邮件不能唤醒收件人。
11. Plan 的 `awaiting_feedback` + discard 控制上下文：用户退回修改后，模型不得自动重建团队。
12. Snapshot 的视觉状态与 DAG 深度：`blocked/open/claimed/running/completed/failed/cancelled` 是从状态和依赖推导出来的，不是手写字段。

### 2.2 12 条硬规则（必须写进实现）

| # | 规则 | 关键要求 |
| --- | --- | --- |
| R-01 | attempt 是能力令牌 | 每次派工发 `attempt_id`；转派先撤销旧 attempt；终态不可重开；补充证据只追加 |
| R-02 | parked != pending | 空闲但持有开放 attempt 时停驻；只有显式转派才轮换；冷启动只恢复未观察 attempt 一次 |
| R-03 | 依赖只认 completed | failed/cancelled 永不解锁；失败门禁用 `findingSourceTaskIds` 做因果边，不写进 dependencies |
| R-04 | verdict 绑定字节 | 记录 artifact digest、scope、attempt、drift；文件变了/删了/不可读/有 gap，交付拒绝 |
| R-05 | pass 不能带未解决高危 finding | review/requirements 完成必须 `verdict=pass` 且无 open high/blocker |
| R-06 | 实现类完成必须有证据 | acceptanceResults 全覆盖；commandsRun 全覆盖；changedPaths 全在 inScope；失败命令强制 failed |
| R-07 | repair scope 从 findings 推导 | 观察文件 + requiredFix 路径；默认排除项；全被排除则升级；最大轮次/次数；checker != implementer |
| R-08 | 交付审计是硬门禁 | 独立 `canDeclareDelivery`；blockers/warnings 分开；不凭“看起来完成”交付 |
| R-09 | 成员生命周期是事务 | 移除要撤销 attempt、归还任务、中断、等待静止；一人一个开放任务；队长接管同时一个 |
| R-10 | 邮件带作用域 | delivery claim/delivered/read/discard；task/attempt 过期邮件丢弃；禁止冒名 |
| R-11 | 计划是 staged 的 | 批准前零 live session、零已派发任务（允许 draft 占位行）；编辑原子；运行中只能改未开始 pending；discard 不自动重建 |
| R-12 | 策略/档案是声明式快照 | toolPolicy 只选 id；协调工具保留；captain 工具永不开；profile/route 快照冻结 |

### 2.3 六组二级逻辑：本次全部定死

#### 2.3.1 授权矩阵

| 动作 | Captain | Shadow | Lead | Member |
| --- | --- | --- | --- | --- |
| 创建/归档 team | ✅（最多 2 个 active） | ✅（同 captain，写 `shadow.action`） | ❌ | ❌ |
| 审批 staged plan | 只能执行用户明确批准；不能自批 | 同 captain；不能自批 | ❌ | ❌ |
| 编辑 plan | staged：✅；running：只能改未开始 pending | 同 captain（两队） | staged：本队 ✅；running：本队未开始 pending ✅ | ❌ |
| 创建/编辑 task | 两队 ✅ | 两队 ✅ | 本队 ✅ | ❌ |
| 领取 task | 只能通过 reassign 接管，一人一个 | 同 captain | 只能 reassign 给成员 | 只能领自己的/未指派的 ready task |
| 转派/重试 | 两队 ✅ | 两队 ✅ | 本队 ✅ | ❌ |
| 移除成员 | 两队 ✅ | 两队 ✅；不能移除自己 | 本队 ✅ | ❌ |
| halt/resume | 任一队或两队 ✅ | 任一队或两队 ✅ | 只能暂停本队派工（soft pause），不能改 halted | ❌ |
| 改跨队优先级 | ✅ | ✅ | ❌ | ❌ |
| 消息 | 任意 | 任意 | 本队 + captain + 跨队 | 任意队友/captain/跨队 |
| 修改合同 | ✅（非终态，冻结后不可） | ✅（非终态，冻结后不可） | ❌ | ❌ |
| 消费 worker 槽 | 只有接管任务时算 1 个 | 只有接管任务时算 1 个 | 只有亲自执行任务时算 1 个 | ✅ |

冲突规则：Captain ≥ Shadow > Lead > Member；captain 的显式指令优先于 shadow。Shadow 不是第二个 captain 席位，不自动接管 captain 的 plan，也不能冒充 captain 身份；所有跨级动作写 audit，shadow 的所有非 GET 动作额外写 `shadow.action`。全局最多一个 shadow；shadow 不能修改/删除自己的 seat 或 license，不能创建第二个 shadow，不能审查自己的实现，不能绕过 attempt/lease/质量门禁。Captain 可以停止 shadow 并收回其 seat；shadow 只能停止自己，不能自行退掉 seat。

#### 2.3.2 评审政策

默认值：

```json
{
  "requirementsMinRounds": 1,
  "requirementsMaxRounds": 2,
  "codeMaxRounds": 3,
  "maxRepairAttempts": 2,
  "requiredReviewers": []
}
```

- `requiredReviewers` 是成员名数组。对每个 implementation/repair，**每个 required reviewer 都必须有一次针对当前 artifact digest 的 passing review**，否则交付阻断。
- required reviewer 不能是同一任务的 implementer；配置冲突在创建团队时拒绝。
- required reviewer 被移除时，Captain 必须替换或带 reason 豁免；豁免写入 audit，并在交付 warnings 里显示。
- review 任务占用 worker 槽；当有 pending review 且槽位满时，review 优先于新的 implementation 派工。
- 早期轮次的 pass 不算数；只认绑定当前 artifact digest 的最新 verdict。

#### 2.3.3 证据、artifact 与交付

**默认排除路径**（不可作为 inScope/repair scope，除非显式豁免）：

```text
.git/ .dsh/ .zcode/ node_modules/ secrets/ .env .env.* id_rsa*
*.pem *.key *.p12 *.pfx
```

**路径匹配**：workspace-relative POSIX；前缀目录（`src/`）、glob（`src/**/*.ts`）、精确文件；拒绝绝对路径、`..` 逃逸、反斜杠、symlink 逃逸；Windows 下大小写不敏感，其他平台大小写敏感。

**Artifact digest**：

```json
{
  "path": "src/a.ts",
  "present": true,
  "sha256": "...",
  "size": 1234,
  "mtimeMs": 1234567890,
  "unreadable": false,
  "reason": null
}
```

- `present=false` 与 `unreadable=true` 绝不混淆；不可读不能当成“没变”。
- `scopeGap` 记录未能枚举的目录/超限/非相对路径；有 gap 时交付阻断。
- Verdict 开始时取 `verdictStartSnapshot`；关闭时取 `reviewedArtifacts`；期间变化写 `reviewedDuringDrift`。
- 自动生成合同取 `contractSnapshot`；引用文件变化时派工提示 work-order stale。

**交付审计 blockers**：

- team 处于 staged / halted / escalated。
- 没有任务，或所有任务都被 cancelled。
- 非质量任务不是 completed/cancelled。
- 质量任务未完成；failed 的质量任务没有后续 repair。
- 完成的 requirements/review 没有 `verdict=pass`。
- 完成的 implementation/repair 没有针对当前 artifact 的 passing review。
- required reviewer 缺失或没有当前 verdict。
- changedPaths 越界。
- artifact drift / gap / unreadable。
- 成员自报 changedPaths 与 daemon `git diff` 不一致。

**Warnings（不阻断）**：work-order stale、supplemental evidence、非 blocker 的 finding、豁免的 required reviewer。

#### 2.3.4 成员失败、fallback 与上下文

| 失败类 | 处理 |
| --- | --- |
| spawn failure | 重试 2 次（5s/15s）；仍失败 → `lost`，任务回 pending，升级 Captain |
| model/provider failure | 有 fallback 路由则切换并重试 1 次；无/仍失败 → fail open attempt，任务 failed，Captain 决定重派 |
| tool failure | 成员可在一轮内重试；回合结束未更新 → parked/lease |
| timeout/stall | lease 到期 → stop/kill → attempt 失效 → 任务 pending → 重派；连续 2 次升级 |
| container crash | 保留 worktree；清理容器；新 attempt；检查未提交改动 |
| protocol/capability failure | 暂停新派工，capability probe，fail closed |

**上下文生命周期**：

- 每个成员 session 持久化；超过 70% context 或完成 5 个任务后执行 `session/compact`。
- compact 失败/溢出：为同一成员创建新 session，注入角色摘要 + 当前任务；member row 保留，session id 更新，lineage 记录旧/新。
- 保留最近 3 个任务摘要；不保留全部工具输出。
- Captain/Lead 同样按 70% 压缩；压缩后重新注入 1 段短协议。

**路由**：

- 创建时快照 provider/model/reasoning；后续配置变化不改已有成员，除非显式 update。
- fallback 只在可重试 provider 失败时激活；记录 `fallbackActive`；主路由快照不变。
- 模型/provider 必须能在 live catalog 解析；否则创建失败并列出可用项。
- 不允许静默跨 provider 切换。

**深度/编制**：

- `memberMaxDepth=0`：成员不得调用 `Agent`、`Task`、`CreateWorkflow` 或任何再派工工具；通过工具策略拒绝。
- 若配置为 1，允许一层后代，lineage 记录 depth；超过 1 拒绝。
- 每队 `maxMembers=32`，默认 16；超过拒绝；活跃槽 6 全局。

#### 2.3.5 容器、worktree 与合并

- 每个活跃任务一个 worktree；分支 `agent/<team>/<task>/<attempt>`；base 为团队 base commit。
- 每个活跃成员一个容器；容器只挂该 worktree 和该成员的 home volume。
- 容器规格：非 root、只读根、tmpfs `/tmp`、无宿主 home、无 Docker socket、`--cap-drop ALL`、`no-new-privileges`、CPU/内存/pids 限制、网络只放行 token 网关。
- 合并：按依赖顺序串行；cherry-pick 每个任务；合并前在干净 integration worktree 跑 verify；冲突不强制，生成 integration/repair 任务。
- 合并成功记录 commit；worktree 保留 24h 后清理；失败保留用于诊断。
- 容器崩溃不清 worktree；未提交改动保留；新 attempt 先检查 `git status`。
- 绝对隔离：容器共享内核；要防恶意逃逸用微 VM（Kata/gVisor/Firecracker）。默认容器，`microvm` 可选。

#### 2.3.6 能力与 API

**能力探测**：

- 启动时跑 `zcode --help` + Protocol handshake，记录版本和方法：`session/create`、`session/send`、`session/stop`、`session/cancelBackgroundTask`、`session/setModel`、`session/setThoughtLevel`、`session/events`。
- 缺 `guide` → 降级 queue；缺 `stop` → kill 进程；缺 `setModel` → 用 session 默认并 warning；缺 `events` → 轮询；缺 create/resume → fail closed。
- 只支持已测试的主版本；未知版本先 probe，不直接放行。

**原生 tab API**：

- `/api/v1`，Bearer token；worktree 模式 loopback only，container 模式为容器回连绑定 `0.0.0.0` 但 `/ui` 仍 loopback-only；discovery 按工作区写入 `~/.ai-agent-teams/workspaces/<hash>/runtime.json`（port/token/pid/version/workspace/instanceId/apiVersion）。
- REST + SSE；32/64 成员分页；写操作全部走 daemon。
- 事件：`team.updated`、`member.updated`、`task.updated`、`message.created`、`gate.updated`、`usage.recorded`、`scheduler.updated`、`plan.updated`、`team.archived`。
- API 版本化；破坏性变更升 `/api/v2`，保留一个 minor 周期的兼容层。

### 2.4 机制映射

| 原作品 | 我们 | 必须保持的语义 |
| --- | --- | --- |
| `agent/status` | session 回合结束 + lease | idle/parked/cold recovery |
| `startContinuable/followup` | Protocol `session/create`/`send`/`resume` | 成员身份与上下文连续 |
| `attemptId` | SQLite `attempt_id` + `handoff_id` | 迟到写入拒绝 |
| `team.json` | SQLite | 同一状态机 |
| JSONL 邮箱 | `messages` 表 | 同一投递状态 |
| 宿主 Web/UI | daemon HTTP/SSE + 原生 tab | 同一快照字段/视觉状态 |
| `systemPrompt.section` | 每 session 首轮协议 + 持久历史 | 协议稳定、可缓存 |
| `tool restrict` | 策略解析 + 自定义 agent tools + `--disallowed-tools` | 可见性与调用双重限制 |
| 文件锁 | SQLite WAL + 每队锁 | 同队串行、跨队并发 |
| archive 目录 | archive 表 + 会员 session 保留 | 只读历史、不可唤醒 |
| lineage | session parent/team/lead/depth | 同一 lead 身份与深度上限 |

### 2.5 有意差异（不是差距）

- 2 队 vs 原作品 1 队。
- 16/32/6 vs 原作品 8 人上限。
- 容器/微 VM vs 原作品无 worktree。
- 原生 tab vs 原作品宿主内面板。
- daemon/SQLite vs 原作品文件状态/单进程。
- MVP 禁止跨队任务依赖，只允许消息。

---

## 3. 领域模型

### 3.1 实体与关键字段

| 实体 | 关键字段 |
| --- | --- |
| Team | id, name, phase, control, planReviewState, captainSessionId, profileSnapshot, baseCommit, createdAt, archivedAt |
| Lead | id, teamId, sessionId, status, model, contextUsage |
| Member | id, teamId, name, role, sessionId, provider, model, reasoning, fallback, activeRoute, toolPolicy, status, spawnError, worktreeId, containerId, joinedAt, lastSeen |
| Task | id, teamId, subject, description, status, assignee, dependencies, attempt, attemptId, handoffId, reassigning, kind, round, objective, inScope, outOfScope, acceptance, verify, deliverables, nonGoals, verdict, findings, changedPaths, acceptanceResults, commandsRun, reviewedTaskId, sourceTaskId, sourceFindingIds, findingSourceTaskIds, coverageOf, contractSnapshot, verdictStartSnapshot, reviewedArtifacts, reviewedGaps, reviewedScope, reviewedDuringDrift, revisions, mergeState |
| Attempt | taskId, attempt, attemptId, assignee, leaseExpiresAt, lastHeartbeat, status, startedAt, endedAt, failureClass |
| Gate | taskId, round, kind, verdict, findings, reviewerId, artifactsDigest, createdAt |
| Message | id, teamId, from, to, content, ts, taskId, attemptId, sourceTaskId, sourceAttemptId, sourceTaskStatus, deliveryClaimedAt, deliveredAt, readAt, discardedAt |
| Plan | teamId, version, status, members, tasks, approvedAt, revisions |
| Session | sessionId, memberId/leadId/captain, protocolVersion, status, contextUsage, lastEventAt |
| Container | id, memberId, taskId, image, worktreeId, status, limits, startedAt |
| Worktree | id, taskId, path, branch, base, status, commit |
| Usage | teamId, memberId, taskId, turnId, input, output, cacheRead, cacheWrite, reasoning |
| Event | id, teamId, type, payload, createdAt |
| Capability | zcodeVersion, protocolVersion, methods, checkedAt |

### 3.2 团队状态机

```text
phase:    draft -> staged -> running -> completed -> archived
control:  active -> halted | escalated -> active
plan:     awaiting_review -> awaiting_feedback -> approved | discarded
```

规则：

- `staged` 只有占位成员和 DAG；零 live session、零已派发任务。
- `control=halted` 只能由人/队长显式 resume（带 reason）。
- `control=escalated` 是自动循环到上限；不是 halt；不自动恢复。
- `completed` 需要交付审计通过；`archived` 只读。
- 两队独立；Captain 可分别 halt/resume/approve。

### 3.3 任务状态机

```text
pending -> claimed -> in_progress -> completed | failed | cancelled
```

- terminal 不可重开；补充证据只追加。
- `reassigning`、`parked`、`stalled`、`mergeState` 是正交标志。
- `claimed` 不能直接 completed。
- 一个成员同一时间只能一个未完成任务。
- `mergeState`: none → pending → merged | conflict | failed；合并失败生成 integration/repair。

### 3.4 成员状态机

```text
unspawned -> starting -> idle <-> working -> stopping -> removed
                              \-> lost
```

- `stopping` 不接新任务；等待静止或超时 kill。
- `lost` 触发 attempt 失效、任务重派、容器清理。
- `spawnError` 必须展示。
- 压缩/新 session 不改变 member identity。

### 3.5 邮件状态机

```text
queued -> claimed -> delivered -> read
   \-> discarded（任务已变/收件人移除/过期）
```

### 3.6 门禁 / 计划 / 容器状态

- Gate: `open -> passed | failed -> escalated`；repair/review 轮次由门禁生成。
- Plan: `draft -> staged -> approved | discarded`；`awaiting_feedback` 是 staged 子状态。
- Container: `creating -> running -> stopping -> removed`；`failed` 可重建。
- Worktree: `creating -> active -> merged | conflict | abandoned -> cleaned`。

### 3.7 不变量

| ID | 不变量 |
| --- | --- |
| INV-001 | 1 captain, 2 teams, 1 lead/team, optional 1 shadow/workspace |
| INV-002 | 员工编制 8..32/team，默认 16，max 32 |
| INV-003 | activeWorkerSlots=6 默认；不得默认 32 并发 |
| INV-004 | 只有活跃 worker 有 session/container |
| INV-005 | 每次派工有 attempt_id；迟到拒绝 |
| INV-006 | 每个开放 attempt 有 lease；过期必须升级 |
| INV-007 | reviewer != implementer |
| INV-008 | verify 由 daemon 在任务容器/verify sandbox 执行，成员自报只作补充 |
| INV-009 | worktree 是任务工作目录；容器是隔离边界 |
| INV-010 | queue 默认，guide 紧急，stop 硬停 |
| INV-011 | daemon 独占 SQLite；成员不得直写 |
| INV-012 | 无 `--model`；用 Protocol `session/setModel` |
| INV-013 | 原生 tab 由宿主团队做；daemon 只暴露 API |
| INV-014 | 不宣称生产/绝对安全 |
| INV-015 | 依赖只认 completed |
| INV-016 | failed gate 用因果边，不写 dependency |
| INV-017 | verdict 绑定 artifact digest |
| INV-018 | pass 无 open high/blocker |
| INV-019 | 实现类完成必须有 acceptance/commands/changedPaths |
| INV-020 | repair scope 从 findings 推导 |
| INV-021 | 交付审计独立于任务完成 |
| INV-022 | 一人一个开放任务 |
| INV-023 | 移除成员必须 drain |
| INV-024 | 队长接管同时一个 |
| INV-025 | 邮件有 delivery claim/discard |
| INV-026 | 计划批准前零 live session、零已派发任务（允许 draft 占位行） |
| INV-027 | 不能自批计划 |
| INV-028 | discard 不自动重建 |
| INV-029 | halt 与 escalated 不同 |
| INV-030 | toolPolicy 只能选 id |
| INV-031 | captain 工具永不开 |
| INV-032 | 协调工具永保留 |
| INV-033 | profile 快照冻结 |
| INV-034 | 路由快照；fallback 不改主路由 |
| INV-035 | memberMaxDepth=0 默认 |
| INV-036 | 8–32 编制不等于 32 并发 |
| INV-037 | 跨队任务依赖 v1 禁止 |
| INV-038 | 容器非 root/只读根/限网 |
| INV-039 | 合并按依赖顺序；冲突不强制 |
| INV-041 | 版本不兼容 fail closed |
| INV-042 | 归档只读，不可唤醒 |
| INV-043 | 任何状态变化写 event |
| INV-044 | 所有时间用 epoch ms；所有路径 POSIX |
| INV-045 | 所有 ID 全局唯一且不可重用 |
| INV-046 | **目标要求（未实现，非现行不变量）：**API 写操作幂等键可选；当前无通用 `Idempotency-Key` 支持 |
| INV-047 | 所有错误码稳定，文案可改 |
| INV-048 | 不允许静默降级；降级必须 warning |
| INV-049 | 不允许静默丢消息/任务/证据 |
| INV-050 | 文档、schema、测试、状态表同步更新 |
| INV-051 | 全局最多 1 个 shadow；权限=captain；独立身份留痕；不能改/删自己或自审 |
| INV-052 | shadow 按需启动、完成即停；停止后保留同一 seat，重启不新增实例 |

---

## 4. 调度

### 4.1 全局槽与公平

- 6 个 worker 槽全局共享；captain、shadow 和 2 个 lead 默认不占槽（只有亲自接管/执行任务时占）。
- `dynamicTeams=true`：有 ready 的队伍先拿 1 个，剩余按任务难度权重分配；`false` 时保留 3/3 保底与借位。
- 高优任务可抢占低优运行任务：先 `session/stop`，attempt 失效，任务回 pending，5 分钟抢占冷却。
- 饥饿保护：任一 ready 任务等待超过 30 分钟，调度器必须优先分配或升级。
- 槽位分配写 event；每队 lead 可请求容量，但全局分配权在 daemon。

### 4.2 就绪与派工

就绪条件：

- status=pending
- 所有 dependencies completed
- 不是 reassigning
- assignee 为空或成员 available
- 成员没有其他开放 attempt

选择顺序：

1. 指定 assignee 且可用
2. 共享池中角色匹配、负载最低
3. lead 指定优先级
4. 最久等待（starvation guard）

派工：

- 创建/恢复成员 session（`session/create` 或 `--resume`）
- 发送 assignment prompt：团队目标、任务合同、依赖输出（截断 2k/12k）、attempt_id、worktree、工具限制
- 等待回合结束/事件；成功更新任务；失败回滚本 attempt
- 派工失败只回滚本次 attempt，不覆盖并发接管

### 4.3 懒启动、热池、驱逐

- 成员行在创建团队时就存在；session/container 只在第一个任务时创建。
- 热池最多 6 个容器；空闲 30 分钟停止容器，保留 session home volume。
- 下一任务 `--resume` 或重新创建容器，成员身份不变。
- 32 个成员最多 32 个 home volume；只有 6 个活跃容器。
- 容器镜像预拉取；启动超时 60s；失败重试 2 次。

### 4.4 attempt / lease / parked / 冷恢复

- 派工：`attempt++`，生成 `attempt_id`，status=claimed，assignee，清除旧结果。
- Members must claim before entering `in_progress`. Claim, heartbeat and update require the explicit current `attempt_id`, including after automatic or manual `继续`. The daemon must not infer an ID from the assignee: a delayed reply from an older attempt must never acquire the newer attempt's authority. HTTP rejects missing or stale IDs with `409 E_STALE_ATTEMPT`; MCP claim/update require `attempt_id`. Continue messages carry `Attempt id: <new attempt>`. This matches the existing strict-attempt contract in `docs/contracts.md` and the 2026-11-03 handoff; older clients must be updated.
- 转派：清 `attempt_id`，生成 `handoff_id`，status=pending，reassigning=true；stop 旧 session；等待静止；新 attempt。
- 如果旧 session 不静止：超时 kill；记录 event；继续新 attempt。
- 空闲但持有开放 attempt：parked；只有显式 reassign 才轮换；lease 到期 → stalled → 升级。
- 冷启动：本进程未观察过的开放 attempt 允许恢复一次；恢复投递失败 → 恢复原 generation 并 park；不得无限重派。
- 终态结果不可变；补充证据只追加。

### 4.5 失败、fallback、移除、接管

- 失败分类见 2.3.4。
- fallback：只对可重试 provider 错误；切换 active 路由；成功继续；失败 fail attempt；不静默切 provider。
- 移除成员：撤销 attempt → 任务回 pending → 中断 session → 等待静止/超时 kill → 标记 removed → 归档 mailbox。
- 队长接管：只能一个未完成任务；撤销成员 attempt；必须本轮完成；队长空闲时未完成接管自动回池。
- 成员不能同时两个未完成任务；队长也不能同时两个接管。

### 4.6 评审池与 required reviewers

- review 也占 worker 槽。
- 有 pending review 时，优先于新 implementation 派工。
- required reviewer 必须独立；不能是 implementer。
- 如果 required reviewer 是 lead/captain，只有亲自执行 review 时占槽。
- 交付检查每个 required reviewer 的当前 artifact passing verdict。

### 4.7 抢占与饥饿

- 抢占只在显式高优或 starvation 时发生。
- 抢占前 `session/stop`，记录 interrupted，attempt 失效，任务回 pending。
- 被抢占任务保留 worktree；重新派工时检查未提交改动。
- 每队最多连续占用 4 个槽 30 分钟；超过后另一队优先。

### 4.8 跨队规则

- v1 禁止跨队任务依赖；跨队只能消息。
- 跨队消息由 daemon 路由；不改变任务图。
- 队长可以调整两队优先级；lead 只能本队。
- 一队 halt 不影响另一队；队长可 all-halt。

---

## 5. 质量门禁与证据

### 5.1 合同

| kind | 必填 |
| --- | --- |
| work | subject；无门禁 |
| requirements | objective, acceptance；完成需 verdict |
| implementation | objective, acceptance, inScope, verify |
| repair | objective, acceptance, inScope, verify, sourceTaskId |
| verification | objective, acceptance, verify |
| review | objective, acceptance, reviewedTaskId |
| integration | objective, acceptance, verify |

- objective/acceptance 非空；inScope/verify 对 implementation/repair 必填。
- 合同可以显式写 `outOfScope`、`deliverables`、`nonGoals`、`coverageOf`。
- 自动生成的合同必须带 `contractSnapshot`；引用文件变化时派工 warning。

### 5.2 完成判定

- `work`：自由文本完成。
- requirements/review：
  - completed 需要 `verdict=pass` 且无 open high/blocker finding。
  - failed 且 verdict=needs_revision/reject 需要至少一条 finding。
  - reject 直接 escalated，不自动 repair。
- implementation/repair/verification/integration：
  - 任一 commandsRun failed → completed 拒绝，必须 failed。
  - completed 需要 acceptanceResults 覆盖每条 acceptance。
  - completed 需要 commandsRun 覆盖每条 verify。
  - implementation/repair 需要 changedPaths；每条必须 in_scope。
- daemon 自己执行的 verify 是权威；成员自报 pass 但 daemon fail → 任务 failed。

### 5.3 findings / verdict

```text
verdict: pass | needs_revision | reject
severity: low | medium | high | blocker
finding: { id, severity, file?, line?, problem, requiredFix, resolved? }
```

- open high/blocker 阻止 pass。
- finding id 在任务内唯一；line 非负整数。
- resolved 只能由后续评审/修复标记，不能 implementer 自己标记。

### 5.4 repair / review 轮次

- review/requirements needs_revision → repair + 下一轮 review/requirements；超 maxRounds → escalated。
- verification failed → repair + verification-N+1；超 maxRounds → escalated。
- review failed → repair + review-N+1；repair scope 从 findings 推导。
- implementation/repair failed → **不自动**生成 follow-up 实现/修复任务；Captain 决定。同一任务由红框自动审查继续（见 5.4.1），审查本身不新建实现任务、不改 subject。
- repair 依赖 source implementation（completed），不依赖 failed gate；用 `findingSourceTaskIds` 记录 failed gate。
- recheck 依赖 repair；checker 尽量不同于 implementer。
- 同一 findings 已有开放 follow-up 时不重复创建；`maxRepairAttempts` 上限。
- 全部 findings 都只引用默认排除路径 → escalated。
- 失败的 pending downstream（如 integration）自动改依赖到新 review 轮；已完成/运行中的不改。

### 5.4.1 红框自动审查（失败任务自动继续）

- 触发：任何非审查类任务进入 `failed`（turn 重试预算耗尽、成员自报失败、daemon verify 失败）。
- 每个失败事件（taskId + lastAttemptId）只创建一个 `kind=red-auto-review` 的审查任务，id 由该 key 的 SHA-1 决定，重复触发/重启都命中同一行（幂等）。
- 审查只做一件事：对该任务发送 `继续`（复用原 session / 原 taskId / 原 subject）；不读代码、不做代码审查、不新建实现任务。
- 审查任务没有 assignee/attempt/lease，由 daemon 异步执行，不占 `activeWorkerSlots`；可由 `purpose=red_auto_review` 的 contractor 在自己的槽位执行（不建模型会话）。
- 上限：同一 taskId+sessionId 连续自动继续 `zcode.redAutoReview.maxContinues`（默认 3）次；仍失败则给 Captain 发一条消息（taskId、subject、次数、sessionId、最近错误）并停止自动继续，等待人工处理。
- 权限：Captain、reviewer/auditor 许可证（`task:continue`）、红框审查 contractor、daemon 系统身份可以继续；普通成员 `403`。
- 展示：审查行 `hidden`，从任务树/任务列表/面板/审计中过滤，且只会以 `completed` 结束；`GET /teams/:id` 用 `redReviews` 汇总，管理员可 `?includeHidden=1` 查看原始行。

### 5.5 artifact digest / scope / drift

- 见 2.3.3。
- 评审开始时对 `reviewedScopePatterns` 取 `verdictStartSnapshot`；关闭时取 `reviewedArtifacts`。
- 如果关闭时 digest 与开始时不同，记录 `reviewedDuringDrift`；交付阻断。
- 文件在评审后变化/删除/不可读/新增在 scope 下，verdict 失效。
- 自动合同引用的 artifact 变化 → work-order warning；成员必须重新读文件，不得按旧行号盲改。
- 大目录快照 caps：2000 文件 / 256MB / 10s；超限记 scopeGap，交付阻断。

### 5.6 交付审计

```text
canDeclareDelivery(team):
  blockers = []
  if phase=staged -> blocker
  if control in [halted, escalated] -> blocker
  if tasks empty -> blocker
  if all cancelled -> blocker
  for non-quality: must completed/cancelled
  for quality:
    completed -> valid verdict/evidence
    failed -> must have follow-up repair
    cancelled -> allowed but warning
  completed implementation/repair -> must have passing review bound to current artifacts
  requiredReviewers -> each has current passing review
  changedPaths -> all in_scope
  artifact drift/gap/unreadable -> blocker
  member-reported changedPaths != daemon git diff -> blocker
  work-order warnings -> warning
  return { ok, blockers, warnings }
```

### 5.7 合同修订（amendment）

- 仅 Captain；仅非终态；仅 objective/acceptance/verify/inScope/outOfScope。
- 每次修订写 revisions：at, by, reason, fields, previous。
- 修订后通知当前 owner；attempt 不变。
- 任务已有 passing review 后冻结；再改必须新建任务。
- 修订不能清空必填字段；不能把已越界路径纳入 scope 来“事后合法化”。

### 5.8 verify 执行

- Daemon 在任务容器内执行 `verify` 命令；`isolation.mode=worktree/none` 时在专用 verify sandbox 执行；两者都不可用时，交付标记为未验证并阻断。捕获 exitCode/stdout/stderr。
- 成员 `commandsRun` 与 daemon 结果比对；不一致以 daemon 为准，任务 failed。
- 外部服务/无法自动执行的命令：配置 `verifyMode=reported`，交付 warnings 标注“未机器验证”；默认 `verifyMode=daemon`。
- verify 超时/资源限制可配；超时视为 failed。

### 5.9 决策表（摘要）

| 场景 | 结果 |
| --- | --- |
| review pass + open high finding | 拒绝 completed |
| review reject | failed + escalated，不自动 repair |
| verify 失败但报 completed | 强制 failed |
| changedPaths 越界 | 拒绝 completed |
| reviewer == implementer | 拒绝 verdict |
| completed implementation 无 passing review | 交付阻断 |
| failed gate 无 follow-up | 交付阻断 |
| 全部 finding 被默认排除 | escalated |
| artifact drift | 交付阻断 |
| artifact gap/unreadable | 交付阻断 |
| required reviewer 缺失 | 交付阻断 |
| work-order stale | 交付 warning |
| 全部任务 cancelled | 交付阻断 |
| 无任务 | 交付阻断 |
| staged/halted/escalated | 交付阻断 |

---

## 6. 消息

### 6.1 字段与状态

- 字段见 3.1。
- 状态：queued → claimed → delivered → read；discarded 是终态。
- 消息必须记录 `teamId`，收件人必须是本队成员/captain/lead，或显式跨队目标。
- 禁止冒名：`from` 必须是真实参与者；captain 代理发送必须标记 `onBehalfOf`。

### 6.2 投递与唤醒

- 收件人 idle：daemon 用 `session/send` 发送；普通消息 queue，紧急消息 guide。
- 收件人 working：普通消息 queue 到回合结束；紧急消息 guide 到下一个模型步；`guide` 失败 fallback queue。
- 收件人 stopping/removed/lost：不唤醒；消息保留，等恢复或归档。
- 投递前 claim；投递成功 mark delivered；收件人读取 mark read；投递失败 release。
- 连续 3 次投递失败（5s/15s/45s）→ 升级 Captain；不丢消息。

### 6.3 作用域与过期

- 带 `taskId`/`attemptId` 的消息，只在收件人当前任务/attempt 匹配时投递。
- 任务已终态、attempt 已失效、收件人已移除 → discard，写 audit，不唤醒。
- 带 `sourceTaskId`/`sourceAttemptId` 的消息是“来源标识”，不限制投递。
- 同一发送者对同一收件人的重复内容，5 秒内去重。

### 6.4 跨队 / 广播

- v1 允许跨队点对点消息，不允许跨队任务依赖。
- 广播必须显式 `to: "*"` 或 `team:*`；默认不广播。
- 跨队消息在 UI 里标记来源队；不改变权限。

### 6.5 重试与审计

- 所有消息写 event（created/delivered/read/discarded）。
- 归档保留消息；不物理删除。
- 邮箱按成员分页/压缩；保留全文，归档可压缩，不自动删除。

---

## 7. 计划与人工控制

### 7.1 staged

- `team_create` 可以 `approval=required` 进入 staged：只写成员占位、任务/DAG，不建 session、不派工。
- staged 的成员只是 row；任务只是 draft；不允许 claim。
- 计划必须通过 DAG 校验：唯一成员名、唯一任务 id、依赖存在/前向引用、无环、assignee 存在或共享池、质量合同完整、maxMembers。
- profile 可以 seed（固定任务）或 captain（只给阵容/约束，由 Captain 设计 DAG）。

### 7.2 edit / approve / discard

- `plan_edit` 是原子 batch：任何一条非法，全部不保存。
- staged：可增删成员/任务、改依赖/assignee/合同；running：只能改未开始 pending 任务；active/finished 不改。
- running 中 remove member 只允许 staged；running 移除用 `member_remove`（撤销/归还/中断）。
- approve：
  - 只能由用户明确批准（新回合或原生 tab）；
  - Captain 不能自批；
  - 批准后才创建 session、spawn 成员、派发 ready。
- discard：
  - 二次确认；归档 draft；取消当前规划回合；
  - 注入控制上下文：不得自动重建团队；
  - 不创建成员/任务。
- `awaiting_feedback`：用户“返回对话修改”；Captain 必须问清改什么，再一次 `plan_edit`；不得新建团队。

### 7.3 halt / resume / stop

- halt：人/队长显式停止；取消 Captain 当前回合、停止成员、取消未完成任务、冻结调度；团队保留。
- resume：必须带非空 reason；不复活已取消任务；新任务需另建。
- stop（单成员/单任务）：stop session，attempt 失效，任务回 pending 或 cancelled（由调用者指定）。
- escalated ≠ halted：escalated 是质量循环到上限，团队仍可继续其他任务，但交付阻断，必须人工决策。

### 7.4 两队独立

- 每队独立 phase/control/plan。
- Captain 可以只 approve/halt/resume 一队。
- 一队的 escalated 不阻断另一队，但 Captain 全局视图标记。
- 归档一队不影响另一队；Captain 仍可操作剩余队。

### 7.5 计划修订与审计

- plan 有 version；每次 edit 生成新 version，保留 previous。
- approve 记录 approvedAt、approver（用户/tab）、plan version。
- 运行中修改 pending 任务也写 plan revision。
- 归档保留所有 plan versions。

---

## 8. 配置 / 档案 / 策略

### 8.1 配置

- 格式：JSON（canonical）；YAML 仅示例。
- `version: 1`；迁移脚本按 version。
- 优先级：CLI/env override > workspace config > user config > defaults。
- 敏感值（模型 key）不进 config；走 env/secret。
- 配置校验：schema + 语义（2 队、16/32、6 槽、leads 存在、路由合法、策略 id 存在）。

### 8.2 profiles

- 最多 16 个 profile；每个最多 32 个 seed 任务。
- member 字段：name, role, provider, model, reasoning_effort, tool_policy, executionPrompt。
- task 字段：id, subject, description, assignee, dependencies。
- `taskPlanning: seed` 展开固定任务；`captain` 只给阵容/约束，由 Captain 设计 DAG。
- `protocol` 最多 240 字符；超出拒绝。
- profile 创建团队时快照；后续 profile 修改不影响已有团队。
- reviewPolicy/fallback/executionPrompt 随快照冻结。

### 8.3 路由与 fallback

- 优先级：成员显式 provider+model / model → config memberModel/memberLlmProvider → Captain 当前路由。
- reasoning：同一 provider/model 继承 Captain；路由变更用目标默认；显式 reasoning_effort 优先。
- 创建时校验 live catalog；未知/歧义失败并列出可用 provider/model。
- 快照 provider/model/reasoning；已有成员不因配置变化而改。
- fallback：仅可重试 provider 错误；记录 fallbackActive；不改变主路由快照；成功后可继续使用，Captain 可重置。
- 禁止静默跨 provider；跨 provider 必须显式配置。

### 8.4 tool policies

- 部署方声明 registry：id → { allow?, deny? }。
- 成员只能选 id：add_member / plan member / profile member。
- `allow`：只保留列出的全局工具 + 4 个协调工具。
- `deny`：移除列出的工具；不能移除 4 个协调工具。
- Captain 工具永不开；depth deny（Agent/Task/CreateWorkflow 等）永不开。
- 未知 id/空策略/空列表：挂载或写入前失败。
- 生效 id + resolved filter 写 DB；冷恢复重新应用。
- 成员不能提交原始 allow/deny 列表。
- `toolPolicies` 是模型可见性/调用限制，不是 OS 沙箱。

### 8.5 深度与编制

- `memberMaxDepth=0` 默认；成员不能 spawn 后代。
- 若为 1，允许一层；lineage 记录 depth；超过拒绝。
- 每队 maxMembers=32；默认 16；活跃槽 6 全局。
- 成员名唯一、sanitize；重名/非法名拒绝。
- 移除成员不删除历史 session；retired member guard 阻止唤醒。

---

## 9. 隔离 / 容器 / 合并

### 9.1 威胁模型与层级

| 层级 | 机制 | 防什么 | 不防什么 |
| --- | --- | --- | --- |
| L0 | worktree only | 默认目录混用 | 绝对路径、cd、恶意命令 |
| L1 | worktree + 工具限制 + 路径校验 | 模型误操作 | shell 逃逸 |
| L2 | 每活跃成员一个容器 | 互相影响、宿主文件 | 内核逃逸 |
| L3 | 微 VM（Kata/gVisor/Firecracker） | 恶意代码逃逸 | 硬件/管理面攻击 |

默认 L2；要“绝对”用 L3。L2 的“绝对”只针对模型错误和成员互相踩，不针对恶意内核利用。

### 9.2 容器规格

- 镜像：Node 24 + ZCode CLI + git + bash + 必要工具；版本固定。
- 非 root uid；只读根；tmpfs `/tmp`；无宿主 home；无 Docker socket。
- 挂载：`/workspace` = 任务 worktree；`/home/zcode` = 成员 home volume；其他不挂。
- 网络：仅 token 网关；其他 egress 默认拒绝；DNS 只允许网关域名。
- 资源：CPU 2、内存 2GB、pids 512（默认，可配）。
- 安全：`--cap-drop ALL`、`no-new-privileges`、seccomp 默认、只读 root。
- 标签：team/task/member/attempt；便于清理审计。
- 容器崩溃：保留 worktree；清理容器；新 attempt；检查 `git status`。

### 9.3 worktree 生命周期

- 创建：`git worktree add <path> -b agent/<team>/<task>/<attempt> <base>`。
- base：团队 base commit；每任务从 base 或依赖任务的合并结果切出。
- 激活：session cwd = worktree；容器挂载 `/workspace`。
- 合并：按依赖顺序；cherry-pick；合并前在 integration worktree 跑 verify。
- 冲突：不强制；生成 integration/repair 任务；保留双方 worktree。
- 清理：合并/放弃后 24h；先检查 clean/commit；不删除未提交内容。
- 32 编制只保留 6 个活跃 worktree；其余归档 diff。

### 9.4 合并 / 冲突 / 回滚

- 合并队列每队串行；全局可并行两队。
- 提交信息包含 team/task/attempt/verdict digest。
- 合并前校验：changedPaths inScope；verify 通过；无 artifact drift；review pass 绑定当前 digest。
- 合并失败：任务 `mergeState=failed`；生成 integration/repair；不回滚已完成任务。
- 回滚：只回滚未合并的 worktree；已合并需新 revert 任务，不 force push。
- 最终交付可选 PR；PR 由 integrator/daemon 创建，队长审阅。

### 9.5 secrets / network

- 模型 key：env 注入；不写文件。
- 仓库 secrets：不挂宿主 home；不把 `.env` 放入 worktree；默认排除路径禁止修改。
- Git push：默认禁止；合并由 daemon/integrator 在宿主执行。
- 网络：`gateway-only` 使用 Podman bridge/NAT 访问宿主网关和模型出口；它**不是** egress 防火墙，未做域名/端口白名单。若需要严格只放行网关，必须额外配置网络策略。
- 日志：不记录 key；错误信息脱敏。

### 9.5.1 容器 worker 配置（0.1.3）

- `isolation.homeSeed`：宿主 ZCode profile 目录（通常 `~/.zcode/v2`）；只复制 `credentials.json`、`provider_config.json`、`setting.json` 到成员 home，不复制 session DB/日志。
- `isolation.workerModel`：`{providerId, modelId, reasoningLevel}`；写入 `provider_config.json` 的 `config.defaultModelSelection`，否则 headless CLI 会报 `Select a model before sending a message`。
- `isolation.workerMode`：容器非 plan 回合默认 `yolo`，因为 headless CLI 没有 permission client；read-only 角色仍用 `plan`。`yolo` 会明确告警，容器是隔离边界而不是权限边界。
- read-only 容器成员：worker home 写入 `~/.zcode/cli/config.json`，只加载一个 `agent-teams-member` stdio MCP server，使用成员 token 和容器可达 daemon URL。analyst/reviewer 在 `plan` 模式、Bash 禁用时通过 MCP claim/update 任务，不依赖 team-cli。
- `isolation.bindHost`：容器模式默认 `0.0.0.0`，仅 API bearer token 保护；非环回绑定时 `/ui` 强制 loopback-only。
- `isolation.hostAddress`：覆盖自动探测的 WSL vEthernet 地址；`containerUrl` 未显式设置时由它和实际端口推导。
- 凭据风险：每个成员 home 有宿主 ZCode 凭据副本；成员移除/团队归档时清理 home。只在可信宿主启用硬隔离。


### 9.6 微 VM

- `isolation.mode=microvm`：Kata/gVisor/Firecracker；每活跃成员一个微 VM。
- 6 个活跃 = 6 个微 VM；资源/启动成本高；成本已放宽时可用。
- 微 VM 内同样只挂 worktree/home volume；网络只放行网关。
- 微 VM 失败按容器失败处理；worktree 保留。

---

## 10. 打断

### 10.1 queue / guide / stop

- queue：默认；下一轮送达。
- guide：紧急；当前回合下一个模型步注入；`fellBack` 时退回 queue。
- stop：硬停；停当前回合；attempt 失效或保持 parked（由调度器决定）；随后 send 新指令。
- cancelBackgroundTask：取消长构建/测试等后台任务；不杀会话。
- 原生 tab 提供“打断并说话”：普通 guide，急停 stop+send。

### 10.2 对 attempt 的影响

- guide 不改变 attempt；成员继续同一 attempt。
- stop 后：如果任务仍归原成员，attempt 保持 parked；如果 reassign，attempt 失效。
- 被 stop 的回合不产生 completed/failed；记录 `interrupted` event。
- 正在跑的工具调用不能改，只能取消/杀；文件改动保留。

---

## 11. 可观测 / 归档 / 谱系

### 11.1 events

事件类型至少：

```text
team.created team.plan.staged team.plan.approved team.plan.discarded
team.halted team.resumed team.escalated
member.added member.removed member.status member.spawn_failed
task.created task.claimed task.updated task.reassigned task.parked
task.stalled task.interrupted task.merged task.merge_failed
gate.verdict gate.repair gate.escalated
message.created message.delivered message.read message.discarded
usage.recorded scheduler.tick scheduler.preempted
```

- 所有事件带 teamId/taskId/memberId/attemptId（适用时）。
- 事件只追加；归档保留。daemon 启动时对非归档团队执行保留上限：默认保留最新 50,000 条事件，超出部分删除；归档团队的事件不受该上限影响，审计导出须在非归档事件达到上限前完成。
- 事件用于审计、回放、native tab SSE。

### 11.2 snapshot / visual states

- `blocked`：依赖未完成。
- `open`：pending + 依赖满足 + 可领。
- `claimed`：已领取未开始。
- `running`：in_progress。
- `completed/failed/cancelled`：终态。
- `taskDepthsById`：DAG 深度；环拒绝。
- 成员行显示状态/模型/路由/策略/未读；任务行显示 kind/round/verdict/deps/owner。
- 快照字段与 DB 一致；原生 tab 不自己推断业务状态。

### 11.3 archive

- 归档：team、members、tasks、deps、gates、messages、events、usage、plan versions、worktree refs。
- 成员 session 保留只读；retired guard 阻止唤醒。
- 归档只读；恢复创建新 team/新 ID，不复用旧 ID。
- 归档可导出 JSON；30 天后可压缩但不删除。

### 11.4 lineage / retired

- lineage：captain → lead → member → (可选) 一层后代；depth 最大 32。
- 记录 session id、parent session、team、role、createdAt。
- retired member ids：禁止唤醒/派工；历史可查。
- fork/compact 产生新 session 但 member identity 不变；lineage 记旧/新。
- lead 身份按 session ancestry 判定；不能靠名字。

### 11.5 SSE / UI

- SSE 事件见 2.3.6；断线重连用 `Last-Event-ID` 或 since 参数。
- 32/64 成员分页/虚拟列表；任务 DAG 前端布局，但依赖来自 API。
- 成员会话 viewer：只读 transcript；写操作走消息/API。
- 原生 tab 断开不影响 daemon；恢复后增量拉取。

---

## 12. ZCode 集成 / 能力

### 12.1 已验证事实（2026-10-26）

- CLI `0.17.0`：`-p/--prompt`、`--resume <sess_>`、`--cwd`、`--disallowed-tools`、`--mode`、`--json`。
- `--json` 返回 sessionId、turnId、response、usage、projection。
- `--resume` 保留上下文（实测返回 OK）。
- `--cwd` 切换工作目录后能读取新目录文件（实测 PROBE123）。
- `--disallowed-tools` 是 per-run；`--mode plan/build/guarded/yolo/edit`。
- 没有 `--model`；每成员模型用 Protocol `session/setModel` / `session/setThoughtLevel`。
- Protocol 方法：`session/create`、`session/resume`、`session/send`、`session/stop`、`session/cancelBackgroundTask`、`session/setModel`、`session/setThoughtLevel`、`session/setMode`、`session/fork`、`session/compact`、`session/goal`、`session/close`、`session/events`、`session/subscribe`、`session/messages`、`session/subagents`。
- `session/send` 的 delivery：`startNow|queue|guide`；`guide` 可在下一步注入；可能 `fellBack`。
- Docker/WSL/Hyper-V/Windows Sandbox 在初始基线未启用；截至 2026-10-30，本机 WSL2 + Podman 已启用并完成真实容器任务（见 docs/verification.md §24/§26）。

### 12.2 session 生命周期

1. 创建 Captain session（headless 或原生 tab 聊天代理）。
2. 创建 Lead session（每队一个）。
3. 成员按需创建：`session/create` 或 CLI `-p`；记录 sessionId。
4. 派工：`session/send`（queue/guide）；等待回合结束/事件。
5. 更新：成员通过 team CLI/HTTP 写 task/mailbox；daemon 校验 attempt。
6. 压缩：`session/compact`；溢出则新 session + 摘要。
7. 停止：`session/stop`；删除成员/归档：stop + retire。
8. 恢复：`session/resume` 或 CLI `--resume`。

### 12.3 能力探测与降级

- 启动 probe；记录 capabilities。
- 缺 guide → queue；缺 stop → kill；缺 setModel → 默认模型 + warning；缺 events → 轮询；缺 create/resume → fail closed。
- 版本不匹配：先 probe；不支持的方法 fail closed，不静默。
- 每次升级 ZCode 后跑 verification suite。

### 12.4 认证 / 路径 / Windows

- CLI/Protocol 使用本机登录/配置；daemon 需要能定位 `zcode.cjs`/`zcode`。
- 容器内只使用 API key；不挂宿主 home，不复制宿主 OAuth。若 CLI 强制 OAuth，v1 fail closed，改用 API key 方案。
- 路径统一 POSIX；Windows 下转换盘符；worktree 路径不含空格/中文（容器兼容）。
- Windows 无 Docker/WSL 时：远程 Linux 服务器优先；否则 Windows 独立用户+ACL 降级。

### 12.5 版本兼容

- 固定测试版本；兼容矩阵记录 CLI/Protocol 方法。
- 破坏性变更升 minor；不兼容 fail closed。
- `session/send guide`、`session/stop`、`setModel` 是硬依赖，缺失必须降级并 warning。

---

## 13. API / DB 契约

### 13.1 HTTP API（v1）

```text
GET    /api/v1/health
GET    /api/v1/teams
POST   /api/v1/teams
GET    /api/v1/teams/:id
PATCH  /api/v1/teams/:id
POST   /api/v1/teams/:id/archive

GET    /api/v1/teams/:id/members
POST   /api/v1/teams/:id/members
PATCH  /api/v1/teams/:id/members/:memberId
DELETE /api/v1/teams/:id/members/:memberId

GET    /api/v1/teams/:id/tasks
POST   /api/v1/teams/:id/tasks
PATCH  /api/v1/teams/:id/tasks/:taskId
POST   /api/v1/teams/:id/tasks/:taskId/reassign
POST   /api/v1/teams/:id/tasks/:taskId/cancel

GET    /api/v1/teams/:id/messages
POST   /api/v1/teams/:id/messages
POST   /api/v1/teams/:id/messages/:messageId/read

GET    /api/v1/teams/:id/usage
GET    /api/v1/teams/:id/events?since=
GET    /api/v1/teams/:id/stream          # SSE

POST   /api/v1/teams/:id/plan/edit
POST   /api/v1/teams/:id/plan/approve
POST   /api/v1/teams/:id/plan/discard
POST   /api/v1/teams/:id/halt
POST   /api/v1/teams/:id/resume
POST   /api/v1/teams/:id/captain/message
```

- **目标要求（当前未实现）：**写操作使用 JSON body，允许 `Idempotency-Key` 并返回 `{ ok, data, error? }`。当前 HTTP/MCP 实现没有通用 `Idempotency-Key` 处理，也没有相应测试；调用方不得依赖服务端按该键去重。实际接口以 `docs/contracts.md` 和 `src/http/server.mjs` 为准。
- 列表分页：`?limit=50&cursor=...`；32/64 成员必须分页。
- 错误码：`E_AUTH`、`E_NOT_FOUND`、`E_CONFLICT`、`E_INVALID`、`E_CAPABILITY`、`E_STATE`、`E_STALE_ATTEMPT`、`E_UPSTREAM`。
- 时间 epoch ms；路径 POSIX；ID 字符串。

### 13.2 SSE

```text
event: team.updated
data: {"teamId":"...","phase":"running","control":"active","version":12}

event: task.updated
data: {"teamId":"...","taskId":"...","status":"in_progress","attempt":3,"attemptId":"..."}
```

- 支持 `Last-Event-ID` / `since`。
- 断开不影响 daemon；重连增量。
- 每事件带 `eventId`、`teamId`、`ts`。

### 13.3 discovery / auth

每个工作区写 `~/.ai-agent-teams/workspaces/<workspace-hash>/runtime.json`；`~/.ai-agent-teams/runtime.json` 作为最近 daemon 的兼容镜像。以下 `version` 为格式占位符，不是当前版本声明：

```json
{
  "port": 43127,
  "token": "random-32-bytes",
  "pid": 1234,
  "version": "<package-version>",
  "workspace": "D:\\work\\project",
  "instanceId": "16-hex-chars",
  "apiVersion": "v1",
  "startedAt": 1760000000000
}
```

`/api/v1/health` 返回 `status`、`version`；仅 loopback 请求额外返回 `workspace`、`pid`、`instanceId`。bootstrap 只有在健康身份匹配且 discovery token 通过认证请求后才会终止旧 PID。

- 文件权限 0600；loopback only；Bearer token；无 CORS。
- token 轮换需要重启 daemon；原 token 立即失效。

### 13.4 SQL 表（核心）

```sql
teams(id TEXT PRIMARY KEY, name TEXT, phase TEXT, control TEXT,
      plan_state TEXT, captain_session_id TEXT, profile_json TEXT,
      base_commit TEXT, created_at INTEGER, archived_at INTEGER);

leads(id TEXT PRIMARY KEY, team_id TEXT, session_id TEXT, status TEXT,
      model TEXT, context_usage REAL, last_seen INTEGER);

members(id TEXT PRIMARY KEY, team_id TEXT, name TEXT, role TEXT,
        session_id TEXT, provider TEXT, model TEXT, reasoning TEXT,
        fallback_json TEXT, active_provider TEXT, active_model TEXT,
        fallback_active INTEGER, tool_policy TEXT, tool_filter_json TEXT,
        status TEXT, spawn_error TEXT, worktree_id TEXT, container_id TEXT,
        joined_at INTEGER, last_seen INTEGER);

tasks(id TEXT PRIMARY KEY, team_id TEXT, subject TEXT, description TEXT,
      status TEXT, assignee TEXT, dependencies_json TEXT, attempt INTEGER,
      attempt_id TEXT, handoff_id TEXT, reassigning INTEGER, kind TEXT,
      round INTEGER, objective TEXT, in_scope_json TEXT, out_of_scope_json TEXT,
      acceptance_json TEXT, verify_json TEXT, deliverables_json TEXT,
      non_goals_json TEXT, verdict TEXT, findings_json TEXT,
      changed_paths_json TEXT, acceptance_results_json TEXT,
      commands_run_json TEXT, reviewed_task_id TEXT, source_task_id TEXT,
      source_finding_ids_json TEXT, finding_source_task_ids_json TEXT,
      coverage_json TEXT, contract_snapshot_json TEXT,
      verdict_start_snapshot_json TEXT, reviewed_artifacts_json TEXT,
      reviewed_gaps_json TEXT, reviewed_scope_json TEXT,
      reviewed_during_drift_json TEXT, revisions_json TEXT,
      merge_state TEXT, created_at INTEGER, updated_at INTEGER);

attempts(id TEXT PRIMARY KEY, task_id TEXT, attempt INTEGER, assignee TEXT,
         lease_expires_at INTEGER, last_heartbeat INTEGER, status TEXT,
         failure_class TEXT, started_at INTEGER, ended_at INTEGER);

gates(id TEXT PRIMARY KEY, task_id TEXT, round INTEGER, kind TEXT,
      verdict TEXT, findings_json TEXT, reviewer_id TEXT,
      artifacts_digest_json TEXT, created_at INTEGER);

messages(id TEXT PRIMARY KEY, team_id TEXT, from_agent TEXT, to_agent TEXT,
         content TEXT, ts INTEGER, task_id TEXT, attempt_id TEXT,
         source_task_id TEXT, source_attempt_id TEXT, source_task_status TEXT,
         delivery_claimed_at INTEGER, delivered_at INTEGER, read_at INTEGER,
         discarded_at INTEGER);

plans(id TEXT PRIMARY KEY, team_id TEXT, version INTEGER, status TEXT,
      members_json TEXT, tasks_json TEXT, approved_at INTEGER,
      approved_by TEXT, previous_json TEXT);

sessions(id TEXT PRIMARY KEY, team_id TEXT, owner_id TEXT, owner_type TEXT,
         protocol_version TEXT, status TEXT, context_usage REAL,
         last_event_at INTEGER);

containers(id TEXT PRIMARY KEY, member_id TEXT, task_id TEXT, image TEXT,
           worktree_id TEXT, status TEXT, limits_json TEXT, started_at INTEGER);

worktrees(id TEXT PRIMARY KEY, task_id TEXT, path TEXT, branch TEXT,
          base TEXT, status TEXT, commit_hash TEXT);

usage(id TEXT PRIMARY KEY, team_id TEXT, member_id TEXT, task_id TEXT,
      turn_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read INTEGER, cache_write INTEGER, reasoning_tokens INTEGER,
      created_at INTEGER);

events(id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT, type TEXT,
       payload_json TEXT, created_at INTEGER);

capabilities(id INTEGER PRIMARY KEY, zcode_version TEXT,
             protocol_version TEXT, methods_json TEXT, checked_at INTEGER);
```

- WAL；`busy_timeout=5000`；每队一个逻辑锁；跨队并行。
- 迁移表 `schema_migrations`；不在代码里 `ALTER` 猜测。

### 13.5 错误 / 版本

- 错误码稳定；文案可本地化。
- API 破坏性变更升 `/api/v2`；保留一个 minor 兼容。
- DB schema version 独立；迁移向前兼容。

---

## 14. 验收测试

### 14.1 任务 / attempt

| ID | 场景 | 期望 |
| --- | --- | --- |
| T-01 | pending→completed 直接跳 | 拒绝 |
| T-02 | 迟到 attempt 更新 | 拒绝，原结果不变 |
| T-03 | 转派旧成员迟到结果 | 不覆盖新 attempt |
| T-04 | 空闲持开放 attempt | parked，lease 到期 stalled |
| T-05 | 冷重启未观察 attempt | 只恢复一次；失败回退并 park |
| T-06 | 派工失败 | 只回滚本次 attempt |
| T-07 | 队长接管 | 一个未完成；空闲自动回池 |
| T-08 | 一人两个开放任务 | 拒绝 |

### 14.2 依赖 / 门禁 / 交付

| ID | 场景 | 期望 |
| --- | --- | --- |
| T-09 | failed/cancelled 依赖 | 永不解锁 |
| T-10 | 失败 review 作为 dependency | 拒绝；用 causal edge |
| T-11 | review pass 带 open high | 拒绝 completed |
| T-12 | review reject | failed + escalated，无自动 repair |
| T-13 | verify 失败但报 completed | 强制 failed |
| T-14 | changedPaths 越界 | 拒绝 |
| T-15 | reviewer == implementer | 拒绝 |
| T-16 | completed implementation 无 pass review | 交付阻断 |
| T-17 | failed gate 无 follow-up | 交付阻断 |
| T-18 | 全部 finding 被默认排除 | escalated |
| T-19 | 超 max rounds/repair | escalated |
| T-20 | artifact 评审后被改 | 交付阻断 |
| T-21 | artifact gap/unreadable | 交付阻断 |
| T-22 | required reviewer 缺失 | 交付阻断 |
| T-23 | work-order stale | warning，不阻断 |
| T-24 | 全部 cancelled / 无任务 | 交付阻断 |
| T-25 | amendment 后 review pass | 冻结，再改拒绝 |

### 14.3 成员 / 调度

| ID | 场景 | 期望 |
| --- | --- | --- |
| T-26 | 移除成员有开放任务 | 撤销/归还/中断/drain |
| T-27 | 成员失败有 fallback | 切换 active，不失败任务 |
| T-28 | fallback 失败 | fail attempt，任务 failed |
| T-29 | 2 队 6 槽 | 动态分配；一队空闲可借（legacy 3/3 仍有测试） |
| T-30 | 32 编制 | 只开 6 个 session/容器 |
| T-31 | 抢占 | stop + attempt 失效 + 回 pending |
| T-32 | 饥饿 30 分钟 | 优先分配/升级 |
| T-33 | lead 丢失 | 本队停止新派工，无孤儿 |
| T-34 | captain 丢失 | 两队暂停新派工，可恢复 |
| T-35 | 容器崩溃 | worktree 保留，新 attempt |

### 14.4 计划 / 消息 / 策略

| ID | 场景 | 期望 |
| --- | --- | --- |
| T-36 | staged 批准前 | 零 live session、零已派发任务 |
| T-37 | plan edit 原子 | 任一非法全不保存 |
| T-38 | running 改 active 任务 | 拒绝 |
| T-39 | discard | 归档 draft，不自动重建 |
| T-40 | halt/resume | 取消未完成；resume 需 reason |
| T-41 | escalated vs halted | 状态不同，不混淆 |
| T-42 | 过期邮件 | discard，不唤醒 |
| T-43 | 跨队消息 | 可达，不建依赖 |
| T-44 | toolPolicy 非法 id | 创建/挂载失败 |
| T-45 | captain 工具通过 allow 重开 | 拒绝 |
| T-46 | profile 快照 | 后续修改不影响已有团队 |
| T-47 | 路由快照 + fallback | 主路由不变 |

### 14.5 打断 / 兼容

| ID | 场景 | 期望 |
| --- | --- | --- |
| T-48 | queue | 下一轮送达 |
| T-49 | guide | 下一步注入；fallback queue |
| T-50 | stop + send | 回合停止，新指令生效 |
| T-52 | 缺 guide/stop/setModel | 降级 + warning；缺 create fail closed |
| T-53 | API SSE 断线 | 重连增量，不丢状态 |
| T-54 | 6 活跃 e2e | 建队→审批→派工→评审→修复→合并 |
| T-55 | 16 活跃压测 | 资源/限流/公平性达标 |
| T-56 | 32 活跃（多机） | 单机不承诺；多机验证 |

---

## 15. 实施计划（2026-10-28 历史目标路线图，不代表当前进度）

| 里程碑 | 交付 | 验收 |
| --- | --- | --- |
| M0 | 本规格 + 配置 schema + 纯逻辑测试 | `npm test`/`check` 通过 |
| M1 | 领域逻辑：attempt/lease/parked/deps/gates/artifact/delivery | T-01..T-25 |
| M2 | Daemon + SQLite + HTTP/SSE + discovery | health/teams/tasks/events |
| M3 | ZCode session adapter（Protocol 主，CLI 兜底） | create/send/stop/setModel/resume |
| M4 | 调度器 + 6 槽 + 2 队 + lazy spawn + 热池 | T-29..T-35 |
| M5 | 邮箱 + plan + halt/resume + interrupt | T-36..T-50 |
| M6 | 质量门禁执行 + verify runner + 合并 | T-09..T-25 + merge |
| M7 | 容器池 + worktree + 隔离 | 6 容器隔离测试 |
| M8 | 原生 tab API + SSE + 成员 viewer | 宿主团队联调 |
| M10 | e2e 6 / 压测 16 / 多机 32 / 发布 | 全部验收 |

---

## 16. 验证 / 发布 / 分发

### 16.1 e2e

- 6 活跃成员共享池：动态分配；requirements → implementation → verification → review → repair → integration；容器隔离；guide/stop；合并；归档。
- 真实模型，不用 fixture 替代关键路径；记录 token/耗时/失败率。

### 16.2 压测

- 6 活跃：基线。
- 16 活跃：资源、限流、公平性、队列。
- 32 活跃：多机；单机不承诺。

### 16.3 隔离

- 两成员不能互看 worktree/进程/网络。
- 容器非 root、只读根、无宿主 home。
- 微 VM 可选验证。

### 16.4 兼容

- ZCode 0.17.0 基线；升级后跑 capability probe + e2e。
- 方法缺失降级测试。

### 16.5 发布（2026-10-28 历史目标清单，非当前发布状态）

- 原计划版本为 `0.1.1`，并要求 CHANGELOG、STATUS、兼容矩阵。
- 原计划 GitHub release 附 ZIP + checksum + 安装说明。
- 本节对 `0.1.7` 的正式发布表述属于旧版计划快照；当前工作版本为 `0.2.2`（未发布工作树版本），发布状态以 `docs/status/STATUS.md` 为准。

### 16.6 安装 / 升级

- 安装器：检查 Node/ZCode/Docker，写配置，启动 daemon，注册服务/开机启动。
- 升级器：备份 DB，迁移，重启，健康检查，失败回滚。
- 原生 tab 通过 discovery 连接；daemon 可独立运行。

---

## 17. 已知限制

- 正在执行的工具调用不能改，只能取消/杀。
- 容器共享内核；绝对安全要微 VM。
- 32 活跃不支持单机默认；6 活跃是默认。
- 原生 tab 依赖宿主团队。
- ZCode CLI/Protocol 会变；必须 probe/降级。
- 成员上下文会增长；必须 compact/新 session。
- 合并冲突无法自动解决；必须 integrator/repair。
- 跨队任务依赖 v1 不支持。
- 容器/微 VM 在 Windows 需要 WSL2/Docker 或远程 Linux；截至 2026-10-30 本机 WSL2 + Podman 已启用，Docker/Hyper-V/Windows Sandbox 仍未使用。
- 无真实用户/issue/benchmark；不能宣称“比单 Agent 更好”。

---

## 18. 交付清单 / 下一步

### 18.1 逻辑层状态

- 12 条硬规则：已定。
- 6 组二级逻辑：已定。
- 状态机/不变量/调度/门禁/交付/消息/计划/策略/隔离/打断：已定。
- 验收测试：55 条。
- 机制映射：已定。
- 仍有 **实现** 和 **验证** 差距，不是逻辑差距。

### 18.2 下一步

1. 按 M1 把纯逻辑和测试落代码。
2. 做 M2 Daemon + SQLite + HTTP/SSE。
3. 做 M3 Protocol adapter，跑通 create/send/stop/setModel/resume。
4. 做 M4 6 槽调度 + 2 队 + lazy spawn。
5. 做 M6 门禁 + merge，跑 6 活跃 e2e。
6. M7 容器、M8 原生 tab API。
7. M10 压测 16/32、发布。

### 18.3 交给下一个模型的三句话

- 先读 `AGENTS.md`、`docs/status/STATUS.md`、`docs/status/HANDOFF.md`。
- 不要改 1/2/16/32/6；不要绕过 attempt/lease；不要自批计划。
- 先让 6 个活跃成员的 e2e 跑通，再谈 16/32 和发布。
