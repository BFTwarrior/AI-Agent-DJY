# 详细使用与技术说明

命令均从仓库根目录执行。返回 [README](../README.md)。

<p><img src="../assets/logo.webp" width="96" height="96" alt="zcode-community-retry logo"></p>

# ZCode Community Retry

ZCode 的非官方主聊天重试插件及可选的 Retry Keeper。

安装时在 ZCode「插件市场 → 添加」使用本仓库地址：

`https://github.com/tangyixiao/zcode-community-retry`

安装 `zcode-community-retry@tangyixiao-zcode-community`（当前 0.3.5）；可选 Keeper 及其配置见 [Keeper 说明](../keeper/README.md)。保持原市场名与插件 ID；已有用户请在插件市场将来源更新为本仓库，并确认更新后的版本和启用状态。迁移前请保存现有配置。不同 ZCode 客户端的来源切换与重复源行为尚未实机验证。

[安装、配置、重试边界和使用说明](../community/README.md) · [反馈问题](https://github.com/tangyixiao/zcode-community-retry/issues)

Bridge 仓库保留其内置的 0.3.2 副本，DSH 可选集成的升级周期与本插件独立。原仓库历史版本及已安装副本不会被自动删除。

从仓库根运行 `npm test` 执行不依赖原生调试端口的测试；`npm run test:native` 需要 Windows、支持版本的 ZCode 和空闲的 9229 端口。CLI/Desktop 协议使用隔离配置和本地模拟上游；不等于真实账号验收。

AGPL-3.0。与 ZCode 官方无从属关系。
