import Fastify from "fastify";
import { taskRequestSchema } from "@operatorboard/shared";

const app = Fastify({
  logger: true
});

app.get("/health", async () => {
  return {
    ok: true,
    name: "operatorboard-mock-agent",
    version: "0.1.0"
  };
});

app.post("/task", async (request, reply) => {
  const task = taskRequestSchema.parse(request.body);

  return reply.status(200).send({
    taskId: task.taskId,
    status: "proposal_ready",
    summary: `Mock agent reviewed task: ${task.title}`,
    actions: [
      {
        id: `action_${crypto.randomUUID()}`,
        type: "operator.note",
        risk: "medium",
        requiresApproval: true,
        summary: "Mock agent proposes creating an operator note for this task.",
        payload: {
          note: `Proposed next step for: ${task.description}`
        }
      }
    ],
    logs: [
      "Mock agent received task.",
      `Execution mode: ${task.mode}`,
      `Network allowed: ${task.constraints.allowNetwork}`,
      `Shell allowed: ${task.constraints.allowShell}`
    ],
    metadata: {
      adapter: "mock-http",
      runtime: "local"
    }
  });
});

const port = Number(process.env.MOCK_AGENT_PORT ?? 4200);
const host = process.env.MOCK_AGENT_HOST ?? "127.0.0.1";

await app.listen({
  port,
  host
});
