[English](README.md) | [简体中文](README.zh-CN.md)

# LingXi Engine

Open-source, self-hosted AI agent platform for conversation, memory, tools, and multi-model orchestration.

> Status: **developer preview / public beta preparation**. LingXi Engine is suitable for local and controlled self-hosted deployments. It is **not** presented here as a production-ready managed SaaS or globally hosted public service.

[![License](https://img.shields.io/github/license/lingxi-engine/lingxi-engine?color=blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-18%2B-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

## What it is

LingXi Engine combines:

- a TypeScript self-hosted chat and agent application with WebSocket streaming, memory, tools, auth, and channel integrations
- a Python multi-model collaboration engine under [`lingxi_engine/`](lingxi_engine/README.md) with its own regression suite
- optional website/mobile assets that are still being prepared for public release

## Capability status

### Stable foundation

- Self-hosted web app with chat, agent conversations, and local persistence
- Multi-provider model routing and OpenAI-compatible integrations
- Tool execution, approval flows, and local memory/persistence
- TypeScript type-checking in CI and Python collaboration-engine regression coverage

### Beta

- Docker-backed tool sandboxing when explicitly enabled
- Channel adapters and mobile packaging workflows
- Release packaging and deployment assets intended for maintainer review

### Experimental

- Cross-instance mesh/platform flows
- Marketplace, hiring, and broader social/distributed workflows
- Maintainer-specific website/demo deployment automation

See [docs/roadmap.md](docs/roadmap.md) for the public roadmap and support level by area.

## Quick start

### Prerequisites

- Node.js **18+** (CI currently runs on Node 20)
- npm **9+**
- Optional: Docker for isolated tool execution
- Optional: Python **3.11+** for the `lingxi_engine/` regression suite

### Run locally

```bash
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install
cp .env.example .env

# configure at least one provider or local model endpoint
# then start the server
npm start
```

Open `http://localhost:3456`.

## Configuration and provider overview

`/.env.example` is the source of truth for the main TypeScript app. Common settings:

| Purpose | Variables | Notes |
| --- | --- | --- |
| Local model endpoint | `OLLAMA_BASE_URL`, `DEFAULT_MODEL` | Useful for fully local/self-hosted experiments |
| Cloud model access | `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `NVIDIA_API_KEY` | Configure only the providers you actually use |
| Tool/reply split | `TOOL_MODEL`, `REPLY_MODEL` | Lets tool-use and final replies use different models |
| Approval mode | `APPROVAL_AUTO_APPROVE` | Leave unset to keep manual approvals |
| Docker sandbox | `USE_DOCKER_SANDBOX=true` | **Off by default**; when enabled, Docker runs with network isolation defaults |
| Cross-instance mesh | `MESH_PLATFORM_URL`, `MESH_TOKEN` | Treat as advanced/experimental setup |

## Security and operational limits

- LingXi Engine is currently a **self-hosted developer platform**, not a hosted multi-tenant product.
- Tool execution and code execution require careful operator review, especially before any public network exposure.
- Docker sandboxing is **opt-in**, not enabled by default.
- Default/local install flows are aimed at trusted environments first; review auth tokens, admin flows, channel credentials, and model keys before internet exposure.
- Some repository files still document maintainer-only deployment workflows and should be reviewed before making the repository public. See [docs/internal-boundaries.md](docs/internal-boundaries.md).

For vulnerability reporting and supported-version policy, see [SECURITY.md](SECURITY.md).

## Demo and deployment status

- No official globally managed SaaS is announced in this repository.
- No public multi-tenant demo is promised here.
- Public website/domain rollout, release hosting, and controlled demo environments still require maintainer review of deployment scripts, server addresses, and website assets.

See [docs/release-checklist.md](docs/release-checklist.md) for remaining manual release tasks.

## Project structure

| Path | Purpose |
| --- | --- |
| `index.ts` | Main TypeScript server entrypoint |
| `src/` | Core application logic: AI routing, auth, tools, storage, channels, mobile/platform support |
| `web/` | Static web assets and website/download pages |
| `lingxi_engine/` | Python multi-model collaboration engine |
| `tests/` | TypeScript-side targeted tests |
| `docs/` | Public release docs plus maintainer review notes |
| `app/`, `mobile-app/` | Mobile packaging/work-in-progress app shells |

## Validation and testing

Run the checks already used by the repository:

```bash
npm run typecheck
npm test
python lingxi_engine/tests/run_all.py
```

The GitHub Actions workflow also runs hygiene checks for BOMs, junk files, and monolith growth limits.

## Documentation and project links

- [Chinese README](README.zh-CN.md)
- [Contributing guide](CONTRIBUTING.md)
- [Support guide](SUPPORT.md)
- [Security policy](SECURITY.md)
- [Release checklist](docs/release-checklist.md)
- [Roadmap](docs/roadmap.md)
- [Maintainer review boundaries](docs/internal-boundaries.md)
- [Python collaboration engine](lingxi_engine/README.md)
- [Changelog](CHANGELOG.md)
- [Releases](https://github.com/lingxi-engine/lingxi-engine/releases)

## License

MIT — see [LICENSE](LICENSE).
