# Future Integration Contracts

These contracts are intentionally documented before implementation so high-risk integrations do not leak into the skeleton.

## Apple Companion

Apple data access should run in a native macOS user-session helper, not inside Docker.

- Reads: Messages and Notes require Full Disk Access for the exact helper binary or parent process.
- Writes: sending messages or creating/deleting Notes requires Automation/TCC prompts.
- Transport: expose a local MCP or HTTP interface bound to loopback.
- Policy: reads start as sensitive/manual; sends are high/manual.
- Safety: use read-only SQLite connections for local databases and never modify Apple databases directly.

## Tesla Cloud Relay

Tesla Fleet API needs public domain infrastructure for key hosting and some telemetry flows.

- Relay owns OAuth redirect handling and `.well-known` public key hosting.
- Local core keeps private keys and command policy.
- Fleet Telemetry should use a public HTTPS endpoint or authenticated tunnel.
- Start with status reads. Commands stay high/manual.

## Finance

Finance should be read-only and routed locally by default.

- Preferred provider: Plaid for Chase, transactions, balances, liabilities, and investment holdings where supported.
- Robinhood: avoid unofficial APIs. Use Plaid Investments or approved official access only.
- No money movement, order placement, or credential scraping in the assistant.
- Financial prompts should not route to hosted LLMs unless the user explicitly overrides policy.

## n8n

n8n should be a deterministic workflow executor, not the root authority.

- Expose selected workflows through MCP only after reviewing scopes.
- Keep secrets in n8n credentials or a dedicated secret manager, not prompts.
- Use n8n for repeatable automations like “create calendar event from structured request.”
- Route all n8n calls through the TypeScript policy gateway.

## OpenClaw

OpenClaw is a fallback for surfaces without stable APIs.

- Run in a disposable profile/container.
- No host filesystem mount by default.
- Prefer VNC/noVNC observation for browser actions.
- Block banking, payments, authentication changes, and destructive browser actions unless manually approved.
- Treat every browser page as potentially prompt-injected.

## Voice Gateway

Voice is a separate realtime layer, not just another chat endpoint.

- Preferred future path: LiveKit Agents for turn detection, interruption handling, and client-side echo cancellation.
- Alternative path: OpenWakeWord or Porcupine, Silero VAD, faster-whisper or whisper.cpp, Gemma 4, and Piper/Kokoro/Coqui TTS.
- Gemma 4 native audio is promising, but keep it behind an interface until local serving support is stable.
- Always provide push-to-talk fallback for noisy rooms or weak echo cancellation.
