# 灵犀引擎 Bug 记录

## BUG-001: shell_exec 裸命令在 Windows 上 ENOENT
- **发现时间**: 2026-08-05
- **严重程度**: 中
- **现象**: `echo hello`、`dir` 等命令直接报 `spawnSync ENOENT`，但 `cmd /c echo hello` 正常。
- **根因**: 沙箱 `spawnSync` 未设置 `shell: true`，Windows 内置命令不是独立二进制文件。
- **修复建议**: 检测 Windows 平台时自动加 `cmd /c` 前缀，或设置 spawn 的 `shell: true`。
- **状态**: 待修复

---

## BUG-002: 云端模型调用时模型名路由错误（DeepSeek/Ollama 混用）

- **发现时间**: 2026-08-05
- **严重程度**: 🔴 高
- **现象**: 
  用户配置了 Ollama 本地模型 `qwen3.5:9b` 和 DeepSeek 云端模型。当尝试使用 DeepSeek 云端模型时，API 报错：
  ```
  400 The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed qwen3.5:9b
  ```
  重复出现 3 次导致 AI 调用链路完全失败。

### 根因分析

**触发条件（三重叠加）：**

| 层 | 问题 | 细节 |
|----|------|------|
| 1. `.env` | `DEFAULT_MODEL=qwen3.5:9b` | 全局默认模型被设为 Ollama 本地模型名 |
| 2. `.env` | `# DEEPSEEK_API_KEY=` | 环境变量中 DeepSeek API key 被注释 |
| 3. `hub.ts` L49 | `apiKey: process.env.DEEPSEEK_API_KEY \|\| ""` | DeepSeek provider 初始化时 apiKey 为空 |

**但 DeepSeek 实际能连通**：`providers.json` 中存储了前端配置的 API key（`sk-65d5...`），`provider-registry.ts` 的 `restore()` 方法从磁盘恢复后覆盖了 hub.ts 中空的 apiKey，所以 DeepSeek Client 实际上是活的。

**真正的 bug 在模型名路由**：当 `DEFAULT_MODEL=qwen3.5:9b` 且用户在前端切换到 DeepSeek provider 时，系统在构造 API 请求时，模型名没有跟随 provider 切换——仍然使用了 `DEFAULT_MODEL` 的值 `qwen3.5:9b`，而这个 Ollama 格式的模型名不被 DeepSeek API 接受。

### 推测的代码缺陷位置
- `src/core/router.ts` / `src/ai/hub.ts` 中构造 chat completion 请求时，模型名字段可能直接读取了 `DEFAULT_MODEL` 而没有根据当前选中 provider 的模型列表来解析。

### 修复建议
1. **紧急**：在构造 API 请求时，模型名必须从当前 provider 的模型列表中选取，不能无条件使用 `DEFAULT_MODEL`。
2. **建议**：当检测到模型名不在当前 provider 的模型列表中时，自动 fallback 到该 provider 的第一个模型，并打印 warning。
3. **建议**：`DEFAULT_MODEL` 应该包含 provider 前缀（如 `deepseek/deepseek-v4-pro`），或者改为按 provider 分别存储默认模型。

- **状态**: 待修复
