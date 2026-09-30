# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.0.x (current) | ✅ |
| < 2.0 | ❌ |

## Reporting a Vulnerability

**Please do not open a public Issue for security bugs.**

Report privately via GitHub Security Advisories:
**Security → Report a vulnerability** on this repository.

Include:
- affected version / commit
- reproduction steps
- impact assessment

We aim to acknowledge within **72 hours** and ship a fix or mitigation within **14 days**.

## Deployment Responsibilities

LingXi Engine is **self-hosted**. The maintainers of this repository do not operate
your instance and cannot see your data. You are responsible for:

### 1. Secrets
- Copy `.env.example` → `.env` and fill in your own keys.
- **`.env`, `data/`, `usage.json` are git-ignored and must never be committed.**
- If you fork publicly, double-check that no `.env` slipped into history:
  ```bash
  git log --all --full-history -- .env data/
  ```

### 2. Network exposure
The default bind is meant for **localhost / trusted LAN**.

When exposing to the internet, you **must** put a TLS-terminating reverse proxy
in front and set at minimum:

```bash
# .env
PORT=3456
HOST=127.0.0.1        # engine itself only listens locally
# plus your proxy's auth/rate-limit settings
```

An internet-facing deployment **without** authentication and TLS is an
unprotected endpoint on your machine.

### 3. Mobile clients
The Android/iOS app is a **remote control for your own engine**. It does not
carry model capability of its own. Anyone with the engine URL **and** an account
can drive your agent — treat the engine address like a password, and prefer
Tailscale / WireGuard / LAN over exposing a public port.

### 4. Tool execution
The agent can run shell commands, read/write files and make network calls.
Run it in a container or VM you are willing to lose:

```bash
SANDBOX_ENABLED=true    # use Docker confinement
```

Without Docker the engine prints a `degraded mode` warning and executes **on the host**.

### 5. Data
All conversations, memories and skills are stored locally in `data/main.db`
(SQLite). Deleting that file resets the instance. Back it up before upgrades.

## Memory Revocation Semantics

The memory system supports **soft revocation** (`revoked_memory` table) so that
"X is no longer used" removes X from the active context while keeping an audit
trail. This is intentional: silently deleting memories makes the system unable to
explain why a decision changed.

If you need a hard reset, clear the SQLite tables directly while the engine is stopped.

## Responsible Disclosure

We will not pursue legal action for good-faith research that:
- does not degrade the service for other users
- does not access data belonging to others
- does not exceed what a normal user can already do
- gives us reasonable time to fix before public disclosure
