# Shared

跨项目复用的脚本与提示词。

```text
scripts/    同步、校验、打包等工具（规划中）
prompts/    可复用的提示词片段
```

## 规划中的脚本

| 脚本 | 作用 | 状态 |
|---|---|---|
| `sync_skills.py` | 仓库 → `AI\AI-Agent-DJY\skills` → `~\.zcode\skills`，默认 dry-run、写前备份、不删多余目录 | 未实现 |
| `install_mcp.py` | 渲染 `mcp.json.example` → 合并 `mcp.servers`，写前备份、失败回滚 | 未实现 |

在脚本落地前，按 [03-部署与同步](../docs/03-部署与同步.md) 的手工步骤执行。
