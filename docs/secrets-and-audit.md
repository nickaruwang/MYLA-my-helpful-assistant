# Secrets And Audit

## Secrets

Prototype secrets can live in `.env`, but production should move to an OS keychain, 1Password CLI, Doppler, Infisical, or Vault.

Never store these in prompts, audit payloads, or n8n workflow JSON:

- OAuth refresh tokens
- Tesla private keys
- Plaid access tokens
- Hosted LLM API keys
- OpenClaw browser profile credentials

## Audit Log

The audit log is stored in SQLite in `audit_events`.

Properties:

- Append-only application path.
- SQLite triggers reject `UPDATE` and `DELETE`.
- Each row contains the previous row hash.
- Each hash covers stable metadata and the payload digest.
- `AUDIT_HMAC_KEY` can make hashes keyed.

Limitations:

- A user with direct filesystem access can still delete or replace the database.
- For stronger tamper evidence, periodically anchor the latest audit head hash outside the machine.
- Sensitive payload fields should be redacted or encrypted before writing once real integrations are enabled.

Run verification:

```bash
pnpm audit:verify
```
