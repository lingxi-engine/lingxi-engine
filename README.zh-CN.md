[English](README.md) | [简体中文](README.zh-CN.md)

# 灵犀引擎

灵犀引擎是一个**开源、自托管**的 AI Agent 平台，提供对话、记忆、工具调用与多模型协作能力。

> 当前状态：**开发者预览 / 面向公开 Beta 的准备阶段**。仓库适合本地部署或受控环境试用，**不应**在此仓库中被表述为成熟的托管 SaaS 或全球公共服务。

## 项目定位

仓库当前包含两部分核心能力：

- TypeScript 主应用：聊天、Agent、WebSocket 流式输出、工具系统、认证、存储、渠道接入
- Python 协作引擎：位于 [`lingxi_engine/`](lingxi_engine/README.md)，用于多模型讨论、记忆与元认知实验

## 能力状态

### 相对稳定

- 自托管 Web 应用与本地持久化
- 多 Provider / OpenAI 兼容模型接入
- 工具调用、审批流、基础认证
- TypeScript 类型检查与 Python 协作引擎回归测试

### Beta

- 显式开启后的 Docker 工具沙箱
- 渠道接入与移动端打包
- 版本打包与部署资产

### 实验性

- Mesh / 平台 / 市场 / 跨实例协作
- 面向公开网站或演示环境的部署自动化

更多说明见 [docs/roadmap.md](docs/roadmap.md)。

## 快速开始

### 环境要求

- Node.js 18+
- npm 9+
- 可选：Docker（隔离工具执行）
- 可选：Python 3.11+（运行 `lingxi_engine/` 回归测试）

### 本地运行

```bash
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install
cp .env.example .env

# 至少配置一个模型 Provider 或本地模型端点
npm start
```

启动后访问 `http://localhost:3456`。

## 配置与 Provider 概览

主应用以 `/.env.example` 为准，常用配置包括：

| 用途 | 变量 | 说明 |
| --- | --- | --- |
| 本地模型端点 | `OLLAMA_BASE_URL`、`DEFAULT_MODEL` | 适合纯自托管试验 |
| 云端模型接入 | `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`NVIDIA_API_KEY` | 按需配置 |
| 工具/回复分模 | `TOOL_MODEL`、`REPLY_MODEL` | 可让工具调用与最终回复使用不同模型 |
| 审批策略 | `APPROVAL_AUTO_APPROVE` | 留空则保持人工审批 |
| Docker 沙箱 | `USE_DOCKER_SANDBOX=true` | **默认关闭**，显式开启才使用 Docker |
| Mesh 组网 | `MESH_PLATFORM_URL`、`MESH_TOKEN` | 高级/实验性能力 |

## 安全与发布边界

- 当前仓库定位是**自托管开发者平台**，不是托管型多租户产品。
- 工具执行与代码执行功能在公网部署前需要额外审查。
- Docker 沙箱是**可选项**，不是默认开启。
- 仓库仍保留部分维护者内部部署资产；公开前请先完成人工审查。详见 [docs/internal-boundaries.md](docs/internal-boundaries.md)。

漏洞报告流程与支持版本策略见 [SECURITY.md](SECURITY.md)。

## Demo / 部署状态

- 仓库未声明官方全球托管 SaaS。
- 仓库未承诺长期公开多租户 Demo。
- 公共网站、下载域名、受控演示环境仍需维护者完成服务器与域名侧的人工检查。

详见 [docs/release-checklist.md](docs/release-checklist.md)。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `index.ts` | TypeScript 主服务入口 |
| `src/` | AI、工具、认证、存储、渠道、平台/移动端相关逻辑 |
| `web/` | 静态前端与网站/下载页资源 |
| `lingxi_engine/` | Python 多模型协作引擎 |
| `tests/` | TypeScript 侧测试与验证脚本 |
| `docs/` | 公开文档与维护者审查说明 |
| `app/`、`mobile-app/` | 移动端壳与打包资产 |

## 校验命令

```bash
npm run typecheck
npm test
python lingxi_engine/tests/run_all.py
```

## 相关文档

- [English README](README.md)
- [贡献指南](CONTRIBUTING.md)
- [支持渠道](SUPPORT.md)
- [安全策略](SECURITY.md)
- [发布清单](docs/release-checklist.md)
- [路线图](docs/roadmap.md)
- [公开前审查边界](docs/internal-boundaries.md)
- [Python 协作引擎说明](lingxi_engine/README.md)
- [更新日志](CHANGELOG.md)
- [Releases](https://github.com/lingxi-engine/lingxi-engine/releases)

## 许可证

MIT，见 [LICENSE](LICENSE)。
