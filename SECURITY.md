# Security Policy

## Scope and current status

LingXi Engine is currently published as an **open-source, self-hosted developer preview**. The repository includes agent tooling, model-provider credentials, admin/auth flows, channel integrations, and optional sandbox execution paths. Treat every deployment as operator-managed infrastructure.

This repository does **not** claim:

- a managed multi-tenant SaaS
- a public bug-bounty program
- production-readiness for arbitrary internet exposure without operator review

## Reporting a vulnerability

Please **do not** open a public issue for a suspected vulnerability.

Instead:

1. Use GitHub's private vulnerability reporting flow ("Report a vulnerability") if it is enabled for this repository.
2. If private reporting is unavailable, contact the repository owners through a private GitHub channel and include:
   - affected version or commit
   - deployment model (local, self-hosted server, website asset, channel integration, etc.)
   - reproduction steps
   - impact assessment
   - any logs or screenshots with secrets redacted

Please avoid posting proof-of-concept exploits, credentials, tokens, or customer data in public.

## Response expectations

The maintainers will try to:

- acknowledge receipt
- reproduce and assess severity
- prepare a fix or mitigation
- publish a coordinated disclosure when appropriate

Because this is still a developer preview, timelines are best-effort rather than SLA-backed.

## Security boundaries and assumptions

- **Self-hosted first:** operators are responsible for network exposure, TLS, host hardening, reverse proxies, backups, and access control.
- **Sandboxing:** Docker sandboxing is **opt-in** (`USE_DOCKER_SANDBOX=true`). If you do not enable it, tool execution falls back to the repository's built-in execution path and should be treated as higher risk.
- **Secrets:** keep provider API keys, admin tokens, JWT secrets, push credentials, and channel tokens out of version control. Store them in environment files or another secret-management system.
- **Channels and external integrations:** Slack/Telegram/Signal/Feishu/WeChat/iMessage style integrations may require additional validation, webhook security, and operator review before public deployment.
- **Public demo caution:** do not assume the repository's website assets or deployment helper scripts are ready for unrestricted public hosting. Review [docs/internal-boundaries.md](docs/internal-boundaries.md) first.

## Secret handling guidance

- Never commit real API keys, webhook secrets, service-account files, or production endpoint credentials.
- Rotate any credential immediately if it was ever committed or exposed in logs, screenshots, or issue comments.
- Redact tokens and user data before sharing logs for support or bug reports.

## Supported versions

Until a broader support policy is published, security fixes are only expected for the current development line:

| Version line | Supported |
| --- | --- |
| 2.0.x | Yes |
| < 2.0 | No |

Older snapshots, internal deployment notes, and historic artifacts are provided as repository history only and should not be treated as supported release lines.
