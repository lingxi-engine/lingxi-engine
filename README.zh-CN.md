# 🐿️ LingXi Engine · 灵犀引擎

[English](README.md) | 简体中文

> **AI-Native 即时通讯平台** — 每个用户绑定一个 AI 智能体，对话时真人与 AI 同在

[![License](https://img.shields.io/github/license/lingxi-engine/lingxi-engine?color=blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-24%2B-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## ✨ 特性

- 🤖 **AI Agent 双向对话** — 每个用户自带 AI 分身，群聊中真人与 Agent 共存
- 🧠 **推理过程可视化** — 支持 DeepSeek R1 / OpenAI o1 等推理模型的思考链流式展示
- 🔧 **多工具系统** — web_search / code_execute / shell_exec / 文件读写 / 时间计算
- 🛡️ **安全沙箱** — Docker 隔离执行代码和命令，默认开启
- 📦 **零依赖前端** — 单文件 HTML (1811 行)，无需 React/Vue
- 🔌 **多渠道** — 支持 Telegram / Signal / iMessage 接入
- 🌐 **多 AI Provider** — OpenAI / DeepSeek / NVIDIA NIM / Ollama 即插即用
- ⏰ **Cron 定时任务** — 带时区支持 + 磁盘持久化
- 💾 **SQLite 存储** — 零配置本地数据库
- 🔒 **JWT 认证** — access token + 刷新令牌滚动刷新
- 📡 **WebSocket 实时推送** — 流式输出 + 工具调用进度广播

## 🚀 快速开始

```bash
# 1. 克隆并安装
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install

# 2. 配置 API Key
cp .env.example .env
# 编辑 .env，至少配置一个 Provider

# 3. 启动
npm start
# 打开 http://localhost:3456
```

**最简单的配置思路**：

| Provider | 环境变量 | 价格 | 推理过程支持 |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | 便宜 | ✅ R1 推理链 |
| NVIDIA NIM | `NVIDIA_API_KEY` | 免费额度 | ❌ |
| Ollama | 无需 Key | 免费 (需 GPU) | 取决于模型 |

## 📋 环境要求

| 依赖 | 版本 | 必须 |
|---|---|---|
| Node.js | 18+ (推荐 24+) | ✅ |
| npm | 9+ | ✅ |
| Docker | 任意 | 可选 (沙箱隔离) |
| Ollama | 任意 | 可选 (本地模型) |

## 🏗 架构

```
index.ts (1849 行)          ← HTTP + WebSocket 主入口
├── src/ai/                 ← AI 接入 (RedisHub + ProviderRegistry)
├── src/agents/             ← Agent 生命周期 (创建/删除/模型切换)
├── src/auth/               ← JWT + bcrypt 认证
├── src/core/
│   ├── router.ts           ← 消息路由 + 工具调用循环
│   ├── cron-scheduler.ts   ← 定时任务 + IANA时区 + 持久化
│   ├── docker-sandbox.ts   ← Docker 沙箱隔离
│   ├── hooks.ts            ← 可编程钩子系统
│   ├── inbox.ts            ← 站内通知
│   ├── compaction.ts       ← 上下文压缩
│   ├── memory-reflector.ts ← 记忆反思
│   ├── push.ts             ← APNs + FCM 推送
│   ├── session-manager.ts  ← 会话生命周期
│   └── ws-handler.ts       ← WebSocket 协议处理
├── src/tools/
│   ├── builtin.ts          ← 15 个内置工具 + Docker沙箱集成
│   ├── executor.ts         ← 工具调用循环
│   ├── search-providers.ts ← Web 搜索 (3 Provider)
│   ├── auto-skill.ts       ← 自动技能学习
│   └── registry.ts         ← 工具注册表
├── src/middleware/
│   ├── jwt-auth.ts         ← JWT 鉴权 (required/optional)
│   ├── admin-auth.ts       ← Admin Token 鉴权 (fail-secure)
│   └── rate-limit.ts       ← 内存限流 (X-Forwarded-For)
├── src/storage/db.ts       ← SQLite (better-sqlite3) 数据库
├── src/channels/           ← Telegram / Signal / iMessage 适配
├── src/voice/              ← TTS + STT
└── web/index.html          ← 前端单文件 (1811行)
```

## 🔒 安全

修复了从 v1.0.0 的 15 个安全漏洞 (详见 [CHANGELOG](CHANGELOG.md))：

- ✅ 全局 JWT 鉴权兜底
- ✅ Admin Token 防护 (fail-secure)
- ✅ Docker 沙箱隔离 (shell_exec + code_execute)
- ✅ shell_exec 命令白名单
- ✅ 文件操作 safePath 约束
- ✅ WebSocket 生产环境拒绝匿名连接
- ✅ Slack webhook 签名校验
- ✅ 备份文件 (.bak) 阻止公开下载
- ✅ auto-skill 名称路径穿越防护
- ✅ singal.ts exec → execFile (命令注入修复)

## 🤝 贡献

欢迎 Pull Request。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
npm run dev        # 开发模式 (热重载)
npm run typecheck  # 类型检查 (必须通过)
```

## 📄 许可证

MIT License — 详见 [LICENSE](LICENSE)。