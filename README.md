<div align="center">
  <h1>OperatorBoard</h1>
  <p><strong>Human-governed control plane for AI agents.</strong><br/>
  Let your agents run. Keep yourself in the loop.</p>

  <p>
    <a href="https://github.com/projectblackbox/operatorboard/actions/workflows/ci.yml">
      <img src="https://github.com/projectblackbox/operatorboard/actions/workflows/ci.yml/badge.svg" alt="CI" />
    </a>
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" />
    <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node 20+" />
    <img src="https://img.shields.io/badge/stack-Next.js%20%2B%20Fastify%20%2B%20SQLite-informational" alt="Stack" />
  </p>
</div>

---

Most AI agent frameworks are **fire-and-forget**. You configure an agent, point it at a task, and hope for the best. That's fine for demos. It's not fine when the agent has access to your file system, your API keys, or your customers' data.

**OperatorBoard** adds the layer that's missing: a human approval checkpoint between what an agent *wants* to do and what it's *allowed* to do — with a full audit trail, per-agent budgets, constraint enforcement, and a trust system that lets you widen an agent's autonomy as it earns it.

> "Let your agents run while you sleep. But not run amok."

---

## How it works

Agents are assigned an **execution mode** that controls how much they can do without asking:

| Mode | What happens |
|---|---|
| `observe` | Agent analyzes and reports. No actions taken. |
| `propose` | Agent proposes actions. You review before anything runs. |
| `approval_required` | Each action requires explicit approval in the dashboard. |
| `scoped_autonomy` | Agent acts within a pre-approved constraint envelope. |

Agents start conservative. As they build a track record — high approval rate, no constraint violations — OperatorBoard computes a **trust score** and suggests promoting them to wider autonomy. Trust is earned, not configured.

---

## Features

- **Approval queue** — Review and approve/deny proposed agent actions from a mobile-friendly dashboard
- **Execution modes** — Four-level ladder from pure observation to scoped autonomy
- **Earned trust** — Approval rate + violation tracking per agent; promotion suggestions when criteria are met
- **Per-task constraints** — Lock down file access, network calls, shell commands, allowed paths, and cost per task
- **Budget enforcement** — Hard stop when an agent hits its USD spending limit
- **Task pipelines** — Chain tasks together; a completed task can trigger the next automatically
- **Scheduled runs** — Queue tasks for future execution; review results when you wake up
- **Org chart** — Model reporting relationships between agents; visualized as a collapsible tree
- **Cost analytics** — Spending by day, task outcomes, approval rates across your fleet
- **Database governance** — Separate controls for read, safe write, and destructive DB actions with backup-aware approvals
- **Webhook notifications** — Get alerted when approval is needed; no polling required
- **Agent health checks** — Ping any registered agent's `/health` endpoint from the dashboard
- **Audit trail** — Every action, approval decision, and constraint violation is logged
- **API security** — Key auth, rate limiting, Caddy reverse proxy config, and honeypot routes included

---

## Quick start

### Local development

```bash
# 1. Clone and install
git clone https://github.com/projectblackbox/operatorboard.git
cd operatorboard
pnpm install

# 2. Configure environment
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
# Edit both .env files — set OPERATORBOARD_API_KEY to a strong random value:
#   openssl rand -hex 32

# 3. (Optional) enable local demo helpers
echo "OPERATORBOARD_ENABLE_DEV_ROUTES=true" >> apps/api/.env
echo "NEXT_PUBLIC_OPERATORBOARD_ENABLE_DEV_TOOLS=true" >> apps/web/.env
echo "OPERATORBOARD_SEED=true" >> apps/api/.env

# 4. Start everything
pnpm dev
# API → http://localhost:4100
# Dashboard → http://localhost:4300
```

### Docker

```bash
# Generate a key and run
export OPERATORBOARD_API_KEY=$(openssl rand -hex 32)
docker compose up

# Dashboard → http://localhost:3000
# API       → http://localhost:4100

# Include the mock agent for a full demo:
docker compose --profile demo up
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      OperatorBoard                       │
│                                                          │
│  ┌──────────────┐     ┌──────────────────────────────┐  │
│  │  Next.js     │────▶│  Fastify API  (port 4100)    │  │
│  │  Dashboard   │◀────│  SQLite · Zod · TypeScript   │  │
│  │  (port 3000) │     └──────────┬───────────────────┘  │
│  └──────────────┘                │                       │
│                                  │  TaskRequest          │
│                       ┌──────────▼──────────┐           │
│                       │   Your AI Agents    │           │
│                       │  (any HTTP adapter) │           │
│                       └─────────────────────┘           │
└─────────────────────────────────────────────────────────┘
```

Agents speak a simple HTTP protocol: receive a `TaskRequest`, return a `TaskResponse` with proposed actions. OperatorBoard handles the rest — approvals, budgets, constraint enforcement, scheduling, and audit logging.

See [`packages/shared/src/index.ts`](packages/shared/src/index.ts) for the full Zod-validated message schema, and [`examples/mock-agent`](examples/mock-agent) for a reference implementation.

For database-destructive workflows, read [`docs/database-governance.md`](docs/database-governance.md) before enabling any write access. Plain English version: an agent can wipe or overwrite your database in seconds; destructive database autonomy should require backup evidence and human acknowledgement.
OperatorBoard now expects that evidence to come from an independent backup attestation recorded in the control plane, not just from the agent saying a backup exists.
Attestations can be recorded manually or posted by a signed integration endpoint backed by provider-specific shared secrets.
For the broader trust model and baseline security posture, read [`docs/security-baseline.md`](docs/security-baseline.md).

---

## Connecting your own agent

Any HTTP server that implements two endpoints can register with OperatorBoard:

```
GET  /health   → { ok: true }
POST /task     → TaskResponse
```

The `TaskResponse` shape:
```ts
{
  taskId: string
  status: "proposal_ready" | "approval_required" | "completed" | "failed" | ...
  summary: string
  actions: ProposedAction[]   // what the agent wants to do
  logs: string[]
  costUsd?: number
}
```

Each `ProposedAction` carries a `risk` level (`low` / `medium` / `high` / `critical`) and a `requiresApproval` flag. OperatorBoard enforces your constraints before forwarding the request and re-checks the response payload before allowing any action to proceed.

Register your agent at `POST /agents`:
```bash
curl -X POST http://localhost:4100/agents \
  -H "X-Operatorboard-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "MyAgent",
    "role": "Researcher",
    "adapterType": "http",
    "endpoint": "http://your-agent-host/task",
    "executionMode": "approval_required",
    "budgetLimitUsd": 10
  }'
```

---

## Production deployment

A [`Caddyfile`](Caddyfile) is included with:
- TLS termination
- Rate limiting (60 req/min)
- Security headers
- Scanner path blocking
- Honeypot routes that log and alert on probe attempts

Production defaults:
- `OPERATORBOARD_ENABLE_DEV_ROUTES=false`
- `NEXT_PUBLIC_OPERATORBOARD_ENABLE_DEV_TOOLS=false`
- `OPERATORBOARD_CORS_ORIGINS` set only to your trusted dashboard origin(s)

```
# Point Caddy at your domain
caddy run --config Caddyfile
```

---

## Verification

Before pushing or deploying:

```bash
pnpm typecheck
pnpm test
pnpm build
```

The API test suite covers auth enforcement, input validation, approval aggregation, scheduler execution, and dev-route gating.

---

## Integrations

Reusable backup attestation signing helpers live in [`packages/agent-adapters/backup-attestor`](packages/agent-adapters/backup-attestor), with a reference integration client in [`examples/backup-attestor`](examples/backup-attestor).

---

## Project structure

```
operatorboard/
├── apps/
│   ├── api/          Fastify API server
│   └── web/          Next.js dashboard
├── packages/
│   └── shared/       Zod schemas shared between API and web
├── examples/
│   └── mock-agent/   Reference agent implementation
├── Caddyfile         Production reverse proxy config
└── docker-compose.yml
```

---

## Why this exists

Autonomous AI agents are becoming practical faster than the tooling to govern them. Most orchestration frameworks focus on what agents *can* do. OperatorBoard focuses on what they're *allowed* to do — and who decides.

The execution mode system, trust tracks, and constraint enforcement aren't bolt-on safety features. They're the product. The goal is an operator who can move fast, sleep soundly, and always know exactly what their agents did and why.

---

## Contributing

Issues and PRs welcome. If you're building an adapter for a specific AI framework, the `examples/` directory is the right place for it.

---

## License

[MIT](LICENSE)
