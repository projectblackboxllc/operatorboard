import Fastify, { type FastifyBaseLogger } from "fastify";
import cors from "@fastify/cors";
import { createHmac as nodeCreateHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z, ZodError } from "zod";
import {
  backupAttestationSchema,
  databaseConstraintsSchema,
  executionModeSchema,
  heartbeatSchema,
  taskRequestSchema,
  taskResponseSchema,
  type AgentConstraints,
  type BackupAttestation,
  type DatabaseAccessLevel,
  type DatabaseConstraints,
  type ExecutionMode,
  type Heartbeat,
  type PipelineTask,
  type ProposedAction,
  type TaskResponse
} from "@operatorboard/shared";
import { deleteAllRecords, deleteApprovalsForTask, loadRecords, saveRecord } from "./db.js";

type Agent = {
  id: string;
  name: string;
  role: string;
  adapterType: string;
  endpoint: string;
  executionMode: ExecutionMode;
  status: "online" | "busy" | "idle" | "offline" | "error";
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reportsTo?: string;
  webhookUrl?: string;
  budgetLimitUsd?: number;
  spentUsdTotal?: number;
  suspendedAt?: string;
  databasePolicy?: DatabaseConstraints;
  createdAt: string;
};

type Task = {
  id: string;
  title: string;
  description: string;
  status:
    | "queued" | "assigned" | "running" | "proposal_ready"
    | "approval_required" | "approved" | "denied"
    | "completed" | "failed" | "paused" | "scheduled";
  assignedAgentId?: string;
  onComplete?: { createTask: PipelineTask };
  scheduledAt?: string;
  createdAt: string;
  updatedAt: string;
  lastResponse?: TaskResponse;
};

type Approval = {
  id: string;
  taskId: string;
  actionId: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  reviewedAt?: string;
};

type AuditEvent = {
  id: string;
  eventType: string;
  actorType: "operator" | "agent" | "system";
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type BuildAppOptions = {
  fetchImpl?: typeof fetch;
  logger?: boolean | FastifyBaseLogger;
  schedulerIntervalMs?: number;
  startScheduler?: boolean;
};

const INTEGRATION_SIGNATURE_TTL_MS = 5 * 60 * 1000;

// ── Webhook SSRF guard ────────────────────────────────────────────────────────

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,   // link-local / cloud metadata
  /^fc00:/i,       // IPv6 ULA
  /^fe80:/i,       // IPv6 link-local
  /^::1$/,         // IPv6 loopback
  /^0\./,          // 0.0.0.0/8
];

function isSafeWebhookUrl(rawUrl: string): { ok: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Webhook URL is not a valid URL" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, reason: `Webhook URL scheme "${parsed.protocol}" is not allowed` };
  }
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, ""); // strip IPv6 brackets
  if (hostname === "localhost") {
    return { ok: false, reason: "Webhook URL must not target localhost" };
  }
  for (const range of PRIVATE_IP_RANGES) {
    if (range.test(hostname)) {
      return { ok: false, reason: `Webhook URL hostname "${hostname}" resolves to a private or reserved range` };
    }
  }
  return { ok: true };
}

// ── Replay-nonce store for integration signatures ─────────────────────────────

type UsedNonce = { expiresAt: number };
const usedIntegrationNonces = new Map<string, UsedNonce>();

function consumeIntegrationNonce(provider: string, timestamp: string, signature: string): boolean {
  const key = `${provider}:${timestamp}:${signature}`;
  if (usedIntegrationNonces.has(key)) return false; // already used
  usedIntegrationNonces.set(key, { expiresAt: Date.now() + INTEGRATION_SIGNATURE_TTL_MS });
  // Prune expired entries lazily
  for (const [k, v] of usedIntegrationNonces) {
    if (v.expiresAt < Date.now()) usedIntegrationNonces.delete(k);
  }
  return true;
}

const createAgentSchema = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  adapterType: z.string().trim().min(1),
  endpoint: z.string().url(),
  executionMode: executionModeSchema,
  model: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  reportsTo: z.string().trim().min(1).optional(),
  webhookUrl: z.string().url().optional(),
  budgetLimitUsd: z.number().nonnegative().optional(),
  databasePolicy: databaseConstraintsSchema.optional()
});

const createTaskSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  assignedAgentId: z.string().trim().min(1).optional(),
  scheduledAt: z.string().trim().min(1).optional(),
  onCompleteTitle: z.string().trim().min(1).optional(),
  onCompleteDescription: z.string().trim().min(1).optional(),
  onCompleteAgentId: z.string().trim().min(1).optional()
});

const scheduleTaskSchema = z.object({
  scheduledAt: z.string().trim().min(1)
});

const approvalDecisionSchema = z.object({
  acknowledgeRisk: z.boolean().optional()
});

const createBackupAttestationSchema = z.object({
  system: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  verifiedAt: z.string().datetime(),
  source: z.enum(["manual", "integration"]).default("manual"),
  metadata: z.record(z.unknown()).default({})
});

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clone(o: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
}

function normalizeScheduledAt(value: string): string | null {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function extractPathStrings(payload: Record<string, unknown>): string[] {
  const paths: string[] = [];
  function walk(val: unknown) {
    if (typeof val === "string" && (val.startsWith("/") || val.startsWith("./") || val.startsWith("../"))) {
      paths.push(val);
      return;
    }
    if (Array.isArray(val)) {
      val.forEach(walk);
      return;
    }
    if (val !== null && typeof val === "object") {
      Object.values(val as Record<string, unknown>).forEach(walk);
    }
  }
  walk(payload);
  return paths;
}

function extractCommandStrings(payload: Record<string, unknown>): string[] {
  const commands: string[] = [];
  function walk(key: string | null, val: unknown) {
    if (typeof val === "string") {
      if (key && ["command", "cmd", "sql", "query", "statement"].includes(key)) commands.push(val);
      return;
    }
    if (Array.isArray(val)) {
      val.forEach((item) => walk(key, item));
      return;
    }
    if (val !== null && typeof val === "object") {
      for (const [childKey, childValue] of Object.entries(val as Record<string, unknown>)) {
        walk(childKey, childValue);
      }
    }
  }
  walk(null, payload);
  return commands;
}

type DatabaseActionReview = {
  capability: "general" | "database";
  requiredAccess?: DatabaseAccessLevel;
  destructive: boolean;
  directShellBypass: boolean;
  plainLanguage?: string;
  estimatedAffectedRows?: number;
  backupReference?: string;
};

type BackupEvidenceResult = {
  ok: boolean;
  attestation?: BackupAttestation;
  reason?: string;
};

function classifyDatabaseAction(action: ProposedAction): DatabaseActionReview {
  const safety = action.safety ?? { capability: "general", destructive: false };
  const fallback: DatabaseActionReview = {
    capability: safety.capability,
    destructive: safety.destructive,
    plainLanguage: safety.plainLanguage,
    estimatedAffectedRows: safety.estimatedAffectedRows,
    backupReference: safety.backupReference,
    directShellBypass: false
  };

  const normalizedType = action.type.toLowerCase();
  const commands = extractCommandStrings(action.payload).join("\n").toLowerCase();
  const shellDbRegex = /\b(psql|mysql|sqlite3|mongo|mongosh|sqlcmd)\b/;
  const destructiveSqlRegex = /\b(drop|truncate|delete\s+from|alter\s+table|restore)\b/;

  if (["shell.exec", "shell.run", "command.exec", "command.run"].some((prefix) => normalizedType.includes(prefix))
    && (shellDbRegex.test(commands) || destructiveSqlRegex.test(commands))) {
    return {
      ...fallback,
      capability: "database",
      requiredAccess: "write_destructive",
      destructive: true,
      directShellBypass: true,
      plainLanguage: fallback.plainLanguage ?? "Run direct database shell commands outside structured database controls."
    };
  }

  if (!normalizedType.startsWith("db.")) return fallback;

  const plainLanguage = fallback.plainLanguage ?? (
    normalizedType.startsWith("db.query.read") ? "Read data from a database." :
      normalizedType.startsWith("db.row.insert") ? "Insert new rows into a database." :
        normalizedType.startsWith("db.row.update") ? "Update existing database records." :
          normalizedType.startsWith("db.row.delete") ? "Delete database records permanently." :
            normalizedType.startsWith("db.schema.alter") ? "Change a database schema." :
              normalizedType.startsWith("db.backup.create") ? "Create a database backup." :
                normalizedType.startsWith("db.backup.restore") ? "Restore a database backup and overwrite live data." :
                  normalizedType.startsWith("db.query.execute") ? "Execute raw SQL against a database." :
                    "Perform a database action."
  );

  if (normalizedType.startsWith("db.query.read")) {
    return { ...fallback, capability: "database", requiredAccess: "read_only", directShellBypass: false, plainLanguage, destructive: false };
  }
  if (normalizedType.startsWith("db.row.insert") || normalizedType.startsWith("db.row.update") || normalizedType.startsWith("db.backup.create")) {
    return { ...fallback, capability: "database", requiredAccess: "write_safe", directShellBypass: false, plainLanguage, destructive: fallback.destructive };
  }
  return {
    ...fallback,
    capability: "database",
    requiredAccess: "write_destructive",
    destructive: true,
    directShellBypass: false,
    plainLanguage
  };
}

function hasSufficientDatabaseAccess(required: DatabaseAccessLevel, granted: DatabaseAccessLevel) {
  const rank: Record<DatabaseAccessLevel, number> = {
    none: 0,
    read_only: 1,
    write_safe: 2,
    write_destructive: 3
  };
  return rank[granted] >= rank[required];
}

function minutesSince(timestamp: string) {
  return (Date.now() - Date.parse(timestamp)) / 60_000;
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalStringify(val)}`).join(",")}}`;
}

function timingSafeEqualString(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return nodeTimingSafeEqual(left, right);
}

function getBackupIntegrationSecrets() {
  const raw = process.env.OPERATORBOARD_BACKUP_INTEGRATION_SECRETS;
  if (!raw) return {} as Record<string, string>;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "string" && value.length > 0)
    );
  } catch {
    return {} as Record<string, string>;
  }
}

// Action-type prefixes that require specific permissions.
// All checks use normalizedType (lowercased) to prevent case-bypass attacks.
const FILE_WRITE_PREFIXES = ["file.write", "file.delete", "file.move", "file.create", "file.rename", "file.chmod"];
const SHELL_PREFIXES = ["shell.", "command."];
const NETWORK_PREFIXES = ["http.", "https.", "network.", "fetch.", "request.", "web.", "api.call", "socket.", "dns.", "ftp."];

function enforceConstraints(action: ProposedAction, constraints: AgentConstraints): { allowed: boolean; reason?: string } {
  const normalizedType = action.type.toLowerCase();
  const dbReview = classifyDatabaseAction(action);

  for (const p of extractPathStrings(action.payload)) {
    for (const denied of constraints.deniedPaths) {
      if (p.startsWith(denied)) return { allowed: false, reason: `Path "${p}" matches denied "${denied}"` };
    }
    if (constraints.allowedPaths.length > 0 && !constraints.allowedPaths.some((allowed) => p.startsWith(allowed))) {
      return { allowed: false, reason: `Path "${p}" not in allowedPaths` };
    }
  }

  if (!constraints.allowFileWrite && FILE_WRITE_PREFIXES.some((t) => normalizedType.startsWith(t))) {
    return { allowed: false, reason: `Action type "${action.type}" requires allowFileWrite` };
  }

  if (!constraints.allowShell && SHELL_PREFIXES.some((t) => normalizedType.startsWith(t))) {
    return { allowed: false, reason: `Action type "${action.type}" requires allowShell` };
  }

  if (!constraints.allowNetwork && NETWORK_PREFIXES.some((t) => normalizedType.startsWith(t))) {
    return { allowed: false, reason: `Action type "${action.type}" requires allowNetwork` };
  }

  if (dbReview.capability === "database" && dbReview.requiredAccess) {
    const policy = constraints.database;
    if (dbReview.directShellBypass) {
      return { allowed: false, reason: "Direct database shell access is not allowed; use structured db.* actions instead" };
    }
    if (!hasSufficientDatabaseAccess(dbReview.requiredAccess, policy.access)) {
      return { allowed: false, reason: `Database access "${policy.access}" cannot perform "${dbReview.requiredAccess}" actions` };
    }
    // Use normalizedType for all db sub-checks to prevent case bypasses
    if (normalizedType.startsWith("db.query.execute") && !policy.allowRawSql) {
      return { allowed: false, reason: "Raw SQL execution is disabled for this agent" };
    }
    if (normalizedType.startsWith("db.schema.alter") && !policy.allowSchemaChanges) {
      return { allowed: false, reason: "Schema changes are disabled for this agent" };
    }
    if (normalizedType.startsWith("db.backup.restore") && !policy.allowBackupRestore) {
      return { allowed: false, reason: "Backup restore is disabled for this agent" };
    }
  }
  return { allowed: true };
}

function resolveCorsOrigin() {
  const configured = process.env.OPERATORBOARD_CORS_ORIGINS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured && configured.length > 0) return configured;
  return process.env.NODE_ENV !== "production";
}

function createPipelineTask(next: PipelineTask): Task {
  const createdAt = now();
  return {
    id: id("task"),
    title: next.title,
    description: next.description,
    status: next.assignedAgentId ? "assigned" : "queued",
    assignedAgentId: next.assignedAgentId,
    createdAt,
    updatedAt: createdAt
  };
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  await app.register(cors, { origin: resolveCorsOrigin() });

  const fetchImpl = options.fetchImpl ?? fetch;
  const TASK_RUN_TIMEOUT_MS = Number(process.env.OPERATORBOARD_TASK_TIMEOUT_MS ?? 60_000);
  const API_KEY = process.env.OPERATORBOARD_API_KEY;
  const ENABLE_DEV_ROUTES = process.env.OPERATORBOARD_ENABLE_DEV_ROUTES === "true";
  const SCHEDULER_INTERVAL_MS = options.schedulerIntervalMs ?? 30_000;
  const BACKUP_INTEGRATION_SECRETS = getBackupIntegrationSecrets();

  const agents = new Map<string, Agent>(loadRecords<Agent>("agents").map((a) => [a.id, a]));
  const tasks = new Map<string, Task>(loadRecords<Task>("tasks").map((t) => [t.id, t]));
  const approvals = new Map<string, Approval>(loadRecords<Approval>("approvals").map((a) => [a.id, a]));
  const heartbeats: Heartbeat[] = loadRecords<Heartbeat>("heartbeats");
  const auditEvents: AuditEvent[] = loadRecords<AuditEvent>("audit_events");
  const backupAttestations = new Map<string, BackupAttestation>(
    loadRecords<BackupAttestation>("backup_attestations").map((item) => [item.id, backupAttestationSchema.parse(item)])
  );

  function audit(event: Omit<AuditEvent, "id" | "createdAt">): AuditEvent {
    const item: AuditEvent = { id: id("audit"), createdAt: now(), ...event, payload: clone(event.payload) };
    auditEvents.push(item);
    saveRecord("audit_events", item.id, item, item.createdAt);
    return item;
  }

  async function fireWebhook(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
    const guard = isSafeWebhookUrl(webhookUrl);
    if (!guard.ok) {
      app.log.warn({ webhookUrl, reason: guard.reason }, "webhook delivery blocked: unsafe URL");
      audit({
        actorType: "system", eventType: "webhook.blocked",
        targetType: "webhook", targetId: webhookUrl,
        payload: { reason: guard.reason }
      });
      return;
    }
    try {
      await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000)
      });
    } catch (err) {
      app.log.warn({ webhookUrl, err }, "webhook delivery failed");
    }
  }

  function computeTrust(agentId: string) {
    const agentTasks = Array.from(tasks.values()).filter((t) => t.assignedAgentId === agentId);
    const tasksRun = agentTasks.filter((t) => ["completed", "approved", "denied", "failed"].includes(t.status)).length;
    const agentTaskIds = new Set(agentTasks.map((t) => t.id));
    const agentApprovals = Array.from(approvals.values()).filter((a) => agentTaskIds.has(a.taskId));
    const approvedCount = agentApprovals.filter((a) => a.status === "approved").length;
    const deniedCount = agentApprovals.filter((a) => a.status === "denied").length;
    const totalDecided = approvedCount + deniedCount;
    const approvalRate = totalDecided > 0 ? approvedCount / totalDecided : null;
    const violations = auditEvents.filter(
      (e) => e.eventType === "constraint.violation" && (e.payload as { agentId?: string }).agentId === agentId
    ).length;
    const totalCost = agentTasks.reduce((sum, task) => sum + (task.lastResponse?.costUsd ?? 0), 0);

    let suggestion: { promote: boolean; to: ExecutionMode; reason: string } | null = null;
    const agent = agents.get(agentId);
    if (agent && approvalRate !== null && approvalRate >= 0.9 && tasksRun >= 5 && violations === 0) {
      const modes: ExecutionMode[] = ["observe", "propose", "approval_required", "scoped_autonomy"];
      const currentIdx = modes.indexOf(agent.executionMode);
      const nextMode = modes[currentIdx + 1];
      if (nextMode) {
        suggestion = {
          promote: true,
          to: nextMode,
          reason: `${(approvalRate * 100).toFixed(0)}% approval rate over ${tasksRun} tasks with no constraint violations`
        };
      }
    }

    return { tasksRun, approvalRate, approvedCount, deniedCount, violations, totalCost, suggestion };
  }

  function lookupBackupAttestation(reference?: string) {
    if (!reference) return null;
    return Array.from(backupAttestations.values())
      .filter((item) => item.reference === reference)
      .sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0] ?? null;
  }

  function validateBackupEvidence(action: ProposedAction, policy: DatabaseConstraints): BackupEvidenceResult {
    const dbReview = classifyDatabaseAction(action);
    if (!dbReview.destructive || !policy.backupPolicy.requireFreshBackupBeforeDestructive) {
      return { ok: true };
    }
    if (!dbReview.backupReference) {
      return { ok: false, reason: "Destructive database actions must include a backupReference tied to an OperatorBoard attestation" };
    }
    const attestation = lookupBackupAttestation(dbReview.backupReference);
    if (!attestation) {
      return { ok: false, reason: `No attested backup found for reference "${dbReview.backupReference}"` };
    }
    if (minutesSince(attestation.verifiedAt) > policy.backupPolicy.maxBackupAgeMinutes) {
      return { ok: false, reason: `Attested backup "${attestation.reference}" is older than ${policy.backupPolicy.maxBackupAgeMinutes} minutes` };
    }
    return { ok: true, attestation };
  }

  function triggerPipeline(task: Task) {
    if (!task.onComplete?.createTask) return null;
    const nextTask = createPipelineTask(task.onComplete.createTask);
    tasks.set(nextTask.id, nextTask);
    saveRecord("tasks", nextTask.id, nextTask, nextTask.createdAt, nextTask.updatedAt);
    audit({
      actorType: "system",
      eventType: "task.pipeline.triggered",
      targetType: "task",
      targetId: nextTask.id,
      payload: { triggeredBy: task.id, nextTask }
    });
    return nextTask;
  }

  async function executeTaskRun(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = tasks.get(taskId);
    if (!task) return { ok: false, error: "Task not found" };
    if (!task.assignedAgentId) return { ok: false, error: "No assigned agent" };

    const agent = agents.get(task.assignedAgentId);
    if (!agent) return { ok: false, error: "Agent not found" };
    if (agent.suspendedAt) return { ok: false, error: "Agent is suspended" };
    if (agent.budgetLimitUsd !== undefined && (agent.spentUsdTotal ?? 0) >= agent.budgetLimitUsd) {
      return { ok: false, error: `Budget exhausted: $${(agent.spentUsdTotal ?? 0).toFixed(4)} of $${agent.budgetLimitUsd}` };
    }

    const remainingBudget = agent.budgetLimitUsd !== undefined
      ? agent.budgetLimitUsd - (agent.spentUsdTotal ?? 0)
      : undefined;

    const constraints: AgentConstraints = {
      maxCostUsd: remainingBudget,
      allowFileRead: false,   // deny by default; agents must be explicitly granted read access
      allowFileWrite: false,
      allowNetwork: false,    // deny by default; agents must be explicitly granted network access
      allowShell: false,
      allowedPaths: [],
      deniedPaths: [],
      allowedHosts: [],
      deniedCommands: [],
      database: agent.databasePolicy ?? databaseConstraintsSchema.parse({})
    };

    const taskRequest = taskRequestSchema.parse({
      taskId: task.id,
      title: task.title,
      description: task.description,
      mode: agent.executionMode,
      model: agent.model,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      constraints
    });

    task.status = "running";
    task.updatedAt = now();
    agent.status = "busy";
    saveRecord("tasks", task.id, task, task.createdAt, task.updatedAt);
    saveRecord("agents", agent.id, agent, agent.createdAt);

    audit({
      actorType: "system",
      eventType: "task.run.started",
      targetType: "task",
      targetId: task.id,
      payload: { taskRequest, agentId: agent.id, endpoint: agent.endpoint }
    });

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), TASK_RUN_TIMEOUT_MS);

    try {
      const response = await fetchImpl(agent.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(taskRequest),
        signal: controller.signal
      });
      clearTimeout(timeoutHandle);

      if (!response.ok) {
        throw new Error(`Agent endpoint returned ${response.status}`);
      }

      const raw = await response.json();
      const parsed = taskResponseSchema.parse(raw);

      if (parsed.costUsd !== undefined) {
        agent.spentUsdTotal = (agent.spentUsdTotal ?? 0) + parsed.costUsd;
      }

      const cleanedActions = parsed.actions.map((action) => {
        const check = enforceConstraints(action, constraints);
        const backupCheck = check.allowed ? validateBackupEvidence(action, constraints.database) : { ok: true as const };
        if (!check.allowed || !backupCheck.ok) {
          const reason = check.reason ?? backupCheck.reason;
          audit({
            actorType: "system",
            eventType: "constraint.violation",
            targetType: "action",
            targetId: action.id,
            payload: { action, reason, taskId: task.id, agentId: agent.id }
          });
          return { ...action, requiresApproval: true, summary: `[BLOCKED: ${reason}] ${action.summary}` };
        }
        return action;
      });

      const patchedResponse = { ...parsed, actions: cleanedActions };
      const needsApproval = cleanedActions.some((action) => action.requiresApproval);
      task.lastResponse = patchedResponse;
      task.status = needsApproval ? "approval_required" : parsed.status;
      task.updatedAt = now();
      agent.status = "idle";
      saveRecord("tasks", task.id, task, task.createdAt, task.updatedAt);
      saveRecord("agents", agent.id, agent, agent.createdAt);

      for (const [approvalId, approval] of approvals.entries()) {
        if (approval.taskId === task.id) approvals.delete(approvalId);
      }
      deleteApprovalsForTask(task.id);

      for (const action of cleanedActions) {
        if (!action.requiresApproval) continue;
        const approval: Approval = {
          id: id("approval"),
          taskId: task.id,
          actionId: action.id,
          status: "pending",
          createdAt: now()
        };
        approvals.set(approval.id, approval);
        saveRecord("approvals", approval.id, approval, approval.createdAt);
      }

      audit({
        actorType: "agent",
        eventType: "task.run.completed",
        targetType: "task",
        targetId: task.id,
        payload: { ...patchedResponse, agentId: agent.id }
      });

      if (agent.webhookUrl) {
        if (task.status === "approval_required") {
          void fireWebhook(agent.webhookUrl, {
            event: "approval_required",
            task: { id: task.id, title: task.title, status: task.status },
            actions: cleanedActions.filter((action) => action.requiresApproval),
            agentId: agent.id,
            agentName: agent.name
          });
        } else if (task.status === "completed") {
          void fireWebhook(agent.webhookUrl, {
            event: "task_completed",
            task: { id: task.id, title: task.title, status: task.status },
            costUsd: parsed.costUsd,
            agentId: agent.id
          });
        }
      }

      if (task.status === "completed") {
        triggerPipeline(task);
      }

      return { ok: true };
    } catch (err) {
      clearTimeout(timeoutHandle);
      const timedOut = err instanceof Error && err.name === "AbortError";
      task.status = "failed";
      task.updatedAt = now();
      agent.status = timedOut ? "idle" : "error";
      saveRecord("tasks", task.id, task, task.createdAt, task.updatedAt);
      saveRecord("agents", agent.id, agent, agent.createdAt);

      const errPayload = {
        timedOut,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : "UnknownError"
      };

      audit({
        actorType: "system",
        eventType: timedOut ? "task.run.timeout" : "task.run.failed",
        targetType: "task",
        targetId: task.id,
        payload: { ...errPayload, agentId: agent.id }
      });

      return { ok: false, error: errPayload.error };
    }
  }

  async function runDueTasks() {
    const currentTime = Date.now();
    for (const task of tasks.values()) {
      const scheduledTime = task.scheduledAt ? Date.parse(task.scheduledAt) : Number.NaN;
      if (task.status !== "scheduled" || !task.assignedAgentId || Number.isNaN(scheduledTime) || scheduledTime > currentTime) {
        continue;
      }
      app.log.info({ taskId: task.id }, "Scheduled task firing");
      task.status = "assigned";
      task.updatedAt = now();
      saveRecord("tasks", task.id, task, task.createdAt, task.updatedAt);
      await executeTaskRun(task.id).catch((err) => {
        app.log.error({ taskId: task.id, err }, "Scheduled task execution failed");
      });
    }
  }

  function seedDemoData(): void {
    if (agents.size > 0) return;

    const createdAt = now();
    const researchBot: Agent = {
      id: id("agent"),
      name: "ResearchBot",
      role: "Researcher",
      adapterType: "http",
      endpoint: "http://127.0.0.1:4200/task",
      executionMode: "approval_required",
      status: "idle",
      model: "claude-opus-4-7",
      temperature: 0.3,
      budgetLimitUsd: 5,
      spentUsdTotal: 1.2,
      createdAt
    };
    const writerBot: Agent = {
      id: id("agent"),
      name: "WriterBot",
      role: "Content Writer",
      adapterType: "http",
      endpoint: "http://127.0.0.1:4200/task",
      executionMode: "propose",
      status: "idle",
      model: "claude-sonnet-4-6",
      temperature: 0.7,
      budgetLimitUsd: 10,
      spentUsdTotal: 3.4,
      reportsTo: researchBot.id,
      createdAt
    };
    const devBot: Agent = {
      id: id("agent"),
      name: "DevBot",
      role: "Code Reviewer",
      adapterType: "http",
      endpoint: "http://127.0.0.1:4200/task",
      executionMode: "observe",
      status: "idle",
      model: "claude-opus-4-7",
      temperature: 0.1,
      budgetLimitUsd: 20,
      spentUsdTotal: 0,
      reportsTo: researchBot.id,
      createdAt
    };

    for (const agent of [researchBot, writerBot, devBot]) {
      agents.set(agent.id, agent);
      saveRecord("agents", agent.id, agent, agent.createdAt);
    }

    const seededTasks: Task[] = [
      {
        id: id("task"),
        title: "Summarise Q1 competitor landscape",
        description: "Scan public sources and produce a 500-word briefing on the top three competitors.",
        status: "approval_required",
        assignedAgentId: researchBot.id,
        createdAt,
        updatedAt: createdAt,
        lastResponse: {
          taskId: "",
          status: "approval_required",
          summary: "Found 3 key competitors. Proposing to publish summary to shared doc.",
          actions: [{
            id: id("action"),
            type: "file.write",
            risk: "medium",
            requiresApproval: true,
            summary: "Write competitor-briefing.md to /shared/reports/",
            payload: { path: "/shared/reports/competitor-briefing.md" },
            safety: { capability: "general", destructive: false }
          }],
          logs: ["Scraped 12 public pages.", "Identified 3 primary competitors.", "Draft ready for approval."],
          costUsd: 0.38,
          metadata: {}
        }
      },
      {
        id: id("task"),
        title: "Draft blog post: AI safety for operators",
        description: "Write a 1200-word post explaining why human oversight matters for agentic AI systems.",
        status: "proposal_ready",
        assignedAgentId: writerBot.id,
        createdAt,
        updatedAt: createdAt,
        lastResponse: {
          taskId: "",
          status: "proposal_ready",
          summary: "Draft complete. Proposes publishing to /blog/drafts/.",
          actions: [{
            id: id("action"),
            type: "file.write",
            risk: "low",
            requiresApproval: true,
            summary: "Save draft to /blog/drafts/ai-safety-operators.md",
            payload: { path: "/blog/drafts/ai-safety-operators.md" },
            safety: { capability: "general", destructive: false }
          }],
          logs: ["Outline generated.", "1,240 words drafted.", "Awaiting operator review."],
          costUsd: 0.82,
          metadata: {}
        }
      },
      {
        id: id("task"),
        title: "Code review: auth middleware PR",
        description: "Review the open pull request for the new JWT middleware and flag any security concerns.",
        status: "completed",
        assignedAgentId: devBot.id,
        createdAt,
        updatedAt: createdAt,
        lastResponse: {
          taskId: "",
          status: "completed",
          summary: "Review complete. No critical issues found. Two low-risk suggestions left as comments.",
          actions: [],
          logs: ["Cloned PR branch.", "Scanned 14 changed files.", "Left 2 inline comments.", "No blocking issues."],
          costUsd: 0.11,
          metadata: {}
        }
      }
    ];

    for (const task of seededTasks) {
      if (task.lastResponse) task.lastResponse.taskId = task.id;
      tasks.set(task.id, task);
      saveRecord("tasks", task.id, task, task.createdAt, task.updatedAt);
    }

    for (const task of seededTasks) {
      if (task.status !== "approval_required" || !task.lastResponse?.actions) continue;
      for (const action of task.lastResponse.actions) {
        const approval: Approval = {
          id: id("approval"),
          taskId: task.id,
          actionId: action.id,
          status: "pending",
          createdAt
        };
        approvals.set(approval.id, approval);
        saveRecord("approvals", approval.id, approval, approval.createdAt);
      }
    }

    app.log.info("Demo data seeded — 3 agents, 3 tasks, 1 pending approval");
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "Invalid request", details: error.flatten() });
    }
    return reply.send(error);
  });

  if (!API_KEY) {
    app.log.warn("OPERATORBOARD_API_KEY is not set — API is running unauthenticated");
  }

  app.addHook("preHandler", async (request, reply) => {
    if (!API_KEY) return;
    if (request.method === "OPTIONS") return;
    if (request.url === "/health") return;
    const provided = request.headers["x-operatorboard-key"];
    if (typeof provided === "string" && timingSafeEqualString(provided, API_KEY)) return;

    audit({
      actorType: "system",
      eventType: "auth.rejected",
      targetType: "api",
      targetId: request.url,
      payload: { ip: request.ip, method: request.method, url: request.url }
    });
    return reply.status(401).send({ error: "Unauthorized" });
  });

  app.get("/health", async () => ({ ok: true, name: "operatorboard-api", version: "0.1.0" }));

  function honeypot(url: string) {
    app.post(url, async (request, reply) => {
      audit({
        actorType: "system",
        eventType: "honeypot.triggered",
        targetType: "honeypot",
        targetId: url,
        payload: { ip: request.ip, url: request.url, userAgent: request.headers["user-agent"] ?? null }
      });
      app.log.warn({ ip: request.ip, url }, "Honeypot triggered");
      return reply.status(404).send({ error: "Not found" });
    });
  }

  honeypot("/dev/factory-reset");
  honeypot("/admin/reset");
  honeypot("/api/reset");
  honeypot("/v1/agents/register");
  honeypot("/internal/flush");

  if (ENABLE_DEV_ROUTES) {
    app.post("/dev/reset", async () => {
      agents.clear();
      tasks.clear();
      approvals.clear();
      backupAttestations.clear();
      heartbeats.length = 0;
      auditEvents.length = 0;
      deleteAllRecords();
      return { ok: true, message: "OperatorBoard dev data reset." };
    });
  }

  app.get("/backup-attestations", async () => Array.from(backupAttestations.values()));

  app.post("/backup-attestations", async (request, reply) => {
    const body = createBackupAttestationSchema.parse(request.body);
    // Source is always "manual" on this unsigned path regardless of what the body claims.
    // Integration provenance requires passing through the signed /integrations/:provider path.
    const attestation: BackupAttestation = {
      id: id("backup"),
      system: body.system,
      scope: body.scope,
      reference: body.reference,
      verifiedAt: body.verifiedAt,
      source: "manual",
      metadata: body.metadata,
      createdAt: now()
    };
    backupAttestations.set(attestation.id, attestation);
    saveRecord("backup_attestations", attestation.id, attestation, attestation.createdAt);
    audit({
      actorType: "operator",
      eventType: "backup.attested",
      targetType: "backup_attestation",
      targetId: attestation.id,
      payload: attestation
    });
    return reply.status(201).send(attestation);
  });

  app.post("/backup-attestations/integrations/:provider", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const secret = BACKUP_INTEGRATION_SECRETS[provider];
    if (!secret) {
      audit({
        actorType: "system",
        eventType: "backup.attestation.rejected",
        targetType: "backup_attestation",
        targetId: provider,
        payload: { reason: "Unknown integration provider", provider }
      });
      return reply.status(404).send({ error: "Unknown integration provider" });
    }

    const timestampHeader = request.headers["x-operatorboard-timestamp"];
    const signatureHeader = request.headers["x-operatorboard-signature"];
    if (typeof timestampHeader !== "string" || typeof signatureHeader !== "string") {
      audit({
        actorType: "system",
        eventType: "backup.attestation.rejected",
        targetType: "backup_attestation",
        targetId: provider,
        payload: { reason: "Missing integration signature headers", provider }
      });
      return reply.status(401).send({ error: "Missing integration signature headers" });
    }

    const timestampMs = Number(timestampHeader);
    // age > TTL: too old. age < -30s: future timestamp (allow 30 s clock skew but no more).
    const age = Date.now() - timestampMs;
    if (!Number.isFinite(timestampMs) || age > INTEGRATION_SIGNATURE_TTL_MS || age < -30_000) {
      audit({
        actorType: "system",
        eventType: "backup.attestation.rejected",
        targetType: "backup_attestation",
        targetId: provider,
        payload: { reason: "Stale or invalid integration timestamp", provider, timestampHeader }
      });
      return reply.status(401).send({ error: "Stale or invalid integration timestamp" });
    }

    const body = createBackupAttestationSchema.parse(request.body);
    const canonicalBody = canonicalStringify({
      system: body.system,
      scope: body.scope,
      reference: body.reference,
      verifiedAt: body.verifiedAt,
      source: "integration",
      metadata: body.metadata
    });
    // provider is bound into the canonical string so a valid request to one provider endpoint
    // cannot be replayed to a different provider even if they share a secret.
    const expectedSignature = nodeCreateHmac("sha256", secret)
      .update(`${provider}.${timestampHeader}.${canonicalBody}`)
      .digest("hex");

    if (!timingSafeEqualString(signatureHeader, expectedSignature)) {
      audit({
        actorType: "system",
        eventType: "backup.attestation.rejected",
        targetType: "backup_attestation",
        targetId: provider,
        payload: { reason: "Invalid integration signature", provider }
      });
      return reply.status(401).send({ error: "Invalid integration signature" });
    }

    // Replay protection: reject if this exact nonce (provider + timestamp + signature) has been seen before
    if (!consumeIntegrationNonce(provider, timestampHeader, signatureHeader)) {
      audit({
        actorType: "system",
        eventType: "backup.attestation.rejected",
        targetType: "backup_attestation",
        targetId: provider,
        payload: { reason: "Replayed integration request", provider, timestampHeader }
      });
      return reply.status(401).send({ error: "Replayed integration request" });
    }

    const attestation: BackupAttestation = {
      id: id("backup"),
      system: body.system,
      scope: body.scope,
      reference: body.reference,
      verifiedAt: body.verifiedAt,
      source: "integration",
      metadata: { provider, ...body.metadata },
      createdAt: now()
    };
    backupAttestations.set(attestation.id, attestation);
    saveRecord("backup_attestations", attestation.id, attestation, attestation.createdAt);
    audit({
      actorType: "system",
      eventType: "backup.attested",
      targetType: "backup_attestation",
      targetId: attestation.id,
      payload: attestation
    });
    return reply.status(201).send(attestation);
  });

  app.get("/agents", async () => Array.from(agents.values()));

  app.post("/agents", async (request, reply) => {
    const body = createAgentSchema.parse(request.body);
    if (body.reportsTo && !agents.has(body.reportsTo)) {
      return reply.status(400).send({ error: "reportsTo must reference an existing agent" });
    }
    if (body.webhookUrl) {
      const guard = isSafeWebhookUrl(body.webhookUrl);
      if (!guard.ok) {
        return reply.status(400).send({ error: `webhookUrl rejected: ${guard.reason}` });
      }
    }

    const agent: Agent = {
      id: id("agent"),
      name: body.name,
      role: body.role,
      adapterType: body.adapterType,
      endpoint: body.endpoint,
      executionMode: body.executionMode,
      status: "idle",
      model: body.model,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      reportsTo: body.reportsTo,
      webhookUrl: body.webhookUrl,
      budgetLimitUsd: body.budgetLimitUsd,
      spentUsdTotal: 0,
      databasePolicy: body.databasePolicy,
      createdAt: now()
    };

    agents.set(agent.id, agent);
    saveRecord("agents", agent.id, agent, agent.createdAt);
    audit({ actorType: "operator", eventType: "agent.created", targetType: "agent", targetId: agent.id, payload: agent });
    return reply.status(201).send(agent);
  });

  app.post("/agents/:agentId/test", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = agents.get(agentId);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });

    try {
      const res = await fetchImpl(`${agent.endpoint.replace(/\/task$/, "")}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      const ok = res.ok;
      const body = ok ? await res.json().catch(() => ({})) : {};
      agent.status = ok ? "idle" : "error";
      saveRecord("agents", agent.id, agent, agent.createdAt);
      audit({
        actorType: "system",
        eventType: ok ? "agent.health.ok" : "agent.health.fail",
        targetType: "agent",
        targetId: agent.id,
        payload: { endpoint: agent.endpoint, statusCode: res.status, body }
      });
      return { ok, statusCode: res.status, body, error: ok ? undefined : `Health check returned ${res.status}` };
    } catch (err) {
      agent.status = "error";
      saveRecord("agents", agent.id, agent, agent.createdAt);
      audit({
        actorType: "system",
        eventType: "agent.health.fail",
        targetType: "agent",
        targetId: agent.id,
        payload: { endpoint: agent.endpoint, error: err instanceof Error ? err.message : String(err) }
      });
      return reply.status(200).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/agents/:agentId/trust", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!agents.has(agentId)) return reply.status(404).send({ error: "Agent not found" });
    return computeTrust(agentId);
  });

  app.post("/agents/:agentId/suspend", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = agents.get(agentId);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });

    agent.status = "offline";
    agent.suspendedAt = now();
    saveRecord("agents", agent.id, agent, agent.createdAt);

    let pausedCount = 0;
    for (const task of tasks.values()) {
      if (task.assignedAgentId !== agentId || !["running", "queued", "assigned", "scheduled"].includes(task.status)) continue;
      task.status = "paused";
      task.updatedAt = now();
      saveRecord("tasks", task.id, task, task.createdAt, task.updatedAt);
      pausedCount++;
    }

    audit({ actorType: "operator", eventType: "agent.suspended", targetType: "agent", targetId: agentId, payload: { agentId, pausedTasks: pausedCount } });
    return { agent, pausedTasks: pausedCount };
  });

  app.post("/agents/:agentId/resume", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = agents.get(agentId);
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    agent.status = "idle";
    agent.suspendedAt = undefined;
    saveRecord("agents", agent.id, agent, agent.createdAt);
    audit({ actorType: "operator", eventType: "agent.resumed", targetType: "agent", targetId: agentId, payload: { agentId } });
    return agent;
  });

  app.get("/tasks", async () => Array.from(tasks.values()));

  app.get("/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.get(taskId);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    return {
      task,
      approvals: Array.from(approvals.values()).filter((approval) => approval.taskId === task.id),
      audit: auditEvents.filter((event) => event.targetType === "task" && event.targetId === task.id)
    };
  });

  app.post("/tasks", async (request, reply) => {
    const body = createTaskSchema.parse(request.body);
    const scheduledAt = body.scheduledAt ? normalizeScheduledAt(body.scheduledAt) : undefined;

    if (body.scheduledAt && !scheduledAt) {
      return reply.status(400).send({ error: "scheduledAt must be a valid date/time" });
    }
    if (body.assignedAgentId && !agents.has(body.assignedAgentId)) {
      return reply.status(400).send({ error: "assignedAgentId must reference an existing agent" });
    }
    if (scheduledAt && !body.assignedAgentId) {
      return reply.status(400).send({ error: "Scheduled tasks must have an assigned agent" });
    }
    if (body.onCompleteAgentId && !agents.has(body.onCompleteAgentId)) {
      return reply.status(400).send({ error: "onCompleteAgentId must reference an existing agent" });
    }
    if ((body.onCompleteTitle && !body.onCompleteDescription) || (!body.onCompleteTitle && body.onCompleteDescription)) {
      return reply.status(400).send({ error: "onCompleteTitle and onCompleteDescription must be provided together" });
    }

    let onComplete: Task["onComplete"];
    if (body.onCompleteTitle && body.onCompleteDescription) {
      onComplete = {
        createTask: {
          title: body.onCompleteTitle,
          description: body.onCompleteDescription,
          assignedAgentId: body.onCompleteAgentId
        }
      };
    }

    const createdAt = now();
    const task: Task = {
      id: id("task"),
      title: body.title,
      description: body.description,
      status: scheduledAt ? "scheduled" : body.assignedAgentId ? "assigned" : "queued",
      assignedAgentId: body.assignedAgentId,
      onComplete,
      createdAt,
      updatedAt: createdAt,
      ...(scheduledAt ? { scheduledAt } : {})
    };

    tasks.set(task.id, task);
    saveRecord("tasks", task.id, task, task.createdAt, task.updatedAt);
    audit({ actorType: "operator", eventType: "task.created", targetType: "task", targetId: task.id, payload: task });
    return reply.status(201).send(task);
  });

  app.post("/tasks/:taskId/assign/:agentId", async (request, reply) => {
    const { taskId, agentId } = request.params as { taskId: string; agentId: string };
    const task = tasks.get(taskId);
    const agent = agents.get(agentId);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    if (agent.suspendedAt) return reply.status(400).send({ error: "Cannot assign tasks to a suspended agent" });

    task.assignedAgentId = agent.id;
    if (task.status === "queued") task.status = "assigned";
    task.updatedAt = now();
    saveRecord("tasks", task.id, task, task.createdAt, task.updatedAt);
    audit({ actorType: "operator", eventType: "task.assigned", targetType: "task", targetId: task.id, payload: { taskId: task.id, agentId: agent.id } });
    return task;
  });

  app.post("/tasks/:taskId/run", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = tasks.get(taskId);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    if (!task.assignedAgentId) return reply.status(400).send({ error: "Task has no assigned agent" });
    if (["completed", "approved", "denied", "approval_required", "running"].includes(task.status)) {
      return reply.status(400).send({ error: `Task cannot be run from status "${task.status}" — resolve or cancel pending approvals first` });
    }

    const agent = agents.get(task.assignedAgentId);
    if (!agent) return reply.status(404).send({ error: "Assigned agent not found" });
    if (agent.suspendedAt) return reply.status(400).send({ error: "Agent is suspended and cannot accept tasks" });
    if (agent.budgetLimitUsd !== undefined && (agent.spentUsdTotal ?? 0) >= agent.budgetLimitUsd) {
      return reply.status(400).send({ error: `Agent budget exhausted: $${(agent.spentUsdTotal ?? 0).toFixed(4)} of $${agent.budgetLimitUsd}` });
    }

    const result = await executeTaskRun(taskId);
    if (!result.ok) return reply.status(500).send({ error: result.error });
    return tasks.get(taskId);
  });

  app.post("/tasks/:taskId/schedule", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const body = scheduleTaskSchema.parse(request.body);
    const task = tasks.get(taskId);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    if (!task.assignedAgentId) return reply.status(400).send({ error: "Scheduled tasks must have an assigned agent" });
    if (["completed", "approved", "denied", "approval_required", "running"].includes(task.status)) {
      return reply.status(400).send({ error: `Task in status "${task.status}" cannot be rescheduled` });
    }

    const scheduledAt = normalizeScheduledAt(body.scheduledAt);
    if (!scheduledAt) return reply.status(400).send({ error: "scheduledAt must be a valid date/time" });

    task.scheduledAt = scheduledAt;
    task.status = "scheduled";
    task.updatedAt = now();
    saveRecord("tasks", task.id, task, task.createdAt, task.updatedAt);
    audit({ actorType: "operator", eventType: "task.scheduled", targetType: "task", targetId: task.id, payload: { scheduledAt: task.scheduledAt } });
    return task;
  });

  app.get("/approvals", async () => Array.from(approvals.values()));

  app.post("/approvals/:approvalId/:decision", async (request, reply) => {
    const { approvalId, decision } = request.params as { approvalId: string; decision: "approve" | "deny" };
    const body = approvalDecisionSchema.parse(request.body ?? {});
    const approval = approvals.get(approvalId);
    if (!approval) return reply.status(404).send({ error: "Approval not found" });
    if (!["approve", "deny"].includes(decision)) return reply.status(400).send({ error: "Decision must be approve or deny" });
    if (approval.status !== "pending") return reply.status(400).send({ error: "Approval already decided" });

    const task = tasks.get(approval.taskId);
    const action = task?.lastResponse?.actions.find((item) => item.id === approval.actionId);
    if (decision === "approve" && action?.summary.startsWith("[BLOCKED:")) {
      return reply.status(400).send({ error: "Blocked actions cannot be approved until the policy violation is removed" });
    }
    if (decision === "approve" && task?.assignedAgentId && action) {
      const agent = agents.get(task.assignedAgentId);
      const dbReview = classifyDatabaseAction(action);
      const policy = agent?.databasePolicy ?? databaseConstraintsSchema.parse({});
      if (dbReview.capability === "database" && dbReview.destructive) {
        const backupEvidence = validateBackupEvidence(action, policy);
        if (!backupEvidence.ok) {
          return reply.status(400).send({ error: backupEvidence.reason });
        }
        if (policy.backupPolicy.requireOperatorAcknowledgement && !body.acknowledgeRisk) {
          return reply.status(400).send({ error: "Destructive database approvals require explicit operator acknowledgement" });
        }
      }
    }

    approval.status = decision === "approve" ? "approved" : "denied";
    approval.reviewedAt = now();
    saveRecord("approvals", approval.id, approval, approval.createdAt);
    if (task) {
      const previousStatus = task.status;
      const taskApprovals = Array.from(approvals.values()).filter((item) => item.taskId === task.id);
      const hasDenied = taskApprovals.some((item) => item.status === "denied");
      const hasPending = taskApprovals.some((item) => item.status === "pending");
      const allApproved = taskApprovals.length > 0 && taskApprovals.every((item) => item.status === "approved");

      if (hasDenied) task.status = "denied";
      else if (hasPending) task.status = "approval_required";
      else if (allApproved) task.status = "approved";

      task.updatedAt = now();
      saveRecord("tasks", task.id, task, task.createdAt, task.updatedAt);

      if (previousStatus !== "approved" && task.status === "approved") {
        triggerPipeline(task);
      }

      const agent = task.assignedAgentId ? agents.get(task.assignedAgentId) : undefined;
      if (agent?.webhookUrl && previousStatus !== task.status && ["approved", "denied"].includes(task.status)) {
        void fireWebhook(agent.webhookUrl, {
          event: `task_${task.status}`,
          task: { id: task.id, title: task.title, status: task.status },
          approvalId: approval.id
        });
      }

      if (previousStatus !== task.status) {
        audit({ actorType: "operator", eventType: `task.${task.status}`, targetType: "task", targetId: task.id, payload: task });
      }
    }

    audit({ actorType: "operator", eventType: `approval.${approval.status}`, targetType: "approval", targetId: approval.id, payload: approval });
    return approval;
  });

  app.post("/heartbeats", async (request, reply) => {
    const parsed = heartbeatSchema.parse(request.body);
    heartbeats.push(parsed);
    saveRecord("heartbeats", id("heartbeat"), parsed, parsed.timestamp);
    const agent = agents.get(parsed.agentId);
    if (agent && !agent.suspendedAt) {
      agent.status = parsed.status;
      saveRecord("agents", agent.id, agent, agent.createdAt);
    }
    audit({ actorType: "agent", eventType: "agent.heartbeat", targetType: "agent", targetId: parsed.agentId, payload: parsed });
    return reply.status(201).send(parsed);
  });

  app.get("/heartbeats", async () => heartbeats.slice(-100));

  app.get("/analytics", async () => {
    const byDay: Record<string, { runs: number; costUsd: number }> = {};
    for (const task of tasks.values()) {
      if (task.lastResponse?.costUsd === undefined) continue;
      const day = task.updatedAt.slice(0, 10);
      if (!byDay[day]) byDay[day] = { runs: 0, costUsd: 0 };
      byDay[day].runs++;
      byDay[day].costUsd += task.lastResponse.costUsd;
    }

    const totalSpent = Array.from(agents.values()).reduce((sum, agent) => sum + (agent.spentUsdTotal ?? 0), 0);
    const tasksByStatus: Record<string, number> = {};
    for (const task of tasks.values()) {
      tasksByStatus[task.status] = (tasksByStatus[task.status] ?? 0) + 1;
    }

    const allApprovals = Array.from(approvals.values());
    const decidedApprovals = allApprovals.filter((approval) => ["approved", "denied"].includes(approval.status));

    return {
      totalSpent,
      taskCount: tasks.size,
      agentCount: agents.size,
      approvalRate: decidedApprovals.length === 0
        ? null
        : decidedApprovals.filter((approval) => approval.status === "approved").length / decidedApprovals.length,
      byDay,
      tasksByStatus
    };
  });

  app.get("/audit", async () => auditEvents.slice(-250));

  if (process.env.OPERATORBOARD_SEED === "true") {
    seedDemoData();
  }

  let scheduler: NodeJS.Timeout | undefined;
  if (options.startScheduler !== false) {
    scheduler = setInterval(() => {
      void runDueTasks();
    }, SCHEDULER_INTERVAL_MS);
  }

  app.addHook("onClose", async () => {
    if (scheduler) clearInterval(scheduler);
  });

  return app;
}

const isMainModule = fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const port = Number(process.env.PORT ?? 4100);
  const host = process.env.HOST ?? "127.0.0.1";
  const app = await buildApp();
  await app.listen({ port, host });
}
