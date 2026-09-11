# 服务器引擎环境核查 — 2026-09-12（第二轮补充）

> 时间：06:50–07:05（Asia/Shanghai）
> 背景：本地幽灵模型 `glm-5.3:cloud` 已由并行 agent 于 06:16 扶正（本地 Ollama 实测响应正常）。
> 本轮核查服务器侧引擎环境，确认服务器是否存在同类隐患。

## 一、服务器引擎目录与版本

| 项 | 实测 |
|---|---|
| 引擎目录 | `/opt/lingxi-engine`（PM2 `lingxi` 进程工作目录） |
| `/api/health` | `2.0.15`，uptime 210350s（≈58h，09-10 起） |
| Ollama 服务 | `systemctl active`，仅装 `qwen2.5:3b`（1.9GB）+ `qwen2.5:0.5b`（0.4GB） |

## 二、服务器 `.env` 模型配置

```
DEFAULT_MODEL=glm-5.3:cloud     ← 与服务器 Ollama 实际模型不匹配
TOOL_MODEL=glm-5.2:cloud        ← 同上
REPLY_MODEL=glm-5.2:cloud       ← 同上
```

## 三、关键发现：服务器侧 glm-5.3/5.2 均不可直连

| 测试 | 结果 |
|---|---|
| 服务器 Ollama `/api/chat` → `glm-5.3:cloud` | **401 Unauthorized**（Ollama 需认证，models 目录仅有 qwen2.5） |
| 服务器 Ollama `/api/chat` → `glm-5.2:cloud` | 同样 401 |
| providers.json Ollama 条目 | models 列表含 `glm-5.3:cloud`/`glm-5.3-flash:cloud`/`kimi-k3:cloud`（06:16 同步过），但实际不可用 |
| `/usr/share/ollama/.ollama/models/manifests` | 仅 `qwen2.5` |

**结论**：服务器 `.env` 的 `DEFAULT_MODEL=glm-5.3:cloud` 在服务器上是**真幽灵模型**——服务器 Ollama 既没装 glm 系列、且 Ollama 服务要求认证（401）。服务器引擎（2.0.15）目前能对话，依赖的是 `getClient()` 五级 fallback（providers.json 里 DeepSeek/OpenRouter/NVIDIA/通义均 enabled 且有 key）。**风险**：fallback 链路随机性大，且每次请求都先打一次 401 再降级，浪费延迟。

## 四、本地 Ollama glm-5.3:cloud 实测（对照）

| 测试 | 结果 |
|---|---|
| `/api/chat`（native API） | ✅ 响应正常 |
| `/v1/chat/completions`（OpenAI 兼容层） | ✅ 正常，`max_tokens=500` 时 content=`OK`、finish=stop、209 tokens |
| 小 `max_tokens` 行为 | reasoning 先行、content 为空（`finish=length`），属正常截断，非故障 |
| `/v1/models` 列表 | kimi-k2.7-code:cloud / minimax-m3:cloud / glm-5.2:cloud / qwen3.8:27b（5.3 虽不在列表但可调用） |

## 五、建议（待授权）

1. 服务器 `.env` 的 `DEFAULT_MODEL` 改为服务器真实可用的模型（`qwen2.5:3b` 或 DeepSeek 云端模型），消除 401 浪费
2. 服务器 Ollama 若要支持 glm 系列，需拉取模型并配置认证；否则 providers.json 的 Ollama models 列表应与实际对齐
3. 引擎升级 2.0.15 → 2.0.17 时一并处理（需重启 PM2，待授权）