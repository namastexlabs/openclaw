# OpenClaw Client — Security Model

> This document covers the **client-only build** (`openclaw-client`), not the full gateway.

## Overview

The OpenClaw client is a minimal binary that connects to a remote OpenClaw gateway as a **node**. It does not run a gateway, host AI models, or manage channel integrations. Its attack surface is intentionally minimal.

## Threat Model

### What the client IS
- A WebSocket client that connects to a single configured gateway
- A device that executes gateway-requested operations (system.run, browser proxy) within user-configured permissions
- A CLI tool for sending RPC commands to the gateway

### What the client IS NOT
- A server (no listening ports, no inbound connections)
- An AI provider (no API keys for OpenAI, Anthropic, etc.)
- A messaging gateway (no WhatsApp, Telegram, Discord, Slack, etc.)
- A browser automation server (playwright is not included)

## Network Connections

| Direction | Target | Protocol | Purpose |
|---|---|---|---|
| Outbound | Configured gateway (ws:// or wss://) | WebSocket | Node service, RPC |
| Outbound | github.com | HTTPS | Only during install (git clone) |
| None | No other connections | — | Client makes no other network calls |

The client **never** connects to:
- AI provider APIs (OpenAI, Anthropic, Google, AWS Bedrock)
- Messaging platforms (WhatsApp, Telegram, Discord, Slack, Signal, LINE)
- Browser CDNs or playwright download servers
- Any telemetry or analytics endpoints

## Data Storage

| Location | Contents | Sensitivity |
|---|---|---|
| `~/.openclaw/identity/` | Device pairing token + keypair | Medium — authenticates to gateway |
| `~/.openclaw/openclaw.json` | Configuration (gateway URL, mode) | Low — no secrets |
| `~/.local/share/openclaw/repo/` | Source code + build artifacts | Low — public repo |

The client does **NOT** store:
- API keys for any AI provider
- User credentials or passwords
- Chat history or message content
- Personal data of any kind
- Browser profiles or cookies

## Permissions Model

When connected to a gateway, the client can execute operations **only if**:
1. The gateway sends a request
2. The node's capability profile allows it
3. The user approved the device pairing

### Capabilities (configurable per node)

| Capability | Default | Description |
|---|---|---|
| `system.run` | OFF | Execute shell commands on the host |
| `system.which` | ON | Check if a binary exists |
| `browser` | OFF | Forward browser sessions to gateway |
| `screen` | OFF | Capture screen recordings |
| `camera` | OFF | Access camera |
| `notifications` | ON | Show system notifications |

All sensitive capabilities default to OFF and require explicit opt-in.

## Dependency Audit

The client build includes only these external runtime dependencies:

| Package | Purpose | License |
|---|---|---|
| `commander` | CLI argument parsing | MIT |
| `ws` | WebSocket client | MIT |
| `json5` | Config file parsing | MIT |
| `yaml` | Config file parsing | ISC |
| `zod` | Schema validation | MIT |
| `chalk` | Terminal colors | MIT |
| `@clack/prompts` | Interactive prompts | MIT |
| `proper-lockfile` | File locking | MIT |

Total: ~8 packages. All MIT/ISC licensed.

### Excluded from client build

The following packages are present in the full build but **not included** in the client:

| Package | Reason for exclusion |
|---|---|
| `@whiskeysockets/baileys` | WhatsApp protocol — not needed |
| `grammy` | Telegram bot — not needed |
| `@buape/carbon` | Discord bot — not needed |
| `@slack/bolt` | Slack integration — not needed |
| `@line/bot-sdk` | LINE integration — not needed |
| `openai` | AI provider SDK — not needed |
| `@aws-sdk/client-bedrock` | AI provider SDK — not needed |
| `node-llama-cpp` | Local LLM — not needed (478MB) |
| `playwright-core` | Browser automation — not needed |
| `express` | HTTP server — not needed |
| `@img/*` (sharp) | Image processing — not needed |
| `pdfjs-dist` | PDF processing — not needed |
| `node-edge-tts` | Text-to-speech — not needed |

## Build Reproducibility

- Source: `https://github.com/namastexlabs/openclaw` branch `namastex/main`
- Build: `bun run build:client` (deterministic, pinned lockfile)
- Verify: Compare `sha256sum dist-client/*.js` against published checksums
- SBOM: `SBOM.json` in CycloneDX format included with every release

## Audit Checklist (for security teams)

1. ✅ **Minimal dependencies** — 8 packages, all MIT/ISC, no native binaries
2. ✅ **No server components** — client never listens on any port
3. ✅ **No credential storage** — no API keys, no passwords
4. ✅ **Single outbound connection** — only to configured gateway
5. ✅ **SBOM provided** — CycloneDX format, machine-readable
6. ✅ **Reproducible build** — deterministic from pinned lockfile
7. ✅ **Open source** — full source available for audit
8. ✅ **No telemetry** — no analytics, no phone-home, no tracking

## Reporting Vulnerabilities

Report security issues to: security@namastex.io

We follow responsible disclosure and will acknowledge within 48 hours.
