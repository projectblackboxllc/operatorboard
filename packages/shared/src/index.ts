import { z } from "zod";

export const executionModeSchema = z.enum([
  "observe",
  "propose",
  "approval_required",
  "scoped_autonomy"
]);

export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const taskStatusSchema = z.enum([
  "queued",
  "assigned",
  "running",
  "proposal_ready",
  "approval_required",
  "approved",
  "denied",
  "completed",
  "failed",
  "paused",
  "scheduled"
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const adapterTypeSchema = z.string().min(1);
export type AdapterType = z.infer<typeof adapterTypeSchema>;

export const databaseAccessLevelSchema = z.enum([
  "none",
  "read_only",
  "write_safe",
  "write_destructive"
]);

export type DatabaseAccessLevel = z.infer<typeof databaseAccessLevelSchema>;

export const databaseBackupPolicySchema = z.object({
  requireFreshBackupBeforeDestructive: z.boolean().default(true),
  maxBackupAgeMinutes: z.number().int().positive().default(60),
  requireOperatorAcknowledgement: z.boolean().default(true)
});

export type DatabaseBackupPolicy = z.infer<typeof databaseBackupPolicySchema>;

export const databaseConstraintsSchema = z.object({
  access: databaseAccessLevelSchema.default("none"),
  allowRawSql: z.boolean().default(false),
  allowSchemaChanges: z.boolean().default(false),
  allowBackupRestore: z.boolean().default(false),
  backupPolicy: databaseBackupPolicySchema.default({})
});

export type DatabaseConstraints = z.infer<typeof databaseConstraintsSchema>;

export const agentConstraintsSchema = z.object({
  maxCostUsd: z.number().nonnegative().optional(),
  allowFileRead: z.boolean().default(true),
  allowFileWrite: z.boolean().default(false),
  allowNetwork: z.boolean().default(false),
  allowShell: z.boolean().default(false),
  allowedPaths: z.array(z.string()).default([]),
  deniedPaths: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  deniedCommands: z.array(z.string()).default([]),
  database: databaseConstraintsSchema.default({})
});

export type AgentConstraints = z.infer<typeof agentConstraintsSchema>;

export const taskRequestSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  mode: executionModeSchema,
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  constraints: agentConstraintsSchema
});

export type TaskRequest = z.infer<typeof taskRequestSchema>;

export const proposedActionSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  risk: riskLevelSchema,
  requiresApproval: z.boolean(),
  summary: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  safety: z.object({
    capability: z.enum(["general", "database"]).default("general"),
    destructive: z.boolean().default(false),
    plainLanguage: z.string().min(1).optional(),
    estimatedAffectedRows: z.number().int().nonnegative().optional(),
    backupVerifiedAt: z.string().datetime().optional(),
    backupReference: z.string().min(1).optional()
  }).default({})
});

export type ProposedAction = z.infer<typeof proposedActionSchema>;

export const taskResponseSchema = z.object({
  taskId: z.string().min(1),
  status: taskStatusSchema,
  summary: z.string().default(""),
  actions: z.array(proposedActionSchema).default([]),
  logs: z.array(z.string()).default([]),
  costUsd: z.number().nonnegative().optional(),
  metadata: z.record(z.unknown()).default({})
});

export type TaskResponse = z.infer<typeof taskResponseSchema>;

export const heartbeatSchema = z.object({
  agentId: z.string().min(1),
  status: z.enum(["online", "busy", "idle", "offline", "error"]),
  message: z.string().default(""),
  metadata: z.record(z.unknown()).default({}),
  timestamp: z.string().datetime()
});

export type Heartbeat = z.infer<typeof heartbeatSchema>;

export const pipelineTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  assignedAgentId: z.string().optional()
});

export type PipelineTask = z.infer<typeof pipelineTaskSchema>;

export const backupAttestationSchema = z.object({
  id: z.string().min(1),
  system: z.string().min(1),
  scope: z.string().min(1),
  reference: z.string().min(1),
  verifiedAt: z.string().datetime(),
  source: z.enum(["manual", "integration"]),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime()
});

export type BackupAttestation = z.infer<typeof backupAttestationSchema>;
