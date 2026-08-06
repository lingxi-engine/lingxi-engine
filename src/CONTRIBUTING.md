# Contributing to LingXi Engine

欢迎贡献！本项目是 AI-Native IM 平台，接受功能改进、Bug 修复、文档优化、测试用例。

## 开发环境

```bash
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install
cp .env.example .env
# 编辑 .env 配置至少一个 AI Provider
npm run dev
```

## 分支策略

- `main` — 稳定版本，勿直推
- `feat/<name>` — 新功能
- `fix/<name>` — Bug 修复
- `docs/<name>` — 文档变更

## 提交规范

```
type(scope): 简短描述

feat(router): 支持推理过程流式展示
fix(auth): 修复 refresh token 比对逻辑
docs(readme): 补充 API Key 配置指南
...
```

## 类型检查

```bash
npm run typecheck    # 必须通过（exit 0）
```

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js 24+ |
| 语言 | TypeScript (ESM) |
| HTTP | Express 4 |
| 数据库 | SQLite (better-sqlite3) |
| AI SDK | OpenAI Node SDK |
| 实时通信 | WebSocket (ws) |
| 身份认证 | JWT + bcryptjs |
| 前端 | 原生 HTML/CSS/JS (单文件) |

## 项目结构

```
src/
├── ai/          # 多 Provider AI 接入
├── agents/      # Agent 生命周期管理
├── auth/        # 认证与 Token
├── channels/    # 渠道适配 (Telegram, Signal, iMessage)
├── core/        # 核心逻辑 (路由/记忆/搜索/Cron/沙箱)
├── mcp/         # MCP 协议
├── middleware/  # Express 中间件
├── plugins/     # 插件系统
├── storage/     # SQLite 数据层
├── tools/       # 工具系统 (内置/浏览器/搜索)
└── voice/       # TTS + STT
```

## Code Review Checklist

- [ ] `tsc --noEmit` 通过
- [ ] `npm start` 启动正常
- [ ] 无 `require()` 残留 (项目是 ESM)
- [ ] 新增路由需鉴权或显式标注免鉴权
- [ ] 敏感操作有白名单/沙箱
- [ ] 错误用 `AppError` 统一格式

