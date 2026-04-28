# Disclaimer

**OperatorBoard is governance infrastructure, not a guarantee.**

## No Warranty

OperatorBoard is provided "as is," without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. See the [MIT License](LICENSE) for the complete terms.

## No Liability for Agent Behavior

Project Black Box LLC and the OperatorBoard contributors are **not responsible** for any actions taken by AI agents that are registered with, governed by, or connected to OperatorBoard. This includes but is not limited to:

- Data loss, corruption, or unauthorized access caused by agent activity
- Database changes, deletions, or schema alterations performed by agents
- API calls, network requests, or external service interactions initiated by agents
- Financial transactions, charges, or costs incurred through agent operation
- Any downstream effects of agent decisions, whether approved or not
- Security incidents arising from misconfiguration, weak API keys, or deployment errors

OperatorBoard provides tools to **help** operators review and constrain agent behavior. It does not prevent all possible harms. The approval system, constraint enforcement, and audit logging are controls — they reduce risk, they do not eliminate it.

## Operator Responsibility

You are responsible for:

- Securing your deployment (API keys, network access, TLS)
- Reviewing the [production hardening checklist](SECURITY.md) before going live
- Understanding what each agent you register is capable of
- Auditing agent actions and approval decisions regularly
- Not granting more autonomy than the agent has demonstrated it can handle safely

**Do not connect agents with access to production databases, financial systems, or sensitive customer data without independent security review of your complete stack — including OperatorBoard, your agents, and every system they can reach.**

## AI-Specific Risks

AI agents can produce unexpected, incorrect, or harmful outputs. Even within approved constraint envelopes, agents may:

- Misinterpret task instructions
- Produce plausible-sounding but incorrect proposed actions
- Escalate scope beyond what was intended
- Interact with external systems in ways that cannot be undone

The backup attestation system, approval queue, and execution mode ladder are designed to slow down and surface these risks — not to make agents safe in all circumstances.

## No Legal or Security Advice

Nothing in OperatorBoard, its documentation, or associated materials constitutes legal, security, compliance, or regulatory advice. Consult qualified professionals before deploying autonomous agent systems in regulated environments.

---

*Copyright (c) 2025 Project Black Box LLC. See [LICENSE](LICENSE).*
