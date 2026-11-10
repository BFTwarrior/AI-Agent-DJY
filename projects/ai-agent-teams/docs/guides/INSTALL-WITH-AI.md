# 用 AI 从 GitHub 安装

这份流程用于“用户只复制 GitHub 链接给 AI，由 AI 完成检查、安装、重启后验收和方案选择”。安装成功不等于代码存在，必须走完四个阶段。

## 用户只需要做一件事

把本仓库的 GitHub 链接粘贴给 ZCode，并说：

```text
按仓库里的 docs/guides/INSTALL-WITH-AI.md 安装 AI Agent Teams，严格按四步执行，不要跳步。
```

## 第一步：电脑与 ZIP 要求检查

AI 克隆仓库后先运行：

```bash
node src/install-wizard.mjs --inspect --workspace "<工作区绝对路径>" --github "<GitHub 链接>"
```

检查项：

- Windows 版本、Node.js >= 22.5、`node:sqlite`
- 内存、磁盘、管理员权限
- 虚拟化、WSL2、Podman/Docker、git、ZCode
- 当前是否已安装插件、daemon 是否健康
- 硬隔离是否真正可用，软隔离 worktree 是否可用

输出 `phase=awaiting-isolation-choice` 和 `questions`。AI 必须把**硬隔离和软隔离两个选项都展示给用户**，包括 `available`、`installable`、`reason`、`requirements` 和 `repairSteps`，由用户明确选择；不能因为硬隔离不可用就默认替用户选软隔离。

- 硬隔离不可用时，仍要说明需要装什么：管理员权限、BIOS/UEFI 虚拟化、WSL2（`wsl --install` 后重启）、Podman Desktop（推荐）或 Docker Desktop。当前工作源码为 `0.2.2`（尚未发布）；容器派发已接线，但仍需构建包含 ZCode 的 worker 镜像并通过自测。不要把源码能力描述成已安装或已验收的正式发布版本。
- 硬隔离还需要 worker 的登录态和模型：`isolation.homeSeed` 指向宿主 `~/.zcode/v2`（只复制 `credentials.json`、`provider_config.json`、`setting.json`），`isolation.workerModel` 指定 `{providerId, modelId, reasoningLevel}`。`isolation.workerMode` 默认 `yolo`（headless CLI 无 permission client），只读角色用 `plan`；必须向用户说明 yolo 和“worker home 含宿主凭据副本”的安全含义。容器网络 `gateway-only` 是 bridge/NAT，出站未过滤。
- 软隔离要求目标工作区本身是 git 仓库；不是 git 仓库时向导返回 `soft.available=false` 和 `repairSteps`（`git init` 或换 git 工作区），AI 应让用户选择修复软隔离或改选硬隔离。

用户选硬隔离时，AI 还必须让用户在 **Podman Desktop（推荐）** 和 **Docker Desktop** 之间选择，并把选择作为 `--runtime` 传入；不能默认替用户选。硬隔离不可用时，向导返回 `HARD_ISOLATION_UNAVAILABLE`，但必须同时返回 `requirements` 和 `repairSteps`；AI 要把这些修复步骤完整展示给用户，不能只说“不可用”，也不能声称硬隔离已生效。

## 第二步：选择隔离、安装、重启、自检

用户选择后运行：

```bash
node src/install-wizard.mjs --choose-isolation soft --workspace "<工作区绝对路径>"
# 硬隔离：先问隔离方式，再必须问运行时（Podman / Docker）：
# node src/install-wizard.mjs --choose-isolation hard --runtime podman --workspace "<工作区绝对路径>"
# 或 --runtime docker；省略 --runtime 会返回 RUNTIME_CHOICE_REQUIRED
# 硬隔离不可用时返回 HARD_ISOLATION_UNAVAILABLE + repairSteps
```

然后 AI **必须全自动完成安装，不再二次询问“是否安装”**：

1. 在 ZCode 插件市场添加仓库根目录（包含 `marketplace.json`），安装 AI Agent Teams，并确认插件已启用、版本正确、`contentOk=true`。
2. 安装完成后立即提醒用户：**请手动重启电脑/ZCode**；AI 不得自动重启，也不得替用户确认已重启。
3. 用户回复“已重启”后运行：

```bash
node src/install-wizard.mjs --verify --restart-confirmed --workspace "<工作区绝对路径>"
```

只有 `phase=awaiting-preset-choice` 才算安装和重启自检通过。任何检查失败都不得进入下一步，修复后重新 `--verify`。

硬隔离不可用时是唯一例外：不得假装安装硬隔离，也不得默认改选软隔离；先完整展示 `requirements` 和 `repairSteps`，由用户决定安装 WSL2/Podman/Docker 前置，或改选软隔离后继续自动安装。

## 第三步：选择保守或平衡方案

```bash
node src/install-wizard.mjs --presets --workspace "<工作区绝对路径>"
```

AI 必须把两个方案都展示给用户：

- 保守：并发更低、成本和 API 速率风险更小
- 平衡：并发更高、吞吐更高，需要足够内存和 API 配额

用户选择后：

```bash
node src/install-wizard.mjs --apply --preset conservative --workspace "<工作区绝对路径>" --write "<工作区绝对路径>/config/local.json"
```

只有返回 `phase=complete` 才算安装成功。AI 最后应报告配置路径、并发参数、隔离方式和仍存在的限制。

## 不跳步规则

- 未 `--inspect`：不得选择隔离。
- 未选择隔离：不得安装。
- 未重启并 `--verify`：不得提供方案。
- 未选择方案并 `--apply`：不得说“安装成功”。
- 不得把硬隔离前置环境安装说成硬隔离已生效。
- 不得自动重启电脑。
