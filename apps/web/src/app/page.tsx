"use client";

import { useEffect, useMemo, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

type Agent = {
  id: string;
  name: string;
  role: string;
  adapterType: string;
  endpoint: string;
  executionMode: string;
  status: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reportsTo?: string;
  webhookUrl?: string;
  budgetLimitUsd?: number;
  spentUsdTotal?: number;
  suspendedAt?: string;
  databasePolicy?: {
    access: "none" | "read_only" | "write_safe" | "write_destructive";
    allowRawSql: boolean;
    allowSchemaChanges: boolean;
    allowBackupRestore: boolean;
    backupPolicy: {
      requireFreshBackupBeforeDestructive: boolean;
      maxBackupAgeMinutes: number;
      requireOperatorAcknowledgement: boolean;
    };
  };
  createdAt: string;
};

type Action = {
  id: string;
  type: string;
  risk: string;
  requiresApproval: boolean;
  summary: string;
  payload: Record<string, unknown>;
  safety?: {
    capability?: "general" | "database";
    destructive?: boolean;
    plainLanguage?: string;
    estimatedAffectedRows?: number;
    backupVerifiedAt?: string;
    backupReference?: string;
  };
};

type Task = {
  id: string;
  title: string;
  description: string;
  status: string;
  assignedAgentId?: string;
  scheduledAt?: string;
  onComplete?: { createTask: { title: string; description: string; assignedAgentId?: string } };
  createdAt: string;
  updatedAt: string;
  lastResponse?: {
    summary: string;
    actions: Action[];
    logs: string[];
    costUsd?: number;
    metadata: Record<string, unknown>;
  };
};

type Approval = {
  id: string;
  taskId: string;
  actionId: string;
  status: string;
  createdAt: string;
  reviewedAt?: string;
};

type AuditEvent = {
  id: string;
  createdAt: string;
  actorType: string;
  eventType: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
};

type Analytics = {
  totalSpent: number;
  taskCount: number;
  agentCount: number;
  approvalRate: number | null;
  byDay: Record<string, { runs: number; costUsd: number }>;
  tasksByStatus: Record<string, number>;
};

type TrustData = {
  tasksRun: number;
  approvalRate: number | null;
  approvedCount: number;
  deniedCount: number;
  violations: number;
  totalCost: number;
  suggestion: { promote: boolean; to: string; reason: string } | null;
};

type BackupAttestation = {
  id: string;
  system: string;
  scope: string;
  reference: string;
  verifiedAt: string;
  source: "manual" | "integration";
  metadata: Record<string, unknown>;
  createdAt: string;
};

// ── API client ────────────────────────────────────────────────────────────────

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";
const API_KEY = process.env.NEXT_PUBLIC_OPERATORBOARD_API_KEY ?? "";
const DEV_TOOLS_ENABLED = process.env.NEXT_PUBLIC_OPERATORBOARD_ENABLE_DEV_TOOLS === "true";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.headers instanceof Headers) options.headers.forEach((v, k) => { headers[k] = v; });
  else if (Array.isArray(options?.headers)) { for (const [k, v] of options.headers) headers[k] = v; }
  else if (options?.headers) Object.assign(headers, options.headers);
  if (options?.body) headers["content-type"] = "application/json";
  if (API_KEY) headers["x-operatorboard-key"] = API_KEY;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (!res.ok) { const t = await res.text(); throw new Error(t); }
  return res.json() as Promise<T>;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function statusClass(s: string) {
  if (["approved", "completed", "online", "idle"].includes(s)) return "good";
  if (["approval_required", "proposal_ready", "pending", "running", "assigned", "scheduled"].includes(s)) return "warn";
  if (["failed", "denied", "error", "offline"].includes(s)) return "bad";
  return "";
}

function isAlert(eventType: string) {
  return ["honeypot", "auth.rejected", "constraint.violation"].some((k) => eventType.includes(k));
}

function getDbReview(action: Action | undefined) {
  if (!action) return null;
  const safety = action.safety ?? {};
  const type = action.type.toLowerCase();
  const isDb = safety.capability === "database" || type.startsWith("db.");
  if (!isDb) return null;

  const destructive = safety.destructive === true
    || type.startsWith("db.row.delete")
    || type.startsWith("db.schema.alter")
    || type.startsWith("db.backup.restore")
    || type.startsWith("db.query.execute");

  const plainLanguage = safety.plainLanguage
    ?? (type.startsWith("db.row.delete")
      ? "This can permanently delete database records."
      : type.startsWith("db.schema.alter")
        ? "This can change your database schema and break applications."
        : type.startsWith("db.backup.restore")
          ? "This can overwrite live data with a backup restore."
          : type.startsWith("db.query.execute")
            ? "This executes raw SQL directly against a database."
            : type.startsWith("db.row.update")
              ? "This will modify existing database records."
              : type.startsWith("db.row.insert")
                ? "This will insert new database rows."
                : type.startsWith("db.query.read")
                  ? "This reads data from a database."
                  : "This performs a database operation.");

  return {
    destructive,
    plainLanguage,
    estimatedAffectedRows: safety.estimatedAffectedRows,
    backupReference: safety.backupReference
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BudgetBar({ spent, limit }: { spent: number; limit: number }) {
  const pct = Math.min((spent / limit) * 100, 100);
  const color = pct >= 90 ? "var(--bad)" : pct >= 60 ? "var(--warn)" : "var(--good)";
  return (
    <div style={{ marginTop: 8 }}>
      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
        ${spent.toFixed(4)} / ${limit.toFixed(2)} ({pct.toFixed(0)}%)
      </div>
      <div style={{ height: 4, background: "var(--border)", borderRadius: 2 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width 0.4s" }} />
      </div>
    </div>
  );
}

function TrustMeter({ data }: { data: TrustData }) {
  const pct = data.approvalRate !== null ? Math.round(data.approvalRate * 100) : null;
  const color = pct === null ? "var(--muted)" : pct >= 90 ? "var(--good)" : pct >= 60 ? "var(--warn)" : "var(--bad)";
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row" style={{ fontSize: 11, marginBottom: 4 }}>
        <span className="muted">Trust:</span>
        {pct !== null
          ? <span style={{ color }}>{pct}% approval</span>
          : <span className="muted">no data yet</span>}
        <span className="muted">· {data.tasksRun} runs</span>
        {data.violations > 0 && <span style={{ color: "var(--bad)" }}>· {data.violations} violations</span>}
      </div>
      {pct !== null && (
        <div style={{ height: 3, background: "var(--border)", borderRadius: 2 }}>
          <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width 0.4s" }} />
        </div>
      )}
      {data.suggestion && (
        <div className="suggestion-banner" style={{ marginTop: 8 }}>
          <span>↑ Ready for <strong>{data.suggestion.to}</strong></span>
          <span className="muted" style={{ fontSize: 11 }}> — {data.suggestion.reason}</span>
        </div>
      )}
    </div>
  );
}

function OrgNode({ agent, tree, depth, allAgents, onSuspend, onResume, trustMap }: {
  agent: Agent;
  tree: Map<string | null, Agent[]>;
  depth: number;
  allAgents: Agent[];
  onSuspend: (id: string) => void;
  onResume: (id: string) => void;
  trustMap: Map<string, TrustData>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const children = tree.get(agent.id) ?? [];
  const trust = trustMap.get(agent.id);

  return (
    <div style={{ paddingLeft: depth > 0 ? 28 : 0, borderLeft: depth > 0 ? "2px solid var(--border)" : "none", marginLeft: depth > 0 ? 12 : 0 }}>
      <div className="item" style={{ marginBottom: 8 }}>
        <div className="row">
          <div className="item-title" style={{ flex: 1 }}>{agent.name}</div>
          <span className={`badge ${statusClass(agent.status)}`}>{agent.status}</span>
          {agent.suspendedAt && <span className="badge bad">suspended</span>}
          <span className="badge">{agent.executionMode}</span>
          {children.length > 0 && (
            <button className="secondary" onClick={() => setCollapsed(!collapsed)} style={{ padding: "2px 8px", fontSize: 11 }}>
              {collapsed ? "▶" : "▼"} {children.length}
            </button>
          )}
          {agent.suspendedAt
            ? <button className="secondary" onClick={() => onResume(agent.id)}>Resume</button>
            : <button className="danger" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => onSuspend(agent.id)}>Suspend</button>}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>{agent.role}{agent.model ? ` · ${agent.model}` : ""}</div>
        {agent.budgetLimitUsd !== undefined && (
          <BudgetBar spent={agent.spentUsdTotal ?? 0} limit={agent.budgetLimitUsd} />
        )}
        {trust && <TrustMeter data={trust} />}
      </div>
      {!collapsed && children.map((child) => (
        <OrgNode key={child.id} agent={child} tree={tree} depth={depth + 1}
          allAgents={allAgents} onSuspend={onSuspend} onResume={onResume} trustMap={trustMap} />
      ))}
    </div>
  );
}

function OrgChart({ agents, onSuspend, onResume, trustMap }: {
  agents: Agent[];
  onSuspend: (id: string) => void;
  onResume: (id: string) => void;
  trustMap: Map<string, TrustData>;
}) {
  const tree = useMemo(() => {
    const t = new Map<string | null, Agent[]>();
    for (const a of agents) {
      const p = a.reportsTo ?? null;
      if (!t.has(p)) t.set(p, []);
      t.get(p)!.push(a);
    }
    return t;
  }, [agents]);

  const hasRelationships = agents.some((a) => a.reportsTo);
  if (agents.length === 0) return null;

  const roots = tree.get(null) ?? agents;

  return (
    <div className="card full">
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Org Chart</h2>
        {!hasRelationships && <span className="muted" style={{ fontSize: 12 }}>Set "Reports To" on agents to build the hierarchy</span>}
      </div>
      <div>
        {roots.map((agent) => (
          <OrgNode key={agent.id} agent={agent} tree={tree} depth={0}
            allAgents={agents} onSuspend={onSuspend} onResume={onResume} trustMap={trustMap} />
        ))}
      </div>
    </div>
  );
}

function CostAnalytics({ analytics }: { analytics: Analytics | null }) {
  if (!analytics) return <div className="card full"><p className="muted">Loading analytics…</p></div>;

  const days = Object.entries(analytics.byDay).sort(([a], [b]) => a.localeCompare(b)).slice(-14);
  const maxCost = Math.max(...days.map(([, d]) => d.costUsd), 0.0001);

  return (
    <div className="card full">
      <h2>Analytics</h2>
      <div className="stats-row">
        <div className="stat-box">
          <div className="stat-value">${analytics.totalSpent.toFixed(4)}</div>
          <div className="muted">total spent</div>
        </div>
        <div className="stat-box">
          <div className="stat-value">{analytics.taskCount}</div>
          <div className="muted">total tasks</div>
        </div>
        <div className="stat-box">
          <div className="stat-value">{analytics.agentCount}</div>
          <div className="muted">agents</div>
        </div>
        <div className="stat-box">
          <div className="stat-value">
            {analytics.approvalRate !== null ? `${(analytics.approvalRate * 100).toFixed(0)}%` : "—"}
          </div>
          <div className="muted">approval rate</div>
        </div>
        {Object.entries(analytics.tasksByStatus).map(([status, count]) => (
          <div key={status} className="stat-box">
            <div className={`stat-value ${statusClass(status)}`}>{count}</div>
            <div className="muted">{status}</div>
          </div>
        ))}
      </div>
      {days.length > 0 && (
        <div className="analytics-chart">
          {days.map(([day, data]) => (
            <div key={day} className="analytics-col">
              <div className="analytics-bar-wrap">
                <div
                  className="analytics-bar"
                  style={{ height: `${Math.max((data.costUsd / maxCost) * 100, 2)}%` }}
                  title={`${day}: $${data.costUsd.toFixed(4)}, ${data.runs} run${data.runs !== 1 ? "s" : ""}`}
                />
              </div>
              <div className="analytics-label">{day.slice(5)}</div>
            </div>
          ))}
        </div>
      )}
      {days.length === 0 && <p className="muted">Run tasks that report cost to see the chart.</p>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const EXEC_MODES = ["observe", "propose", "approval_required", "scoped_autonomy"];

export default function Page() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [trustMap, setTrustMap] = useState<Map<string, TrustData>>(new Map());
  const [backupAttestations, setBackupAttestations] = useState<BackupAttestation[]>([]);
  const [message, setMessage] = useState("");
  const [activeTab, setActiveTab] = useState<"board" | "org" | "analytics">("board");
  const [dbApprovalAcks, setDbApprovalAcks] = useState<Record<string, boolean>>({});

  const [agentForm, setAgentForm] = useState({
    name: "Mock Operator",
    role: "Proposal Worker",
    adapterType: "http",
    endpoint: "http://localhost:4200/task",
    executionMode: "approval_required",
    budgetLimitUsd: "1",
    model: "",
    temperature: "",
    maxTokens: "",
    reportsTo: "",
    webhookUrl: "",
    databaseAccess: "none",
    allowRawSql: false,
    allowSchemaChanges: false,
    allowBackupRestore: false,
    requireFreshBackupBeforeDestructive: true,
    maxBackupAgeMinutes: "60",
    requireOperatorAcknowledgement: true
  });

  const [taskForm, setTaskForm] = useState({
    title: "Review OperatorBoard README direction",
    description: "Propose the first README structure for the open-source release.",
    assignedAgentId: "",
    scheduledAt: "",
    onCompleteTitle: "",
    onCompleteDescription: "",
    onCompleteAgentId: ""
  });

  const [backupForm, setBackupForm] = useState({
    system: "postgres-prod",
    scope: "customers",
    reference: "backup_2025_04_27",
    verifiedAt: new Date().toISOString().slice(0, 16),
    source: "manual"
  });

  const pendingApprovals = useMemo(() => approvals.filter((a) => a.status === "pending"), [approvals]);
  const latestTask = useMemo(() => tasks[0], [tasks]);

  async function refresh() {
    const [nextAgents, nextTasks, nextApprovals, nextAudit, nextAnalytics, nextBackupAttestations] = await Promise.all([
      api<Agent[]>("/agents"),
      api<Task[]>("/tasks"),
      api<Approval[]>("/approvals"),
      api<AuditEvent[]>("/audit"),
      api<Analytics>("/analytics"),
      api<BackupAttestation[]>("/backup-attestations")
    ]);

    setAgents(nextAgents);
    setTasks([...nextTasks].reverse());
    setApprovals([...nextApprovals].reverse());
    setAudit([...nextAudit].reverse());
    setAnalytics(nextAnalytics);
    setBackupAttestations([...nextBackupAttestations].sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt)));

    if (!taskForm.assignedAgentId && nextAgents[0]) {
      setTaskForm((f) => ({ ...f, assignedAgentId: nextAgents[0]?.id ?? "" }));
    }

    // Fetch trust for all agents in parallel
    const trustEntries = await Promise.all(
      nextAgents.map((a) =>
        api<TrustData>(`/agents/${a.id}/trust`).then((t) => [a.id, t] as [string, TrustData]).catch(() => null)
      )
    );
    const nextTrust = new Map<string, TrustData>();
    for (const entry of trustEntries) {
      if (entry) nextTrust.set(entry[0], entry[1]);
    }
    setTrustMap(nextTrust);
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);

  async function createAgent() {
    setMessage("");
    await api<Agent>("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: agentForm.name,
        role: agentForm.role,
        adapterType: agentForm.adapterType,
        endpoint: agentForm.endpoint,
        executionMode: agentForm.executionMode,
        budgetLimitUsd: Number(agentForm.budgetLimitUsd) || undefined,
        model: agentForm.model || undefined,
        temperature: agentForm.temperature ? Number(agentForm.temperature) : undefined,
        maxTokens: agentForm.maxTokens ? Number(agentForm.maxTokens) : undefined,
        reportsTo: agentForm.reportsTo || undefined,
        webhookUrl: agentForm.webhookUrl || undefined,
        databasePolicy: {
          access: agentForm.databaseAccess,
          allowRawSql: agentForm.allowRawSql,
          allowSchemaChanges: agentForm.allowSchemaChanges,
          allowBackupRestore: agentForm.allowBackupRestore,
          backupPolicy: {
            requireFreshBackupBeforeDestructive: agentForm.requireFreshBackupBeforeDestructive,
            maxBackupAgeMinutes: Number(agentForm.maxBackupAgeMinutes) || 60,
            requireOperatorAcknowledgement: agentForm.requireOperatorAcknowledgement
          }
        }
      })
    });
    setMessage("Agent created.");
    await refresh();
  }

  async function createTask() {
    setMessage("");
    await api<Task>("/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: taskForm.title,
        description: taskForm.description,
        assignedAgentId: taskForm.assignedAgentId || undefined,
        scheduledAt: taskForm.scheduledAt || undefined,
        onCompleteTitle: taskForm.onCompleteTitle || undefined,
        onCompleteDescription: taskForm.onCompleteDescription || undefined,
        onCompleteAgentId: taskForm.onCompleteAgentId || undefined
      })
    });
    setMessage(taskForm.scheduledAt ? "Task scheduled." : "Task created.");
    await refresh();
  }

  async function runTask(taskId: string) {
    setMessage("");
    try {
      await api<Task>(`/tasks/${taskId}/run`, { method: "POST" });
      setMessage("Task run completed.");
    } catch (e) {
      setMessage(`Run failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await refresh();
  }

  async function testAgent(agentId: string) {
    setMessage("");
    const result = await api<{ ok: boolean; statusCode?: number; error?: string }>(`/agents/${agentId}/test`, { method: "POST" });
    const errorDetail = result.error ?? (result.statusCode ? `status ${result.statusCode}` : "unknown error");
    setMessage(result.ok ? `Agent healthy (${result.statusCode})` : `Agent unreachable: ${errorDetail}`);
    await refresh();
  }

  async function suspendAgent(agentId: string) {
    setMessage("");
    const r = await api<{ agent: Agent; pausedTasks: number }>(`/agents/${agentId}/suspend`, { method: "POST" });
    setMessage(`Agent suspended. ${r.pausedTasks} task${r.pausedTasks !== 1 ? "s" : ""} paused.`);
    await refresh();
  }

  async function resumeAgent(agentId: string) {
    setMessage("");
    await api<Agent>(`/agents/${agentId}/resume`, { method: "POST" });
    setMessage("Agent resumed.");
    await refresh();
  }

  async function decideApproval(approvalId: string, decision: "approve" | "deny", action?: Action, agent?: Agent) {
    setMessage("");
    const dbReview = getDbReview(action);
    const needsAck = decision === "approve"
      && dbReview?.destructive
      && agent?.databasePolicy?.backupPolicy.requireOperatorAcknowledgement;
    await api<Approval>(`/approvals/${approvalId}/${decision}`, {
      method: "POST",
      body: JSON.stringify(needsAck ? { acknowledgeRisk: !!dbApprovalAcks[approvalId] } : {})
    });
    setMessage(`Approval ${decision}d.`);
    await refresh();
  }

  async function resetDemoData() {
    if (!DEV_TOOLS_ENABLED) return;
    setMessage("");
    await api<{ ok: boolean }>("/dev/reset", { method: "POST" });
    setMessage("Demo data reset.");
    await refresh();
  }

  async function createBackupAttestation() {
    setMessage("");
    await api<BackupAttestation>("/backup-attestations", {
      method: "POST",
      body: JSON.stringify({
        system: backupForm.system,
        scope: backupForm.scope,
        reference: backupForm.reference,
        verifiedAt: new Date(backupForm.verifiedAt).toISOString(),
        source: backupForm.source
      })
    });
    setMessage("Backup attestation recorded.");
    await refresh();
  }

  const af = agentForm;
  const tf = taskForm;

  return (
    <main className="page">
      <header className="header">
        <div>
          <div className="eyebrow">OperatorBoard v0.1</div>
          <h1>Human-governed agent control plane</h1>
          <p className="subtitle">
            Run agents like a company. Audit them like infrastructure.
          </p>
        </div>
        <div className="card" style={{ minWidth: 260 }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <span className="badge good">API 4100</span>
            {API_KEY ? <span className="badge good">Auth on</span> : <span className="badge bad">No auth key</span>}
            {pendingApprovals.length > 0 && (
              <span className="badge warn">{pendingApprovals.length} pending</span>
            )}
            <button className="secondary" onClick={() => void refresh()}>Refresh</button>
            {DEV_TOOLS_ENABLED && (
              <button className="danger" onClick={() => void resetDemoData()}>Reset</button>
            )}
          </div>
          {message ? <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>{message}</p> : null}
        </div>
      </header>

      {/* Tab nav */}
      <div className="tab-nav">
        {(["board", "org", "analytics"] as const).map((tab) => (
          <button key={tab} className={`tab-btn ${activeTab === tab ? "active" : ""}`} onClick={() => setActiveTab(tab)}>
            {tab === "board" ? "Board" : tab === "org" ? "Org Chart" : "Analytics"}
            {tab === "board" && pendingApprovals.length > 0 && (
              <span className="tab-badge">{pendingApprovals.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Board tab ── */}
      {activeTab === "board" && (
        <section className="grid">
          {/* Create Agent */}
          <div className="card">
            <h2>Create Agent</h2>
            <div className="form">
              <div className="row">
                <label style={{ flex: 2 }}>Name<input value={af.name} onChange={(e) => setAgentForm({ ...af, name: e.target.value })} /></label>
                <label style={{ flex: 2 }}>Role<input value={af.role} onChange={(e) => setAgentForm({ ...af, role: e.target.value })} /></label>
              </div>
              <label>Endpoint<input value={af.endpoint} onChange={(e) => setAgentForm({ ...af, endpoint: e.target.value })} /></label>
              <div className="row">
                <label style={{ flex: 1 }}>
                  Mode
                  <select value={af.executionMode} onChange={(e) => setAgentForm({ ...af, executionMode: e.target.value })}>
                    {EXEC_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <label style={{ width: 120 }}>Budget ($)<input value={af.budgetLimitUsd} onChange={(e) => setAgentForm({ ...af, budgetLimitUsd: e.target.value })} /></label>
              </div>
              <div className="row">
                <label style={{ flex: 2 }}>Model<input placeholder="e.g. claude-sonnet-4-6" value={af.model} onChange={(e) => setAgentForm({ ...af, model: e.target.value })} /></label>
                <label style={{ flex: 1 }}>Temp (0–2)<input type="number" min="0" max="2" step="0.1" value={af.temperature} onChange={(e) => setAgentForm({ ...af, temperature: e.target.value })} /></label>
                <label style={{ flex: 1 }}>Max Tokens<input type="number" value={af.maxTokens} onChange={(e) => setAgentForm({ ...af, maxTokens: e.target.value })} /></label>
              </div>
              <label>
                Reports To
                <select value={af.reportsTo} onChange={(e) => setAgentForm({ ...af, reportsTo: e.target.value })}>
                  <option value="">None (top-level)</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
                </select>
              </label>
              <details style={{ marginTop: 4 }}>
                <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Database governance →</summary>
                <div className="form" style={{ marginTop: 8, paddingLeft: 8, borderLeft: "2px solid var(--border)" }}>
                  <label>
                    Database Access
                    <select value={af.databaseAccess} onChange={(e) => setAgentForm({ ...af, databaseAccess: e.target.value })}>
                      <option value="none">None</option>
                      <option value="read_only">Read only</option>
                      <option value="write_safe">Write safe</option>
                      <option value="write_destructive">Write destructive</option>
                    </select>
                  </label>
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    Destructive DB access should be rare. It enables delete, schema, restore, or raw execution workflows only with backup evidence and human acknowledgement.
                  </p>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={af.allowRawSql} onChange={(e) => setAgentForm({ ...af, allowRawSql: e.target.checked })} />
                    <span>Allow raw SQL execution</span>
                  </label>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={af.allowSchemaChanges} onChange={(e) => setAgentForm({ ...af, allowSchemaChanges: e.target.checked })} />
                    <span>Allow schema changes</span>
                  </label>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={af.allowBackupRestore} onChange={(e) => setAgentForm({ ...af, allowBackupRestore: e.target.checked })} />
                    <span>Allow backup restore</span>
                  </label>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={af.requireFreshBackupBeforeDestructive} onChange={(e) => setAgentForm({ ...af, requireFreshBackupBeforeDestructive: e.target.checked })} />
                    <span>Require recent backup before destructive approval</span>
                  </label>
                  <label>
                    Max Backup Age (minutes)
                    <input type="number" min="1" value={af.maxBackupAgeMinutes} onChange={(e) => setAgentForm({ ...af, maxBackupAgeMinutes: e.target.value })} />
                  </label>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={af.requireOperatorAcknowledgement} onChange={(e) => setAgentForm({ ...af, requireOperatorAcknowledgement: e.target.checked })} />
                    <span>Require explicit operator acknowledgement for destructive DB approvals</span>
                  </label>
                </div>
              </details>
              <label>Webhook URL<input placeholder="https://… or ntfy.sh/your-topic" value={af.webhookUrl} onChange={(e) => setAgentForm({ ...af, webhookUrl: e.target.value })} /></label>
              <button className="primary" onClick={() => void createAgent()}>Create Agent</button>
            </div>
          </div>

          {/* Create Task */}
          <div className="card">
            <h2>Create Task</h2>
            <div className="form">
              <label>Title<input value={tf.title} onChange={(e) => setTaskForm({ ...tf, title: e.target.value })} /></label>
              <label>Description<textarea value={tf.description} onChange={(e) => setTaskForm({ ...tf, description: e.target.value })} /></label>
              <div className="row">
                <label style={{ flex: 2 }}>
                  Assign Agent
                  <select value={tf.assignedAgentId} onChange={(e) => setTaskForm({ ...tf, assignedAgentId: e.target.value })}>
                    <option value="">Unassigned</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.status}</option>)}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  Schedule At
                  <input type="datetime-local" value={tf.scheduledAt} onChange={(e) => setTaskForm({ ...tf, scheduledAt: e.target.value })} />
                </label>
              </div>
              <details style={{ marginTop: 4 }}>
                <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Pipeline: on complete, create →</summary>
                <div className="form" style={{ marginTop: 8, paddingLeft: 8, borderLeft: "2px solid var(--border)" }}>
                  <label>Next Task Title<input placeholder="Leave blank to skip" value={tf.onCompleteTitle} onChange={(e) => setTaskForm({ ...tf, onCompleteTitle: e.target.value })} /></label>
                  <label>Next Task Description<textarea value={tf.onCompleteDescription} onChange={(e) => setTaskForm({ ...tf, onCompleteDescription: e.target.value })} /></label>
                  <label>
                    Assign To
                    <select value={tf.onCompleteAgentId} onChange={(e) => setTaskForm({ ...tf, onCompleteAgentId: e.target.value })}>
                      <option value="">Same or unassigned</option>
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </label>
                </div>
              </details>
              <button className="primary" onClick={() => void createTask()}>
                {tf.scheduledAt ? "Schedule Task" : "Create Task"}
              </button>
            </div>
          </div>

          <div className="card">
            <h2>Backup Attestations</h2>
            <div className="form">
              <div className="row">
                <label style={{ flex: 1 }}>System<input value={backupForm.system} onChange={(e) => setBackupForm({ ...backupForm, system: e.target.value })} /></label>
                <label style={{ flex: 1 }}>Scope<input value={backupForm.scope} onChange={(e) => setBackupForm({ ...backupForm, scope: e.target.value })} /></label>
              </div>
              <label>Reference<input value={backupForm.reference} onChange={(e) => setBackupForm({ ...backupForm, reference: e.target.value })} /></label>
              <div className="row">
                <label style={{ flex: 1 }}>Verified At<input type="datetime-local" value={backupForm.verifiedAt} onChange={(e) => setBackupForm({ ...backupForm, verifiedAt: e.target.value })} /></label>
                <label style={{ width: 140 }}>
                  Source
                  <select value={backupForm.source} onChange={(e) => setBackupForm({ ...backupForm, source: e.target.value })}>
                    <option value="manual">manual</option>
                    <option value="integration">integration</option>
                  </select>
                </label>
              </div>
              <button className="primary" onClick={() => void createBackupAttestation()}>Record Attestation</button>
            </div>
            <div className="stack" style={{ marginTop: 14 }}>
              {backupAttestations.length === 0 && <p className="muted">No attestations yet.</p>}
              {backupAttestations.slice(0, 5).map((item) => (
                <div className="item" key={item.id}>
                  <div className="item-title">{item.reference}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{item.system} · {item.scope} · {item.source}</div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <span className="badge good">verified</span>
                    <span className="badge">{new Date(item.verifiedAt).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Agents */}
          <div className="card">
            <h2>Agents</h2>
            <div className="stack">
              {agents.length === 0 && <p className="muted">No agents yet.</p>}
              {agents.map((agent) => {
                const trust = trustMap.get(agent.id);
                return (
                  <div className="item" key={agent.id}>
                    <div className="item-title">{agent.name}</div>
                    <div className="muted">{agent.role}{agent.model ? ` · ${agent.model}` : ""}</div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <span className={`badge ${statusClass(agent.status)}`}>{agent.status}</span>
                      {agent.suspendedAt && <span className="badge bad">suspended</span>}
                      <span className="badge">{agent.executionMode}</span>
                      <span className={`badge ${agent.databasePolicy?.access === "write_destructive" ? "bad" : agent.databasePolicy?.access === "write_safe" ? "warn" : ""}`}>
                        db:{agent.databasePolicy?.access ?? "none"}
                      </span>
                      <button className="secondary" onClick={() => void testAgent(agent.id)}>Test</button>
                      {agent.suspendedAt
                        ? <button className="secondary" onClick={() => void resumeAgent(agent.id)}>Resume</button>
                        : <button className="danger" onClick={() => void suspendAgent(agent.id)}>Suspend</button>}
                    </div>
                    {agent.budgetLimitUsd !== undefined && (
                      <BudgetBar spent={agent.spentUsdTotal ?? 0} limit={agent.budgetLimitUsd} />
                    )}
                    {trust && <TrustMeter data={trust} />}
                    <p className="muted" style={{ marginTop: 6, fontSize: 11 }}>{agent.endpoint}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tasks */}
          <div className="card">
            <h2>Tasks</h2>
            <div className="stack">
              {tasks.length === 0 && <p className="muted">No tasks yet.</p>}
              {tasks.map((task) => (
                <div className="item" key={task.id}>
                  <div className="item-title">{task.title}</div>
                  <p className="muted" style={{ margin: "2px 0 6px" }}>{task.description}</p>
                  <div className="row">
                    <span className={`badge ${statusClass(task.status)}`}>{task.status}</span>
                    {task.assignedAgentId ? <span className="badge">assigned</span> : <span className="badge bad">unassigned</span>}
                    {task.scheduledAt && <span className="badge warn">⏰ {new Date(task.scheduledAt).toLocaleString()}</span>}
                    {task.onComplete && <span className="badge">→ pipeline</span>}
                    {task.lastResponse?.costUsd !== undefined && (
                      <span className="badge">${task.lastResponse.costUsd.toFixed(4)}</span>
                    )}
                    {task.assignedAgentId && !["running", "scheduled"].includes(task.status) ? (
                      <button className="secondary" onClick={() => void runTask(task.id)}>Run</button>
                    ) : !task.assignedAgentId && agents.length > 0 ? (
                      <button className="secondary" onClick={() => {
                        const first = agents[0]; if (!first) return;
                        void api<Task>(`/tasks/${task.id}/assign/${first.id}`, { method: "POST" }).then(() => refresh());
                      }}>Assign</button>
                    ) : null}
                  </div>
                  {task.lastResponse && (
                    <details style={{ marginTop: 8 }}>
                      <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>Last response</summary>
                      <pre style={{ marginTop: 6 }}>{JSON.stringify(task.lastResponse, null, 2)}</pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Approvals */}
          <div className="card">
            <h2>
              Approvals
              {pendingApprovals.length > 0 && <span className="badge warn" style={{ marginLeft: 8 }}>{pendingApprovals.length} pending</span>}
            </h2>
            <div className="stack">
              {approvals.length === 0 && <p className="muted">No approvals yet.</p>}
              {approvals.map((approval) => {
                const task = tasks.find((t) => t.id === approval.taskId);
                const action = task?.lastResponse?.actions.find((a) => a.id === approval.actionId);
                const agent = task?.assignedAgentId ? agents.find((item) => item.id === task.assignedAgentId) : undefined;
                const dbReview = getDbReview(action);
                const attestation = dbReview?.backupReference
                  ? backupAttestations.find((item) => item.reference === dbReview.backupReference)
                  : undefined;
                const backupPolicy = agent?.databasePolicy?.backupPolicy;
                return (
                  <div className="item approval-item" key={approval.id}>
                    {task && <div className="item-title">{task.title}</div>}
                    {action && (
                      <>
                        <div className="row" style={{ marginTop: 4 }}>
                          <span className={`badge ${action.risk === "critical" || action.risk === "high" ? "bad" : action.risk === "medium" ? "warn" : ""}`}>
                            {action.risk}
                          </span>
                          <span className="badge">{action.type}</span>
                        </div>
                        <p className="muted" style={{ margin: "6px 0" }}>{action.summary}</p>
                        {dbReview && (
                          <div className={`risk-panel ${dbReview.destructive ? "danger" : "info"}`}>
                            <strong>{dbReview.destructive ? "Database destructive action" : "Database action"}</strong>
                            <p style={{ margin: "6px 0 0" }}>{dbReview.plainLanguage}</p>
                            <div className="risk-meta">
                              {typeof dbReview.estimatedAffectedRows === "number" && <span>Estimated rows: {dbReview.estimatedAffectedRows.toLocaleString()}</span>}
                              {attestation
                                ? <span>Attested backup verified: {new Date(attestation.verifiedAt).toLocaleString()}</span>
                                : <span className="bad-text">No OperatorBoard attestation found for this backup reference</span>}
                              {dbReview.backupReference && <span>Backup ref: {dbReview.backupReference}</span>}
                              {backupPolicy?.requireFreshBackupBeforeDestructive && dbReview.destructive && (
                                <span>Fresh backup required within {backupPolicy.maxBackupAgeMinutes} minutes</span>
                              )}
                            </div>
                            {dbReview.destructive && (
                              <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                                Plain English: your database can be permanently changed or destroyed by this action.
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}
                    {!action && <div className="muted">Action: {approval.actionId}</div>}
                    <div className="row" style={{ marginTop: 8 }}>
                      <span className={`badge ${statusClass(approval.status)}`}>{approval.status}</span>
                      {approval.status === "pending" && (
                        <>
                          {dbReview?.destructive && backupPolicy?.requireOperatorAcknowledgement && (
                            <label className="checkbox-row ack-row">
                              <input
                                type="checkbox"
                                checked={!!dbApprovalAcks[approval.id]}
                                onChange={(e) => setDbApprovalAcks((current) => ({ ...current, [approval.id]: e.target.checked }))}
                              />
                              <span>I understand this can permanently destroy or overwrite database data.</span>
                            </label>
                          )}
                          <button className="approve-btn" onClick={() => void decideApproval(approval.id, "approve", action, agent)}>✓ Approve</button>
                          <button className="deny-btn" onClick={() => void decideApproval(approval.id, "deny", action, agent)}>✕ Deny</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Latest response */}
          <div className="card">
            <h2>Latest Task Response</h2>
            {latestTask?.lastResponse
              ? <pre>{JSON.stringify(latestTask.lastResponse, null, 2)}</pre>
              : <p className="muted">Run a task to see agent output.</p>}
          </div>

          {/* Audit trail */}
          <div className="card full">
            <h2>Audit Trail</h2>
            <div className="stack">
              {audit.length === 0 && <p className="muted">No audit events yet.</p>}
              {audit.slice(0, 15).map((event) => (
                <div className={`item ${isAlert(event.eventType) ? "item-alert" : ""}`} key={event.id}>
                  <div className="row">
                    <span className={`badge ${isAlert(event.eventType) ? "bad" : ""}`}>{event.actorType}</span>
                    <span className={`badge ${isAlert(event.eventType) ? "bad" : ""}`}>{event.eventType}</span>
                    <span className="badge">{event.targetType}</span>
                    <span className="muted">{new Date(event.createdAt).toLocaleString()}</span>
                  </div>
                  <details style={{ marginTop: 6 }}>
                    <summary className="muted" style={{ cursor: "pointer", fontSize: 11 }}>payload</summary>
                    <pre style={{ marginTop: 4 }}>{JSON.stringify(event.payload, null, 2)}</pre>
                  </details>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Org chart tab ── */}
      {activeTab === "org" && (
        <section>
          <OrgChart agents={agents} onSuspend={(id) => void suspendAgent(id)} onResume={(id) => void resumeAgent(id)} trustMap={trustMap} />
          {agents.length === 0 && <div className="card full"><p className="muted">No agents yet. Create some on the Board tab.</p></div>}
        </section>
      )}

      {/* ── Analytics tab ── */}
      {activeTab === "analytics" && (
        <section>
          <CostAnalytics analytics={analytics} />
        </section>
      )}
    </main>
  );
}
