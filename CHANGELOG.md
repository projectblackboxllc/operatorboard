# Changelog

All notable changes to OperatorBoard are documented here.

---

## [Unreleased]

---

## [0.1.0-rc.2] — 2025

### Security fixes (pre-release audit, round 2)

- **Manual attestation provenance hardened** — `POST /backup-attestations` always sets `source: "manual"` server-side regardless of request body; `source: "integration"` can only be set by the signed `POST /backup-attestations/integrations/:provider` path. Closes attestation provenance spoofing vector.
- **HMAC canonical string now binds `provider`** — the route parameter `:provider` is included in the signed canonical string as `provider.timestamp.body`, preventing a valid request from being replayed across provider endpoints even if two providers share a secret. `signBackupAttestation` and `createSignedAttestationRequest` in the `backup-attestor` adapter package updated accordingly.
- **Future timestamps rejected at integration ingest** — replaced `Math.abs(age)` freshness check with a directional guard: requests must be no more than 5 minutes old and no more than 30 seconds in the future (clock skew tolerance). A timestamp backdated to appear fresh was already blocked; now forward-dated requests are blocked too.
- **Dashboard CSP supports split-domain deployments** — `connect-src` in the Caddy dashboard vhost now includes `{$OPERATORBOARD_API_ORIGIN:}` so operators running the dashboard and API on separate origins can add the API URL without editing the `Caddyfile`. `OPERATORBOARD_API_ORIGIN` added to the production hardening checklist in `SECURITY.md`.
- **Docs accuracy** — auth description corrected from "all non-GET, non-health routes" to "all routes except `OPTIONS` pre-flight and `/health`" (GET routes are protected; the old description understated coverage)
- **3 new tests** — provenance spoofing blocked on manual path; cross-provider signature replay rejected; future-dated timestamp rejected. Suite is now 21 tests across 8 suites.

---

## [0.1.0] — 2025

### Initial release

OperatorBoard is a human-governed control plane for AI agents. This first release establishes the core governance model and security posture.

---

### Core governance

- **Execution modes** — four-level ladder from `observe` to `propose` to `approval_required` to `scoped_autonomy`
- **Approval queue** — per-action human review with multi-action support; task stays in `approval_required` until every action is decided
- **Earned trust** — approval rate + violation tracking per agent; automatic promotion suggestions at ≥90% approval rate, ≥5 tasks, zero violations
- **Kill switch** — `suspend`/`resume` per agent, pauses associated tasks
- **Task pipelines** — completed or approved tasks can trigger a follow-on task automatically
- **Scheduled tasks** — queue tasks for future execution with ISO 8601 scheduling
- **Org chart** — model reporting relationships between agents, visualized as a collapsible tree
- **Cost analytics** — spend by day, task outcomes, and approval rates across the fleet
- **Webhook notifications** — alerts on `approval_required`, `completed`, and approval decisions; no polling required
- **Agent health checks** — ping any registered agent's `/health` endpoint from the dashboard
- **Full audit trail** — every action, approval decision, constraint violation, heartbeat, and integration attempt logged

---

### Database governance

- **Four-tier database access model** — `none / read_only / write_safe / write_destructive`
- **Structured `db.*` action type namespace** — `db.query.read`, `db.row.insert`, `db.row.delete`, `db.schema.alter`, `db.backup.restore`, etc.
- **Shell-bypass detection** — shell commands containing `psql`, `mysql`, `sqlite3`, and similar tools are auto-classified as `write_destructive` and blocked
- **Backup attestation system** — destructive DB actions blocked unless OperatorBoard holds an independent attestation matching the backup reference
- **Stale attestation enforcement** — configurable `maxBackupAgeMinutes` per agent policy
- **Explicit acknowledgement gate** — `acknowledgeRisk: true` required on approval body for destructive DB actions
- **Blocked actions cannot be approved** — hard gate, no operator bypass path
- **Signed integration ingestion** — `POST /backup-attestations/integrations/:provider` with HMAC-SHA256, timestamp freshness, and replay protection
- **`packages/agent-adapters/backup-attestor`** — client library for posting signed attestations from backup provider integrations

---

### Security hardening

- **`X-Operatorboard-Key` API authentication** — all routes except `OPTIONS` pre-flight and `/health` require a configured API key; running without a key is warned and audited
- **Timing-safe authentication** — primary auth hook uses `timingSafeEqual` for consistency with signature validation
- **Webhook SSRF prevention** — `isSafeWebhookUrl()` blocks localhost, RFC-1918 ranges, link-local (169.254/16), and private IPv6 targets; enforced at agent registration and at every webhook fire
- **Action-type constraint enforcement normalized** — all constraint checks (file, shell, network, database) use lowercased action types to prevent case-variant bypasses (`SHELL.EXEC` treated identically to `shell.exec`)
- **Pattern-match precision** — constraint checks use `startsWith()` on normalized types, not substring matching, closing evasion paths like `custom_shell_execution`
- **`allowNetwork` enforced server-side** — `http.*`, `https.*`, `network.*`, `fetch.*`, `request.*`, `socket.*`, `dns.*` and related action types are blocked when networking is disabled
- **Network and file read off by default** — `allowNetwork=false` and `allowFileRead=false` in default task execution constraints
- **Approval-state guards** — tasks in `approval_required` or `running` status cannot be re-run or rescheduled, preventing workflow abuse and silent approval queue wipes
- **Integration replay protection** — each `provider:timestamp:signature` tuple is consumed once; replay within TTL window returns 401 and is audited
- **Honeypot routes** — `/admin/reset`, `/.env`, `/v1/agents/register`, and similar scanner-probe paths return 404 and are logged to the audit trail
- **Caddy reverse proxy configuration** — rate limiting, scanner path blocking, security headers, CSP on both vhosts, correct `header_down` direction for key stripping
- **`OPERATORBOARD_ENABLE_DEV_ROUTES`** — `/dev/reset` is gated behind an env flag, off by default in Docker
- **Safe production defaults** — `OPERATORBOARD_SEED=false` and `OPERATORBOARD_ENABLE_DEV_ROUTES=false` in docker-compose

---

### Developer experience

- **`buildApp()` factory export** — injectable `fetchImpl` and configurable scheduler for deterministic testing
- **21-test suite** across 8 suites covering auth, validation, approval workflows, database governance, scheduler, production boundary, backup attestation integrations, and constraint enforcement
- **Monorepo** — pnpm workspaces with shared Zod schemas, separate API and web packages, mock agent reference implementation
- **Docker** — multi-stage Dockerfiles for API, web, and mock agent; `docker compose up` for full stack
- **GitHub Actions CI** — typecheck and build on push to `main`/`dev` and PRs
- **Demo seed data** — three pre-configured agents with realistic roles, execution modes, and tasks loaded on first start when `OPERATORBOARD_SEED=true`
- **`docs/database-governance.md`** — full database governance model and API surface documentation
- **`docs/security-baseline.md`** — security philosophy, common agentic system failure modes, and production checklist
