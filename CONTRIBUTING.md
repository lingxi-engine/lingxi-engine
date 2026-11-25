# Contributing to LingXi Engine · 贡献指南

欢迎贡献！本项目是 AI-Native IM 平台，接受功能改进、Bug 修复、文档优化、测试用例。
Contributions welcome: features, bug fixes, docs and tests. English speakers: start with [README.en.md](README.en.md).

## 开发环境 · Dev setup

```bash
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install
cp .env.example .env
# 编辑 .env 配置至少一个 AI Provider
npm run dev
```

Node.js 18+（推荐 20/24）。Docker 方式见 [docs/docker.md](docs/docker.md)。

## 分支策略 · Branching

- `main` — 稳定版本，勿直推（通过 PR 合入）
- `feat/<name>` — 新功能
- `fix/<name>` — Bug 修复
- `docs/<name>` — 文档变更

## 提交规范 · Commit convention

```
type(scope): 简短描述
feat(router): 支持推理过程流式展示
fix(auth): 修复 refresh token 比对逻辑
docs(readme): 补充 API Key 配置指南
```

## 质量门禁 · Quality gates（PR 必须全绿）

```bash
npm run typecheck                  # tsc --noEmit，必须 0 错误
npm test                           # vitest 全量（当前 48 文件 / 649 用例）
npm run test:coverage              # 覆盖率棘轮：只准涨不准跌
npm run test:clean-env             # 剥离本机 Key/LINGXI_* 模拟 CI 干净环境跑全量（防本地假绿）
npx tsx scripts/check-docs.mts     # README 数字/链接与源码一致性门禁
```

- **覆盖率棘轮**：`vitest.config.ts` 中的 thresholds 是下限（当前 statements 15%），
  实测基线之上只允许上调、不允许下调。新增代码请配套测试。
- **干净环境验证**：开发机的 `LINGXI_STRICT_MODEL` / 各家 API Key 会掩盖代码路径，导致本地假绿、CI 红灯（本项目曾三次踩此坑）。`npm run test:clean-env` 剥离这些变量后跑全量套件，忠实复现 CI 干净环境，push 前建议跑一次。
- **文档门禁**：README 里的「N 个内置工具 / N 个消息渠道 / 50 轮工具循环」等数字
  必须与源码一致，改了工具/渠道数量要同步改 README，否则 CI 红灯。
- **BOM 门禁**：package.json / tsconfig.json / ci.yml 等关键配置禁止 UTF-8 BOM。
- **行数棘轮**：index.ts 等巨石文件只准变小不准变大（见 ci.yml hygiene-check）。

## 安全红线 · Security rules

- 绝不提交 `.env`、API Key、token、真实服务器 IP、cookies（workspace/ 已 gitignore）。
- 新增 API 路由必须鉴权（jwtAuth/adminAuth）或显式标注免鉴权理由。
- 危险操作（shell/文件写/代码执行）必须走白名单或沙箱。
- 漏洞请走 [SECURITY.md](SECURITY.md) 私密报告流程，勿开公开 issue。

## 技术栈 · Tech stack

| 项 | 技术 |
|---|---|
| 运行时 | Node.js 18+（推荐 20/24） |
| 语言 | TypeScript (ESM) |
| HTTP | Express 4 |
| 数据库 | SQLite (better-sqlite3) |
| AI SDK | OpenAI Node SDK（多 Provider 路由） |
| 实时通信 | WebSocket (ws) |
| 身份认证 | JWT + bcryptjs |
| 前端 | 原生 HTML/CSS/JS（单文件、零构建） |

## 项目结构 · Project layout

```
src/
├── ai/          # 多 Provider AI 接入 / 故障转移 / 模型路由
├── agents/      # Agent 生命周期管理
├── auth/        # 认证 + Token
├── channels/    # 渠道适配 (Telegram, Signal, iMessage, ...)
├── core/        # 核心逻辑 (路由/记忆/搜索/Cron/沙箱/子代理)
├── mcp/         # MCP 协议
├── middleware/  # Express 中间件 (鉴权/限流/metrics)
├── net/         # LAN 发现 + 跨引擎 mesh
├── plugins/     # 插件系统
├── skills/      # 技能管理器 + 安全技能市场（源码）
├── storage/     # SQLite 数据库
├── tests/       # vitest 单测
├── tools/       # 工具系统 (内置/浏览/搜索/auto-skill)
└── voice/       # TTS + STT
skills/          # 50 个精选技能定义（JSON，运行时加载目录）
web/             # 零依赖前端
docs/            # 双语文档（quickstart / docker）
```

注意：运行时技能目录是**根 `skills/`**，不是 `src/skills/`（后者只放源码）。

## Code Review Checklist

- [ ] `tsc --noEmit` 通过
- [ ] `npm test` 全过，新行为有测试
- [ ] `npm start` 启动正常
- [ ] 无 `require()` 残留（项目是 ESM）
- [ ] 新增路由需鉴权或显式标注免鉴权
- [ ] 敏感操作有白名单/沙箱
- [ ] 错误用 `AppError` 统一格式
- [ ] 用户可见变更已更新 CHANGELOG.md

## 行为准则 · Code of Conduct

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
