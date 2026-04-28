# OperatorBoard v0.1.0

**OperatorBoard is a human-governed control plane for AI agents.**

It sits between your agents and production. Agents propose actions; OperatorBoard decides whether they run. The goal: keep a human in the loop without slowing everything down.

---

## What's in this release

### Governance model

OperatorBoard manages agents through a four-level execution ladder:

| Mode | Behavior |
|---|---|
| `observe` | Log-only. Agents can't do anything. |
| `propose` | Every action goes to the approval queue. |
| `approval_required` | Task-level approval gate. Default for new agents. |
| `scoped_autonomy` | Agent runs within explicit constraints. Violations are blocked. |

The approval queue supports multi-action tasks, pipeline triggers (approved task → follow-on task), scheduling, and webhook notifications so you don't have to poll.

**Earned trust** tracks approval rate and constraint violations per agent. At ≥90% approval rate, ≥5 tasks, zero violations, OperatorBoard surfaces a promotion suggestion. You still click the button.

---

### Database governance

Most disasters in agentic systems are database disasters. OperatorBoard treats database access as a separate, harder problem:

- **Four-tier access model** — `none / read_only / write_safe / write_destructive`
- **Structured `db.*` action namespace** — `db.query.read`, `db.row.insert`, `db.row.delete`, `db.schema.alter`, `db.backup.restore`, etc.
- **Shell-bypass detection** — shell commands containing `psql`, `mysql`, `sqlite3` are auto-classified as `write_destructive` and blocked regardless of shell permission settings
- **Backup attestation requirement** — destructive DB actions are blocked unless OperatorBoard independently holds a backup attestation from your backup system. Agent-claimed backup references don't count.
- **Stale attestation enforcement** — configurable `maxBackupAgeMinutes` per agent policy
- **Explicit acknowledgement gate** — `acknowledgeRisk: true` required at approval time for destructive DB actions

Backup attestations can be posted manually via the API or automatically via signed HMAC-SHA256 integrations. Replay protection is enforced on all signed integration endpoints.

**Blocked actions cannot be approved.** There is no operator bypass path.

---

### Security hardening

This release closes a set of vulnerabilities that are common in early agentic control planes:

- **Webhook SSRF prevention** — `isSafeWebhookUrl()` blocks localhost, RFC-1918, link-local (169.254/16), and private IPv6 at agent registration and at every webhook fire
- **Action-type constraint enforcement normalized** — all constraint checks use lowercased action types and `startsWith()` prefix matching, closing case-variant bypasses (`SHELL.EXEC`) and substring evasion paths (`custom_shell_execution`)
- **`allowNetwork` enforced server-side** — `http.*`, `https.*`, `network.*`, `fetch.*`, `request.*`, `socket.*`, `dns.*` and related types are blocked when networking is disabled
- **Network and file read off by default** — `allowNetwork=false` and `allowFileRead=false` in default task execution constraints
- **Approval-state guards** — tasks in `approval_required` or `running` cannot be re-run or rescheduled, preventing silent approval queue wipes
- **Integration replay protection** — each `provider:timestamp:signature` tuple is consumed once within a 5-minute TTL
- **Timing-safe authentication** — `timingSafeEqual` for API key comparisons
- **Honeypot routes** — `/admin/reset`, `/.env`, `/v1/agents/register`, and similar scanner paths return 404 and are logged to the audit trail
- **`OPERATORBOARD_ENABLE_DEV_ROUTES`** — `/dev/reset` is gated behind an env flag, off by default in Docker
- **Safe production defaults** — `OPERATORBOARD_SEED=false`, `OPERATORBOARD_ENABLE_DEV_ROUTES=false` in docker-compose

Known limitations and intentional trade-offs are documented in [SECURITY.md](../SECURITY.md).

---

### Caddy reverse proxy

The included `Caddyfile` provides:

- Rate limiting (60 req/min per remote host — tune to your threat model)
- Scanner path blocking before traffic hits the app
- Security headers on both vhosts (CSP, X-Frame-Options, Referrer-Policy)
- API key stripping from responses (`header_down -X-Operatorboard-Key`)
- JSON access logs with rotation

---

### Developer experience

- **`buildApp()` factory** — injectable `fetchImpl` and configurable scheduler for deterministic testing
- **21 tests across 8 suites** — auth, validation, approval workflows, database governance, scheduler, production boundary, backup attestation integrations, constraint enforcement
- **Monorepo** — pnpm workspaces; shared Zod schemas; API, web, and mock agent as separate packages
- **Docker** — multi-stage Dockerfiles; `docker compose up` for full stack; `--profile demo` to include the mock agent
- **GitHub Actions CI** — typecheck and build on push to `main`/`dev` and PRs
- **Demo seed data** — three pre-configured agents with realistic roles and tasks when `OPERATORBOARD_SEED=true`

---

## Getting started

```bash
git clone https://github.com/projectblackboxllc/operatorboard.git
cd operatorboard
cp .env.example .env          # set OPERATORBOARD_API_KEY
docker compose up
```

Dashboard → http://localhost:3000  
API → http://localhost:4100

Full setup in [README.md](../README.md). Production checklist in [SECURITY.md](../SECURITY.md).

---

## What this is not (yet)

OperatorBoard v0.1.0 is a governance layer, not an orchestration framework. It does not run agents, route messages between agents, or provide an agent SDK. It gives you a control plane to bolt onto agents you're already building.

The roadmap includes: outbound egress controls below the app layer, per-role action allowlists, audit log integrity signing, and structured red-team testing tooling. Contributions welcome.

---

**Full changelog:** [CHANGELOG.md](../CHANGELOG.md)  
**Security policy:** [SECURITY.md](../SECURITY.md)  
**Database governance docs:** [docs/database-governance.md](database-governance.md)  
**Security baseline docs:** [docs/security-baseline.md](security-baseline.md)
