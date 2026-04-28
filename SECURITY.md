# Security Policy

## Reporting a Vulnerability

If you find a security issue in OperatorBoard, please **do not open a public GitHub issue**.

Email: blackboxinfo@proton.me  
Response target: 48 hours

Include:
- A description of the issue and its potential impact
- Steps to reproduce or a proof of concept
- Any suggested remediation if you have one

We will acknowledge receipt, keep you informed as we investigate, and credit you in the changelog if you'd like.

---

## Supported Versions

| Version | Supported |
|---|---|
| `main` branch | ✅ Active |
| Tagged releases | ✅ Patch fixes backported where feasible |

---

## Security Design Goals

OperatorBoard is built around a specific threat model: **the agent is untrusted, the operator is fallible under pressure, and defaults should be safe without additional configuration.**

Current trust boundaries:

- Every agent action is validated against per-agent constraints before it is acted on
- Destructive database actions require independently-attested backup evidence, not just agent claims
- Network access, file write, and shell execution are **off by default** — agents must be explicitly granted each capability
- Replay protection is enforced on all signed integration endpoints
- Blocked actions cannot be approved — there is no override path at the approval UI
- Direct database shell access is blocked as a policy bypass, regardless of shell permission settings
- When `OPERATORBOARD_API_KEY` is set, all routes except `OPTIONS` pre-flight and `/health` require that key; running without a configured key is explicitly warned at startup and every unauthenticated request is audited — but the API will serve unauthenticated traffic if the env var is unset. **Set the key in production.**

---

## Known Limitations

These are **documented, intentional trade-offs** in the current version — not undisclosed vulnerabilities:

**Manual backup attestations are operator-controlled.**
An operator can post a backup attestation with any timestamp. The system records the claim but does not independently verify the backup exists. Automated integrations via `POST /backup-attestations/integrations/:provider` provide stronger guarantees and should be preferred in production.

**Agent-supplied risk metadata is presented as context, not fact.**
Fields such as `plainLanguage`, `estimatedAffectedRows`, and `backupReference` in a proposed action are provided by the agent and displayed to the operator for decision context. They are not independently verified by OperatorBoard. Treat them as agent claims.

**Cost reporting is agent-self-reported.**
`costUsd` in a task response is added to the agent's running total without cross-verification. Budget enforcement is as reliable as the agent's honesty about its own spend.

**Webhook URL validation blocks known private ranges by pattern.**
The SSRF guard blocks RFC-1918 ranges, localhost, link-local, and common cloud metadata addresses. It does not perform DNS resolution to catch hostnames that resolve to private IPs at request time.

---

## Production Hardening Checklist

Before running OperatorBoard in a production environment:

- [ ] Set `OPERATORBOARD_API_KEY` to a strong random secret (`openssl rand -hex 32`)
- [ ] Set `OPERATORBOARD_CORS_ORIGINS` to your dashboard domain
- [ ] Set `OPERATORBOARD_API_ORIGIN` to your API's public URL if the dashboard and API are on different origins (required for the dashboard CSP `connect-src`)
- [ ] Set `OPERATORBOARD_ENABLE_DEV_ROUTES=false` (default in Docker)
- [ ] Configure `OPERATORBOARD_BACKUP_INTEGRATION_SECRETS` with provider-specific secrets
- [ ] Run behind Caddy or equivalent TLS-terminating reverse proxy
- [ ] Review the included `Caddyfile` — do not use the `OPERATORBOARD_DOMAIN` default in production
- [ ] Set `OPERATORBOARD_SEED=false` in production (default)
- [ ] Review agent `webhookUrl` values — only HTTPS endpoints on known-public hosts are permitted
- [ ] Review `databasePolicy` settings for any agent with `write_destructive` access
- [ ] Enable backup attestation integrations for any agent performing destructive DB operations

---

## Dependency Policy

OperatorBoard monitors security advisories for its core dependencies:

- `fastify` and `@fastify/cors`
- `next` and React
- `better-sqlite3`
- `zod`

Dependencies use `^` range specifiers pinned in `pnpm-lock.yaml`. Update the lockfile and re-run `pnpm -r typecheck && pnpm test` after any dependency bump.
