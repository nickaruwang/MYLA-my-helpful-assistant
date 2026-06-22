import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { appendAuditEvent, verifyAuditChain } from "@jarvis/audit";
import {
  deleteMemoryFact,
  ensureSession,
  getApproval,
  getToolProposal,
  listMemoryFacts,
  listMessages,
  listPendingApprovals,
  listSessions,
  migrate,
  nowIso,
  openDatabase,
  searchMemoryFacts,
  storeApproval,
  storeMemoryFact,
  storeMessage,
  storeToolProposal,
  updateApprovalStatus,
  updateToolProposalStatus
} from "@jarvis/db";
import { classifyIntent } from "@jarvis/policy";
import {
  ApprovalDecisionRequestSchema,
  ChatRequestSchema,
  MemoryCreateRequestSchema,
  type ApprovalRequest,
  type MemoryFact,
  type ToolResult
} from "@jarvis/shared";
import {
  executeRegisteredTool,
  getGoogleAuthUrl,
  GOOGLE_SAFE_SCOPES,
  hasGoogleOAuthConfig,
  listPublicTools,
  proposeAndMaybeExecuteTool,
  registerDefaultTools,
  saveGoogleTokensFromCode
} from "@jarvis/tools";
import { callMlWorker, embedText } from "./modelClient.js";
import { inferToolIntent } from "./toolIntent.js";

const app = new Hono();
const db = await openDatabase();

await migrate(db);
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
    storage: "mongodb",
    mlWorkerUrl: process.env.ML_WORKER_URL ?? "http://localhost:8001"
  })
);

app.get("/tools", (c) =>
  c.json({
    tools: listPublicTools()
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

app.get("/sessions", async (c) => c.json({ sessions: await listSessions(db) }));

app.get("/sessions/:sessionId/messages", async (c) => {
  const sessionId = c.req.param("sessionId");
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json({ messages: await listMessages(db, sessionId, limit) });
});

app.get("/approvals", async (c) => c.json({ approvals: await listPendingApprovals(db) }));

app.post("/approvals/:approvalId/decision", async (c) => {
  const approvalId = c.req.param("approvalId");
  const parsed = ApprovalDecisionRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const approval = await getApproval(db, approvalId);
  if (!approval) {
    return c.json({ error: "Approval not found." }, 404);
  }

  if (approval.status !== "pending") {
    return c.json({ error: `Approval is already ${approval.status}.` }, 409);
  }

  const now = nowIso();
  if (new Date(approval.expiresAt).getTime() < Date.now()) {
    await updateApprovalStatus(db, approval.id, "expired", now);
    await updateToolProposalStatus(db, approval.proposalId, "blocked", { decidedAt: now });
    return c.json({ error: "Approval expired." }, 410);
  }

  const proposal = await getToolProposal(db, approval.proposalId);
  if (!proposal) {
    return c.json({ error: "Tool proposal not found." }, 404);
  }

  if (proposal.status === "executed") {
    return c.json({ error: "Tool proposal has already executed." }, 409);
  }

  const decisionStatus = parsed.data.decision === "approved" ? "approved" : "rejected";
  await updateApprovalStatus(db, approval.id, decisionStatus, now);
  await updateToolProposalStatus(db, proposal.id, decisionStatus, { decidedAt: now });
  await appendAuditEvent(db, {
    actor: "user",
    kind: "approval.decided",
    correlationId: proposal.correlationId,
    payload: {
      approvalId: approval.id,
      proposalId: proposal.id,
      decision: parsed.data.decision,
      reason: parsed.data.reason
    }
  });

  if (parsed.data.decision === "rejected") {
    return c.json({
      approval: { ...approval, status: "rejected", decidedAt: now },
      toolResult: {
        proposalId: proposal.id,
        toolName: proposal.toolName,
        status: "blocked",
        notification: `Rejected: ${proposal.dryRunSummary}`
      } satisfies ToolResult
    });
  }

  const toolResult = await executeRegisteredTool(proposal);
  await updateToolProposalStatus(db, proposal.id, toolResult.status === "executed" ? "executed" : "failed", {
    executedAt: nowIso()
  });
  await appendAuditEvent(db, {
    actor: "tool",
    kind: toolResult.status === "executed" ? "tool.executed" : "tool.policy_decision",
    correlationId: proposal.correlationId,
    payload: {
      proposalId: proposal.id,
      status: toolResult.status,
      notification: toolResult.notification
    }
  });

  return c.json({
    approval: { ...approval, status: "approved", decidedAt: now },
    toolResult
  });
});

app.get("/memory", async (c) => c.json({ facts: await listMemoryFacts(db) }));

app.get("/memory/search", async (c) => {
  const query = c.req.query("q") ?? "";
  const embedding = await embedText(query);
  return c.json({ facts: await searchMemoryFacts(db, query, { embedding }) });
});

app.post("/memory", async (c) => {
  const parsed = MemoryCreateRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const fact = await createMemoryFact({
    subject: parsed.data.subject,
    predicate: parsed.data.predicate,
    object: parsed.data.object,
    confidence: parsed.data.confidence,
    sourceMessageId: null
  });
  await appendAuditEvent(db, {
    actor: "user",
    kind: "memory.stored",
    correlationId: crypto.randomUUID(),
    payload: { factId: fact.id, subject: fact.subject, predicate: fact.predicate }
  });

  return c.json({ fact });
});

app.delete("/memory/:factId", async (c) => {
  const deleted = await deleteMemoryFact(db, c.req.param("factId"));
  if (deleted) {
    await appendAuditEvent(db, {
      actor: "user",
      kind: "memory.deleted",
      correlationId: crypto.randomUUID(),
      payload: { factId: c.req.param("factId") }
    });
  }

  return c.json({ deleted });
});

app.get("/voice/status", async (c) => {
  const baseUrl = process.env.ML_WORKER_URL ?? "http://localhost:8001";
  try {
    const response = await fetch(`${baseUrl}/voice/status`);
    return c.json(await response.json());
  } catch {
    return c.json({ mode: "disabled", ready: false, notes: ["ML worker voice status is unavailable."] });
  }
});

app.get("/audit/verify", async (c) => c.json(await verifyAuditChain(db)));

app.post("/chat", async (c) => {
  const parsed = ChatRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const correlationId = crypto.randomUUID();
  const sessionId = await ensureSession(db, parsed.data.sessionId);
  const policy = classifyIntent({ text: parsed.data.message });

  await appendAuditEvent(db, {
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

  const userMessage = await storeMessage(db, {
    sessionId,
    actor: "user",
    content: parsed.data.message,
    correlationId
  });

  await appendAuditEvent(db, {
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

    await storeToolProposal(db, decision.proposal);
    if (decision.result.status === "executed" || decision.result.status === "failed") {
      await updateToolProposalStatus(db, decision.proposal.id, decision.result.status, { executedAt: nowIso() });
    }
    await appendAuditEvent(db, {
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
      await storeApproval(db, decision.approval);
      approvals.push(decision.approval);
      await appendAuditEvent(db, {
        actor: "system",
        kind: "approval.created",
        correlationId,
        payload: { approvalId: decision.approval.id, proposalId: decision.proposal.id }
      });
    }

    toolResults.push(decision.result);
    await appendAuditEvent(db, {
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

  const recentMessages = await listMessages(db, sessionId, 12);
  const memoryEmbedding = await embedText(parsed.data.message);
  const memories = await searchMemoryFacts(db, parsed.data.message, { embedding: memoryEmbedding });
  const modelResponse = await callMlWorker({
    prompt: buildPrompt(parsed.data.message, toolResults, memories),
    sessionId,
    correlationId,
    retrievedContext: [
      ...recentMessages.map((message) => `${message.actor}: ${message.content}`),
      ...memories.map((memory) => `memory: ${memory.subject} ${memory.predicate} ${memory.object}`)
    ],
    privacyClass: policy.privacyClass,
    route: policy.modelRoute,
    preferredModel: parsed.data.preferredModel
  });

  await appendAuditEvent(db, {
    actor: "system",
    kind: "model.completed",
    correlationId,
    payload: {
      model: modelResponse.model,
      route: modelResponse.route,
      toolResultCount: toolResults.length
    }
  });

  const assistantMessage = await storeMessage(db, {
    sessionId,
    actor: "assistant",
    content: modelResponse.text,
    correlationId
  });

  const storedMemories = await maybeStoreMemoryFromMessage(parsed.data.message, userMessage.id, correlationId);

  return c.json({
    sessionId,
    correlationId,
    message: assistantMessage,
    toolResults,
    approvals,
    memories,
    storedMemories
  });
});

app.post("/chat/stream", async (c) => {
  const payload = await c.req.json();
  const response = await app.request("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();

  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
        controller.close();
      }
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      }
    }
  );
});

async function maybeStoreMemoryFromMessage(
  message: string,
  sourceMessageId: string,
  correlationId: string
): Promise<MemoryFact[]> {
  const extracted = extractMemoryCandidates(message, sourceMessageId);
  const stored: MemoryFact[] = [];

  for (const fact of extracted) {
    const embedding = await embedText(`${fact.subject} ${fact.predicate} ${fact.object}`);
    const storedFact = await storeMemoryFact(db, fact, embedding);
    stored.push(storedFact);
    await appendAuditEvent(db, {
      actor: "system",
      kind: "memory.stored",
      correlationId,
      payload: { factId: fact.id, subject: fact.subject, predicate: fact.predicate }
    });
  }

  return stored;
}

function extractMemoryCandidates(message: string, sourceMessageId: string): MemoryFact[] {
  const candidates: Array<{ predicate: string; object: string }> = [];
  const rememberMatch = message.match(/\bremember that\s+(.+)$/i);
  if (rememberMatch?.[1]) {
    candidates.push({ predicate: "remembered", object: rememberMatch[1].trim() });
  }

  const preferenceMatch = message.match(/\bmy\s+([a-z][a-z\s]{1,40})\s+is\s+(.+)$/i);
  if (preferenceMatch?.[1] && preferenceMatch[2]) {
    candidates.push({ predicate: preferenceMatch[1].trim().replace(/\s+/g, "_"), object: preferenceMatch[2].trim() });
  }

  const now = nowIso();
  return candidates.map((candidate) => ({
    id: crypto.randomUUID(),
    subject: "user",
    predicate: candidate.predicate,
    object: candidate.object,
    sourceMessageId,
    confidence: 0.75,
    embeddingId: null,
    createdAt: now,
    updatedAt: now
  }));
}

async function createMemoryFact(input: {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  sourceMessageId: string | null;
}): Promise<MemoryFact> {
  const now = nowIso();
  const fact: MemoryFact = {
    id: crypto.randomUUID(),
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    sourceMessageId: input.sourceMessageId,
    confidence: input.confidence,
    embeddingId: null,
    createdAt: now,
    updatedAt: now
  };
  const embedding = await embedText(`${fact.subject} ${fact.predicate} ${fact.object}`);
  return storeMemoryFact(db, fact, embedding);
}

function buildPrompt(userMessage: string, toolResults: ToolResult[], memories: MemoryFact[]): string {
  const sections = [userMessage];

  const toolContext = toolResults
    .map((result) => `Tool ${result.toolName} returned ${result.status}: ${result.notification}`)
    .join("\n");
  if (toolContext) {
    sections.push(`Tool context:\n${toolContext}`);
  }

  const memoryContext = memories
    .map((memory) => `${memory.subject} ${memory.predicate} ${memory.object}`)
    .join("\n");
  if (memoryContext) {
    sections.push(`Relevant memory:\n${memoryContext}`);
  }

  return sections.join("\n\n");
}

const port = Number(process.env.API_PORT ?? 3000);
serve({ fetch: app.fetch, port });

console.log(`JARVIS API listening on http://localhost:${port}`);
