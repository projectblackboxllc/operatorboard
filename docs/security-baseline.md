# Security Baseline

OperatorBoard is not a product for people who want to trust the model.
It is a product for people who know they should not.

That distinction matters.

The failure mode in agentic systems is usually not a single technical bug. It is a chain:

1. an operator over-trusts a model
2. a team over-trusts a framework
3. a project over-trusts defaults
4. a system gets exposed before its trust boundaries are explicit

This document defines the baseline.

## Core Principle

People should not trust an AI agent because they trust themselves less under time pressure.

The control plane exists to slow down the exact class of decisions that become dangerous when a human is tired, rushed, embarrassed, or trying to ship.

## Trust Boundaries

OperatorBoard assumes:

- the agent is untrusted
- agent-provided metadata is untrusted unless independently verified
- shell access is a dangerous escape hatch, not a convenience
- database-destructive actions are a separate risk class
- approval clicks are not enough without context and friction

Current control-plane trust boundaries:

- destructive DB approvals require OperatorBoard-stored backup attestations
- signed backup integrations require provider-specific secrets and replay resistance
- direct database shell execution is blocked as a policy bypass
- blocked actions cannot be approved later as a shortcut

## Foundational Cybersecurity Rules

These are not optional:

- Keep framework and platform dependencies current enough to stay out of known vulnerable ranges.
- Treat auth, middleware, request validation, and serialization as part of the attack surface.
- Never let raw shell or raw SQL stand in for a governance model.
- Avoid mixing dev convenience routes with production defaults.
- Audit rejected auth attempts, policy violations, and signed integration failures.
- Protect shared secrets with rotation plans and minimal scope.

## Common Flaws In Agentic Systems

These are the recurring mistakes that turn “cool demo” into incident writeup:

- implicit trust in agent summaries
- approval UX that hides the real blast radius
- generic “guardrails” with no independent verification path
- letting shell access tunnel around policy
- missing replay protection on webhook or integration endpoints
- dependency drift into known-CVE ranges
- no clear distinction between read, safe write, and destructive write
- no recovery assumptions: no backups, no restore drills, no attestation trail

## Dependency Hygiene

Minimum operating rule:

- review framework and security-sensitive dependency advisories on a cadence
- record why versions are pinned or raised
- avoid advertising stale version ranges in manifests even if the lockfile currently resolves to safer versions

OperatorBoard currently pays special attention to:

- Next.js
- Fastify
- SQLite bindings and persistence libraries
- schema validation libraries
- any signing, auth, or proxy dependencies

## Human Factors

This product is partly psychological.

The operator is most dangerous when:

- they are certain
- they are rushed
- they are tired
- they think “this one click is probably fine”

So the product should:

- make destructive actions feel heavy
- explain risk in plain English
- force acknowledgement where appropriate
- distinguish operator intention from operator impulse

If an approval surface feels frictionless for a destructive operation, it is probably wrong.

## Production Minimum

Before production use:

- set `OPERATORBOARD_API_KEY`
- set `OPERATORBOARD_CORS_ORIGINS`
- disable dev routes
- configure backup integration secrets
- record and verify backup attestations through a trusted path
- run typecheck, tests, and build on CI
- review current security advisories for core dependencies

## What This Does Not Claim

OperatorBoard does not make autonomous systems safe by itself.

It narrows trust, forces evidence, and improves operator judgment under pressure.
That is the product.
