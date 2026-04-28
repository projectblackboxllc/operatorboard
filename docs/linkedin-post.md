# LinkedIn post — OperatorBoard v0.1.0 launch

---

We just open-sourced OperatorBoard — a human-governed control plane for AI agents.

The problem it solves: AI agents are useful, but the closer they get to production, the more you need a human who can actually say no.

Most approaches bolt on a pause button after the fact. OperatorBoard makes governance the architecture, not an afterthought.

**What it does:**

→ Four-level execution ladder: observe → propose → approval_required → scoped_autonomy
→ Approval queue with multi-action review — tasks stay blocked until every action is decided
→ Database governance layer: destructive DB actions require independently-attested backup evidence before they can even be approved. Agent-claimed backup references don't count.
→ Earned trust: agents build approval history over time. At ≥90% approval rate with zero violations, OperatorBoard surfaces a promotion suggestion. You still click the button.
→ Kill switch, audit trail, cost tracking, org chart, webhook notifications — all included

**What it is not:**

It's not an agent framework. It doesn't run your agents. It's the control plane you put in front of agents you're already building.

The core design principle: **distrust the agent AND the rushed operator AND your own defaults.** Network access, file writes, and shell execution are off by default. Blocked actions cannot be approved — there is no override path. The whole system is built around the assumption that humans under pressure make bad decisions, so the safe choice should also be the easy choice.

We ran a hostile audit before shipping: where does the system trust the operator too much? Where does it trust the agent too much? The answers drove a full security hardening pass before v0.1.0 went out.

Open source, MIT licensed, pnpm monorepo, Docker, full test suite.

github.com/projectblackboxllc/operatorboard

If you're building with agents and thinking about governance — would love to hear what you're running into.

---

*Hashtag suggestions: #AIAgents #AgentSafety #OpenSource #AIGovernance #LLM #BuildingInPublic*
