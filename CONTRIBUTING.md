# Contributing to LingXi Engine

Thanks for considering a contribution.

## Before you start

- Read the [README](README.md) for product positioning and current support boundaries.
- Read [SECURITY.md](SECURITY.md) before reporting or changing anything security-sensitive.
- For maintainer-only/public-release cleanup items, check [docs/internal-boundaries.md](docs/internal-boundaries.md).

## Local development

### Requirements

- Node.js 18+
- npm 9+
- Optional: Python 3.11+ for `lingxi_engine/` regression checks
- Optional: Docker if you want to test the opt-in sandbox path

### Setup

```bash
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install
cp .env.example .env

# configure at least one provider or local model endpoint
npm run dev
```

By default the main app runs at `http://localhost:3456`.

## Architecture at a glance

- `index.ts`: main HTTP + WebSocket server
- `src/`: core TypeScript runtime (AI routing, tools, auth, storage, channels, platform/mobile helpers)
- `web/`: static UI/site assets
- `lingxi_engine/`: Python multi-model collaboration engine
- `tests/`: TypeScript-side tests and targeted verification scripts

## Checks to run

Please run the smallest relevant existing checks for your changes:

```bash
npm run typecheck
npm test
python lingxi_engine/tests/run_all.py
```

For documentation-only changes, at minimum verify links, commands, and version references against the repository.

## Change expectations

- Keep changes focused and minimal.
- Do not change core runtime behavior just to make a check pass.
- Update documentation when behavior, configuration, or public positioning changes.
- Avoid introducing new dependencies unless there is a strong reason.
- If your change affects auth, tools, sandboxing, channels, or deployment, explain the risk and validation steps in your PR.

## Pull request process

1. Create a focused branch from the active development branch.
2. Make the smallest complete change that solves the issue.
3. Run the relevant checks above.
4. Update docs/tests when needed.
5. Fill out the PR template with testing, security, and documentation notes.

## Commit style

Conventional-style messages are preferred:

```text
type(scope): short summary

docs(readme): rewrite public beta positioning
fix(auth): reject unauthenticated public admin requests
test(router): cover tool routing regression
```

## Security-sensitive contributions

If you believe you found a vulnerability, do **not** open a public issue with exploit details. Follow [SECURITY.md](SECURITY.md) instead.
