import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";

process.env.OPERATORBOARD_DB_PATH = join(tmpdir(), `operatorboard-test-${Date.now()}.sqlite`);
process.env.OPERATORBOARD_API_KEY = "test-key";
process.env.OPERATORBOARD_ENABLE_DEV_ROUTES = "true";
process.env.OPERATORBOARD_SEED = "false";
process.env.OPERATORBOARD_BACKUP_INTEGRATION_SECRETS = JSON.stringify({ aws_rds: "integration-secret" });

const { buildApp } = await import("./index.js");

let agentResponse: { status: number; body: Record<string, unknown> } = createDefaultAgentResponse();

function createDefaultAgentResponse() {
  return {
    status: 200,
    body: {
      taskId: "placeholder",
      status: "proposal_ready",
      summary: "Agent finished review.",
      actions: [
        {
          id: "action_a",
          type: "operator.note",
          risk: "medium",
          requiresApproval: true,
          summary: "Create first note.",
          payload: { note: "first" },
          safety: { capability: "general", destructive: false }
        },
        {
          id: "action_b",
          type: "operator.note",
          risk: "low",
          requiresApproval: true,
          summary: "Create second note.",
          payload: { note: "second" },
          safety: { capability: "general", destructive: false }
        }
      ],
      logs: ["ran"],
      costUsd: 0.25,
      metadata: {}
    }
  };
}

const healthResponses = new Map<string, { status: number; body: unknown }>();

const app = await buildApp({
  logger: false,
  schedulerIntervalMs: 10,
  fetchImpl: async (input, init) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      const health = healthResponses.get(url) ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(health.body), {
        status: health.status,
        headers: { "content-type": "application/json" }
      });
    }

    if (url.endsWith("/task")) {
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as { taskId?: string };
      return new Response(JSON.stringify({
        ...agentResponse.body,
        taskId: requestBody.taskId ?? "missing-task-id"
      }), {
        status: agentResponse.status,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("not found", { status: 404 });
  }
});

const authHeaders = { "x-operatorboard-key": "test-key" };

async function createAgent(overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/agents",
    headers: authHeaders,
    payload: {
      name: "Reviewer",
      role: "Code Reviewer",
      adapterType: "http",
      endpoint: "http://agent.local/task",
      executionMode: "approval_required",
      databasePolicy: {
        access: "none",
        allowRawSql: false,
        allowSchemaChanges: false,
        allowBackupRestore: false,
        backupPolicy: {
          requireFreshBackupBeforeDestructive: true,
          maxBackupAgeMinutes: 60,
          requireOperatorAcknowledgement: true
        }
      },
      ...overrides
    }
  });
  assert.equal(response.statusCode, 201);
  return response.json() as { id: string };
}

async function createTask(agentId: string, overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: authHeaders,
    payload: {
      title: "Review release checklist",
      description: "Run release readiness checks.",
      assignedAgentId: agentId,
      ...overrides
    }
  });
  assert.equal(response.statusCode, 201);
  return response.json() as { id: string; status: string; scheduledAt?: string };
}

async function createBackupAttestation(overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/backup-attestations",
    headers: authHeaders,
    payload: {
      system: "postgres-prod",
      scope: "customers",
      reference: "backup_ref_default",
      verifiedAt: new Date().toISOString(),
      source: "manual",
      metadata: {},
      ...overrides
    }
  });
  assert.equal(response.statusCode, 201);
  return response.json() as { id: string; reference: string; verifiedAt: string };
}

function signIntegrationPayload(timestamp: string, payload: Record<string, unknown>, provider = "aws_rds", secret = "integration-secret") {
  const canonicalize = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`).join(",")}}`;
  };
  // provider is bound into the canonical string (mirrors server-side enforcement)
  return createHmac("sha256", secret).update(`${provider}.${timestamp}.${canonicalize(payload)}`).digest("hex");
}

beforeEach(async () => {
  healthResponses.clear();
  agentResponse = createDefaultAgentResponse();
  const response = await app.inject({
    method: "POST",
    url: "/dev/reset",
    headers: authHeaders
  });
  assert.equal(response.statusCode, 200);
});

after(async () => {
  await app.close();
});

describe("auth", () => {
  test("protects read routes when API key is configured", async () => {
    const unauthorized = await app.inject({ method: "GET", url: "/agents" });
    assert.equal(unauthorized.statusCode, 401);

    const authorized = await app.inject({
      method: "GET",
      url: "/agents",
      headers: authHeaders
    });
    assert.equal(authorized.statusCode, 200);
  });
});

describe("validation", () => {
  test("rejects invalid agent payloads", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      headers: authHeaders,
      payload: {
        name: "Broken",
        role: "Tester",
        adapterType: "http",
        endpoint: "not-a-url",
        executionMode: "freeform"
      }
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Invalid request/);
  });

  test("normalizes scheduled task timestamps", async () => {
    const agent = await createAgent();
    const task = await createTask(agent.id, { scheduledAt: "2030-04-27T14:30" });

    assert.equal(task.status, "scheduled");
    assert.ok(task.scheduledAt);
    assert.ok(task.scheduledAt.endsWith("Z"));
  });
});

describe("approval workflow", () => {
  test("keeps task pending until all approvals are decided", async () => {
    const agent = await createAgent();
    const task = await createTask(agent.id, {
      onCompleteTitle: "Follow-up",
      onCompleteDescription: "Only create after both approvals pass."
    });

    const runResponse = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/run`,
      headers: authHeaders
    });
    assert.equal(runResponse.statusCode, 200);

    const taskDetails = await app.inject({
      method: "GET",
      url: `/tasks/${task.id}`,
      headers: authHeaders
    });
    const parsed = taskDetails.json() as {
      task: { status: string };
      approvals: Array<{ id: string; status: string }>;
    };

    assert.equal(parsed.task.status, "approval_required");
    assert.equal(parsed.approvals.length, 2);

    const firstApproval = await app.inject({
      method: "POST",
      url: `/approvals/${parsed.approvals[0]?.id}/approve`,
      headers: authHeaders
    });
    assert.equal(firstApproval.statusCode, 200);

    const afterFirstDecision = await app.inject({
      method: "GET",
      url: `/tasks/${task.id}`,
      headers: authHeaders
    });
    const stillPending = afterFirstDecision.json() as {
      task: { status: string };
    };
    assert.equal(stillPending.task.status, "approval_required");

    const tasksAfterFirstDecision = await app.inject({
      method: "GET",
      url: "/tasks",
      headers: authHeaders
    });
    assert.equal((tasksAfterFirstDecision.json() as Array<unknown>).length, 1);

    const secondApproval = await app.inject({
      method: "POST",
      url: `/approvals/${parsed.approvals[1]?.id}/approve`,
      headers: authHeaders
    });
    assert.equal(secondApproval.statusCode, 200);

    const tasksAfterSecondDecision = await app.inject({
      method: "GET",
      url: "/tasks",
      headers: authHeaders
    });
    const allTasks = tasksAfterSecondDecision.json() as Array<{ id: string; status: string; title: string }>;
    assert.equal(allTasks.length, 2);
    assert.ok(allTasks.some((item) => item.title === "Follow-up"));
  });
});

describe("database governance", () => {
  test("blocks destructive database actions without a recent backup", async () => {
    agentResponse = {
      status: 200,
      body: {
        taskId: "placeholder",
        status: "proposal_ready",
        summary: "Agent wants to clean up data.",
        actions: [{
          id: "db_delete",
          type: "db.row.delete",
          risk: "critical",
          requiresApproval: true,
          summary: "Delete stale customer rows.",
          payload: { table: "customers" },
          safety: {
            capability: "database",
            destructive: true,
            plainLanguage: "This can permanently delete customer records.",
            estimatedAffectedRows: 24381,
            backupReference: "missing_backup_ref"
          }
        }],
        logs: ["prepared db delete"],
        metadata: {}
      }
    };

    const agent = await createAgent({
      databasePolicy: {
        access: "write_destructive",
        allowRawSql: false,
        allowSchemaChanges: false,
        allowBackupRestore: false,
        backupPolicy: {
          requireFreshBackupBeforeDestructive: true,
          maxBackupAgeMinutes: 60,
          requireOperatorAcknowledgement: true
        }
      }
    });
    const task = await createTask(agent.id);

    const runResponse = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/run`,
      headers: authHeaders
    });
    assert.equal(runResponse.statusCode, 200);

    const taskDetails = await app.inject({
      method: "GET",
      url: `/tasks/${task.id}`,
      headers: authHeaders
    });
    const parsed = taskDetails.json() as {
      task: { status: string; lastResponse?: { actions: Array<{ summary: string }> } };
      approvals: Array<{ id: string }>;
    };

    assert.equal(parsed.task.status, "approval_required");
    assert.match(parsed.task.lastResponse?.actions[0]?.summary ?? "", /No attested backup found/);

    const approvalAttempt = await app.inject({
      method: "POST",
      url: `/approvals/${parsed.approvals[0]?.id}/approve`,
      headers: authHeaders,
      payload: { acknowledgeRisk: true }
    });
    assert.equal(approvalAttempt.statusCode, 400);
    assert.match(approvalAttempt.body, /Blocked actions cannot be approved/);
  });

  test("requires explicit acknowledgement for destructive database approval", async () => {
    await createBackupAttestation({ reference: "backup_2025_04_27" });
    agentResponse = {
      status: 200,
      body: {
        taskId: "placeholder",
        status: "proposal_ready",
        summary: "Agent wants to restore a backup.",
        actions: [{
          id: "db_restore",
          type: "db.backup.restore",
          risk: "critical",
          requiresApproval: true,
          summary: "Restore production data from backup.",
          payload: { backupId: "backup_2025_04_27" },
          safety: {
            capability: "database",
            destructive: true,
            plainLanguage: "This can overwrite live production data.",
            backupReference: "backup_2025_04_27"
          }
        }],
        logs: ["prepared restore"],
        metadata: {}
      }
    };

    const agent = await createAgent({
      databasePolicy: {
        access: "write_destructive",
        allowRawSql: false,
        allowSchemaChanges: false,
        allowBackupRestore: true,
        backupPolicy: {
          requireFreshBackupBeforeDestructive: true,
          maxBackupAgeMinutes: 60,
          requireOperatorAcknowledgement: true
        }
      }
    });
    const task = await createTask(agent.id);

    const runResponse = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/run`,
      headers: authHeaders
    });
    assert.equal(runResponse.statusCode, 200);

    const taskDetails = await app.inject({
      method: "GET",
      url: `/tasks/${task.id}`,
      headers: authHeaders
    });
    const parsed = taskDetails.json() as {
      approvals: Array<{ id: string }>;
    };

    const missingAck = await app.inject({
      method: "POST",
      url: `/approvals/${parsed.approvals[0]?.id}/approve`,
      headers: authHeaders
    });
    assert.equal(missingAck.statusCode, 400);
    assert.match(missingAck.body, /explicit operator acknowledgement/);

    const withAck = await app.inject({
      method: "POST",
      url: `/approvals/${parsed.approvals[0]?.id}/approve`,
      headers: authHeaders,
      payload: { acknowledgeRisk: true }
    });
    assert.equal(withAck.statusCode, 200);
  });

  test("rejects destructive database approval when attestation is stale", async () => {
    await createBackupAttestation({
      reference: "backup_old",
      verifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    });
    agentResponse = {
      status: 200,
      body: {
        taskId: "placeholder",
        status: "proposal_ready",
        summary: "Agent wants to delete rows.",
        actions: [{
          id: "db_delete_old",
          type: "db.row.delete",
          risk: "critical",
          requiresApproval: true,
          summary: "Delete rows with stale backup.",
          payload: { table: "orders" },
          safety: {
            capability: "database",
            destructive: true,
            plainLanguage: "This can permanently delete order records.",
            backupReference: "backup_old"
          }
        }],
        logs: ["prepared delete"],
        metadata: {}
      }
    };

    const agent = await createAgent({
      databasePolicy: {
        access: "write_destructive",
        allowRawSql: false,
        allowSchemaChanges: false,
        allowBackupRestore: false,
        backupPolicy: {
          requireFreshBackupBeforeDestructive: true,
          maxBackupAgeMinutes: 30,
          requireOperatorAcknowledgement: true
        }
      }
    });
    const task = await createTask(agent.id);

    const runResponse = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/run`,
      headers: authHeaders
    });
    assert.equal(runResponse.statusCode, 200);

    const taskDetails = await app.inject({
      method: "GET",
      url: `/tasks/${task.id}`,
      headers: authHeaders
    });
    const parsed = taskDetails.json() as {
      task: { lastResponse?: { actions: Array<{ summary: string }> } };
      approvals: Array<{ id: string }>;
    };
    assert.match(parsed.task.lastResponse?.actions[0]?.summary ?? "", /older than 30 minutes/);

    const approvalAttempt = await app.inject({
      method: "POST",
      url: `/approvals/${parsed.approvals[0]?.id}/approve`,
      headers: authHeaders,
      payload: { acknowledgeRisk: true }
    });
    assert.equal(approvalAttempt.statusCode, 400);
    assert.match(approvalAttempt.body, /Blocked actions cannot be approved/);
  });
});

describe("scheduler", () => {
  test("runs due scheduled tasks after timestamp normalization", async () => {
    const agent = await createAgent();
    const task = await createTask(agent.id, { scheduledAt: "2000-01-01T00:00" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${task.id}`,
      headers: authHeaders
    });
    const parsed = response.json() as { task: { status: string } };
    assert.equal(parsed.task.status, "approval_required");
  });
});

describe("production boundary", () => {
  test("omits dev reset route when disabled", async () => {
    process.env.OPERATORBOARD_ENABLE_DEV_ROUTES = "false";
    const { buildApp: buildProductionApp } = await import("./index.js");
    const productionApp = await buildProductionApp({
      logger: false,
      startScheduler: false
    });

    try {
      const response = await productionApp.inject({
        method: "POST",
        url: "/dev/reset",
        headers: authHeaders
      });
      assert.equal(response.statusCode, 404);
    } finally {
      await productionApp.close();
      process.env.OPERATORBOARD_ENABLE_DEV_ROUTES = "true";
    }
  });
});

describe("backup attestation integrations", () => {
  test("accepts a signed integration attestation", async () => {
    const payload = {
      system: "aws-rds-prod",
      scope: "billing",
      reference: "rds-snapshot-001",
      verifiedAt: new Date().toISOString(),
      source: "integration",
      metadata: { region: "us-east-1" }
    };
    const timestamp = String(Date.now());
    const signature = signIntegrationPayload(timestamp, payload);

    const response = await app.inject({
      method: "POST",
      url: "/backup-attestations/integrations/aws_rds",
      headers: {
        ...authHeaders,
        "x-operatorboard-timestamp": timestamp,
        "x-operatorboard-signature": signature
      },
      payload
    });

    assert.equal(response.statusCode, 201);
    const parsed = response.json() as { source: string; metadata: Record<string, unknown> };
    assert.equal(parsed.source, "integration");
    assert.equal(parsed.metadata.provider, "aws_rds");
  });

  test("rejects invalid integration signatures", async () => {
    const payload = {
      system: "aws-rds-prod",
      scope: "billing",
      reference: "rds-snapshot-002",
      verifiedAt: new Date().toISOString(),
      source: "integration",
      metadata: {}
    };
    const response = await app.inject({
      method: "POST",
      url: "/backup-attestations/integrations/aws_rds",
      headers: {
        ...authHeaders,
        "x-operatorboard-timestamp": String(Date.now()),
        "x-operatorboard-signature": "bad-signature"
      },
      payload
    });

    assert.equal(response.statusCode, 401);
    assert.match(response.body, /Invalid integration signature/);
  });

  test("rejects replayed integration requests", async () => {
    const payload = {
      system: "aws-rds-prod",
      scope: "billing",
      reference: "rds-snapshot-replay",
      verifiedAt: new Date().toISOString(),
      source: "integration",
      metadata: {}
    };
    const timestamp = String(Date.now());
    const signature = signIntegrationPayload(timestamp, payload);

    const first = await app.inject({
      method: "POST",
      url: "/backup-attestations/integrations/aws_rds",
      headers: { ...authHeaders, "x-operatorboard-timestamp": timestamp, "x-operatorboard-signature": signature },
      payload
    });
    assert.equal(first.statusCode, 201);

    const replay = await app.inject({
      method: "POST",
      url: "/backup-attestations/integrations/aws_rds",
      headers: { ...authHeaders, "x-operatorboard-timestamp": timestamp, "x-operatorboard-signature": signature },
      payload
    });
    assert.equal(replay.statusCode, 401);
    assert.match(replay.body, /Replayed/);
  });

  test("manual attestation path cannot spoof integration provenance", async () => {
    // An operator posting to the unsigned /backup-attestations endpoint with source:"integration"
    // must have the server downgrade it to "manual" — integration provenance requires the signed path.
    const response = await app.inject({
      method: "POST",
      url: "/backup-attestations",
      headers: authHeaders,
      payload: {
        system: "aws-rds-prod",
        scope: "billing",
        reference: "attempted-spoof-ref",
        verifiedAt: new Date().toISOString(),
        source: "integration",   // attacker claims integration provenance
        metadata: {}
      }
    });
    assert.equal(response.statusCode, 201);
    const parsed = response.json() as { source: string };
    assert.equal(parsed.source, "manual");
  });

  test("rejects cross-provider signature replay", async () => {
    // A signature computed for aws_rds must not validate against a different provider endpoint.
    const payload = {
      system: "aws-rds-prod",
      scope: "billing",
      reference: "cross-provider-ref",
      verifiedAt: new Date().toISOString(),
      source: "integration",
      metadata: {}
    };
    const timestamp = String(Date.now());
    // Sign for aws_rds but submit to a (hypothetical) second provider sharing the same secret.
    // Since the secret is provider-specific, this also implicitly tests the binding —
    // use the wrong provider name in the canonical string so we get a definitive mismatch.
    const signatureForWrongProvider = signIntegrationPayload(timestamp, payload, "other_provider");

    const response = await app.inject({
      method: "POST",
      url: "/backup-attestations/integrations/aws_rds",
      headers: {
        ...authHeaders,
        "x-operatorboard-timestamp": timestamp,
        "x-operatorboard-signature": signatureForWrongProvider
      },
      payload
    });
    assert.equal(response.statusCode, 401);
    assert.match(response.body, /Invalid integration signature/);
  });

  test("rejects future-dated integration timestamps", async () => {
    const payload = {
      system: "aws-rds-prod",
      scope: "billing",
      reference: "future-ts-ref",
      verifiedAt: new Date().toISOString(),
      source: "integration",
      metadata: {}
    };
    // Timestamp 10 minutes in the future — well beyond the 30-second clock-skew allowance.
    const futureTimestamp = String(Date.now() + 10 * 60 * 1000);
    const signature = signIntegrationPayload(futureTimestamp, payload);

    const response = await app.inject({
      method: "POST",
      url: "/backup-attestations/integrations/aws_rds",
      headers: {
        ...authHeaders,
        "x-operatorboard-timestamp": futureTimestamp,
        "x-operatorboard-signature": signature
      },
      payload
    });
    assert.equal(response.statusCode, 401);
    assert.match(response.body, /Stale or invalid/);
  });
});

describe("constraint enforcement", () => {
  test("blocks network actions when allowNetwork is false (default)", async () => {
    agentResponse = {
      status: 200,
      body: {
        taskId: "placeholder",
        status: "proposal_ready",
        summary: "Agent wants to fetch data.",
        actions: [{
          id: "net_action",
          type: "http.get",
          risk: "medium",
          requiresApproval: false,
          summary: "Fetch external API.",
          payload: { url: "https://example.com/data" },
          safety: { capability: "general", destructive: false }
        }],
        logs: ["fetching"],
        metadata: {}
      }
    };

    const agent = await createAgent();
    const task = await createTask(agent.id);
    await app.inject({ method: "POST", url: `/tasks/${task.id}/run`, headers: authHeaders });

    const details = await app.inject({ method: "GET", url: `/tasks/${task.id}`, headers: authHeaders });
    const parsed = details.json() as { task: { lastResponse?: { actions: Array<{ summary: string }> } } };
    assert.match(parsed.task.lastResponse?.actions[0]?.summary ?? "", /BLOCKED.*allowNetwork/);
  });

  test("blocks case-variant action types (uppercase bypass attempt)", async () => {
    agentResponse = {
      status: 200,
      body: {
        taskId: "placeholder",
        status: "proposal_ready",
        summary: "Agent tries uppercase shell action.",
        actions: [{
          id: "shell_upper",
          type: "SHELL.EXEC",
          risk: "critical",
          requiresApproval: false,
          summary: "Run shell command.",
          payload: { command: "ls -la" },
          safety: { capability: "general", destructive: false }
        }],
        logs: ["attempting shell"],
        metadata: {}
      }
    };

    const agent = await createAgent();
    const task = await createTask(agent.id);
    await app.inject({ method: "POST", url: `/tasks/${task.id}/run`, headers: authHeaders });

    const details = await app.inject({ method: "GET", url: `/tasks/${task.id}`, headers: authHeaders });
    const parsed = details.json() as { task: { lastResponse?: { actions: Array<{ summary: string }> } } };
    assert.match(parsed.task.lastResponse?.actions[0]?.summary ?? "", /BLOCKED.*allowShell/);
  });

  test("blocks re-run of task awaiting approvals", async () => {
    const agent = await createAgent();
    const task = await createTask(agent.id);
    await app.inject({ method: "POST", url: `/tasks/${task.id}/run`, headers: authHeaders });

    const details = await app.inject({ method: "GET", url: `/tasks/${task.id}`, headers: authHeaders });
    const parsed = details.json() as { task: { status: string } };
    assert.equal(parsed.task.status, "approval_required");

    const rerun = await app.inject({ method: "POST", url: `/tasks/${task.id}/run`, headers: authHeaders });
    assert.equal(rerun.statusCode, 400);
    assert.match(rerun.body, /approval_required/);
  });

  test("blocks rescheduling a task awaiting approvals", async () => {
    const agent = await createAgent();
    const task = await createTask(agent.id);
    await app.inject({ method: "POST", url: `/tasks/${task.id}/run`, headers: authHeaders });

    const reschedule = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/schedule`,
      headers: authHeaders,
      payload: { scheduledAt: "2099-01-01T00:00:00Z" }
    });
    assert.equal(reschedule.statusCode, 400);
    assert.match(reschedule.body, /approval_required/);
  });

  test("rejects agent with localhost webhook URL", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      headers: authHeaders,
      payload: {
        name: "SSRFBot",
        role: "Tester",
        adapterType: "http",
        endpoint: "http://agent.local/task",
        executionMode: "propose",
        webhookUrl: "http://localhost/steal-data"
      }
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /webhookUrl rejected/);
  });

  test("rejects agent with private IP webhook URL", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      headers: authHeaders,
      payload: {
        name: "SSRFBot2",
        role: "Tester",
        adapterType: "http",
        endpoint: "http://agent.local/task",
        executionMode: "propose",
        webhookUrl: "http://169.254.169.254/latest/meta-data/"
      }
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /webhookUrl rejected/);
  });
});
