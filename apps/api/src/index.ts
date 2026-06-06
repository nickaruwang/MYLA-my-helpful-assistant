import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { appendAuditEvent, verifyAuditChain } from "@jarvis/audit";
import {
  ensureSession,
  listMessages,
  listPendingApprovals,
  migrate,
  openDatabase,
  storeApproval,
  storeMessage,
  storeToolProposal
} from "@jarvis/db";
import { classifyIntent } from "@jarvis/policy";
import { ChatRequestSchema, type ApprovalRequest, type ToolResult } from "@jarvis/shared";
import {
  getGoogleAuthUrl,
  GOOGLE_SAFE_SCOPES,
  hasGoogleOAuthConfig,
  listTools,
  proposeAndMaybeExecuteTool,
  registerDefaultTools,
  saveGoogleTokensFromCode
} from "@jarvis/tools";
import { callMlWorker } from "./modelClient.js";
import { inferToolIntent } from "./toolIntent.js";

const app = new Hono();
const db = openDatabase();

migrate(db);
registerDefaultTools();

app.use("*", async (c, next) => {
  c.header("access-control-allow-origin", process.env.WEB_ORIGIN ?? "http://localhost:5173");
  c.header("access-control-allow-methods", "GET,POST,OPTIONS");
  c.header("access-control-allow-headers", "content-type");

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  await next();
});

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "jarvis-api",
    mlWorkerUrl: process.env.ML_WORKER_URL ?? "http://localhost:8001"
  })
);

app.get("/tools", (c) =>
  c.json({
    tools: listTools().map((tool) => ({
      name: tool.name,
      operation: tool.operation,
      description: tool.description
    }))
  })
);

app.get("/oauth/google/start", (c) => {
  if (!hasGoogleOAuthConfig()) {
    return c.json(
      {
        error: "Google OAuth config is missing.",
        requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"],
        scopes: GOOGLE_SAFE_SCOPES
      },
      400
    );
  }

  return c.redirect(getGoogleAuthUrl());
});

app.get("/oauth/google/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.json({ error: "Missing OAuth code." }, 400);
  }

  await saveGoogleTokensFromCode(code);
  return c.text("Google OAuth token saved. You can close this tab.");
});

app.get("/approvals", (c) => c.json({ approvals: listPendingApprovals(db) }));

app.get("/audit/verify", (c) => c.json(verifyAuditChain(db)));

app.post("/chat", async (c) => {
  const parsed = ChatRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const correlationId = crypto.randomUUID();
  const sessionId = ensureSession(db, parsed.data.sessionId);
  const policy = classifyIntent({ text: parsed.data.message });

  appendAuditEvent(db, {
    actor: "user",
    kind: "request.received",
    correlationId,
    payload: {
      sessionId,
      privacyClass: policy.privacyClass,
      riskLevel: policy.riskLevel,
      reasons: policy.reasons
    }
  });

  const userMessage = storeMessage(db, {
    sessionId,
    actor: "user",
    content: parsed.data.message,
    correlationId
  });

  appendAuditEvent(db, {
    actor: "system",
    kind: "message.stored",
    correlationId,
    payload: { messageId: userMessage.id, actor: userMessage.actor }
  });

  const toolResults: ToolResult[] = [];
  const approvals: ApprovalRequest[] = [];
  const inferredTool = inferToolIntent(parsed.data.message);

  if (inferredTool) {
    const decision = await proposeAndMaybeExecuteTool({
      sessionId,
      correlationId,
      toolName: inferredTool.toolName,
      args: inferredTool.args
    });

    storeToolProposal(db, decision.proposal);
    appendAuditEvent(db, {
      actor: "system",
      kind: "tool.proposed",
      correlationId,
      payload: {
        proposalId: decision.proposal.id,
        toolName: decision.proposal.toolName,
        riskLevel: decision.proposal.riskLevel,
        approvalMode: decision.proposal.approvalMode
      }
    });

    if (decision.approval) {
      storeApproval(db, decision.approval);
      approvals.push(decision.approval);
      appendAuditEvent(db, {
        actor: "system",
        kind: "approval.created",
        correlationId,
        payload: { approvalId: decision.approval.id, proposalId: decision.proposal.id }
      });
    }

    toolResults.push(decision.result);
    appendAuditEvent(db, {
      actor: "tool",
      kind: decision.result.status === "executed" ? "tool.executed" : "tool.policy_decision",
      correlationId,
      payload: {
        proposalId: decision.proposal.id,
        status: decision.result.status,
        notification: decision.result.notification
      }
    });
  }

  const recentMessages = listMessages(db, sessionId, 12);
  const modelResponse = await callMlWorker({
    prompt: buildPrompt(parsed.data.message, toolResults),
    sessionId,
    correlationId,
    retrievedContext: recentMessages.map((message) => `${message.actor}: ${message.content}`),
    privacyClass: policy.privacyClass,
    route: policy.modelRoute,
    preferredModel: parsed.data.preferredModel
  });

  appendAuditEvent(db, {
    actor: "system",
    kind: "model.completed",
    correlationId,
    payload: {
      model: modelResponse.model,
      route: modelResponse.route,
      toolResultCount: toolResults.length
    }
  });

  const assistantMessage = storeMessage(db, {
    sessionId,
    actor: "assistant",
    content: modelResponse.text,
    correlationId
  });

  return c.json({
    sessionId,
    correlationId,
    message: assistantMessage,
    toolResults,
    approvals
  });
});

function buildPrompt(userMessage: string, toolResults: ToolResult[]): string {
  if (toolResults.length === 0) {
    return userMessage;
  }

  const toolContext = toolResults
    .map((result) => `Tool ${result.toolName} returned ${result.status}: ${result.notification}`)
    .join("\n");

  return `${userMessage}\n\nTool context:\n${toolContext}`;
}

const port = Number(process.env.API_PORT ?? 3000);
serve({ fetch: app.fetch, port });

console.log(`JARVIS API listening on http://localhost:${port}`);
