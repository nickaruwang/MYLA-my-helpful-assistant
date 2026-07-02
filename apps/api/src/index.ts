import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { appendAuditEvent, verifyAuditChain } from "@myla/audit";
import {
  deleteMemoryFact,
  ensureSession,
  getApproval,
  getActiveToolTask,
  getToolProposal,
  listMemoryFacts,
  listMessages,
  listPendingApprovals,
  listPlannerTraces,
  listSessions,
  listToolTasks,
  migrate,
  nowIso,
  openDatabase,
  searchMemoryFacts,
  storeApproval,
  storeMemoryFact,
  storeMessage,
  createToolTask,
  updateAgentRun,
  updateApprovalStatus,
  updateToolProposalStatus,
  updateSessionTitleIfEmpty,
  updateToolTask,
  updateToolTaskByProposalId
} from "@myla/db";
import { classifyIntent } from "@myla/policy";
import {
  ApprovalDecisionRequestSchema,
  ChatRequestSchema,
  MemoryCreateRequestSchema,
  type ApprovalRequest,
  type ChatMessage,
  type MemoryFact,
  type ToolTask,
  type ToolResult
} from "@myla/shared";
import {
  executeRegisteredTool,
  getGoogleAuthUrl,
  GOOGLE_SAFE_SCOPES,
  hasGoogleOAuthConfig,
  listPublicTools,
  listProviderStatuses,
  proposeAndMaybeExecuteTool,
  registerDefaultTools,
  saveGoogleTokensFromCode
} from "@myla/tools";
import { callMlWorker, embedText } from "./modelClient.js";
import { rejectAgentRunApproval, resumeAgentRunAfterApproval, startAgentRun } from "./agentRunner.js";

const app = new Hono();
const db = await openDatabase();

await migrate(db);
registerDefaultTools();

app.use("*", async (c, next) => {
  const startedAt = Date.now();
  c.header("access-control-allow-origin", process.env.WEB_ORIGIN ?? c.req.header("origin") ?? "http://localhost:5173");
  c.header("access-control-allow-methods", "GET,POST,OPTIONS");
  c.header("access-control-allow-headers", "content-type");
  c.header("vary", "Origin");

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  await next();
  console.log(`${c.req.method} ${new URL(c.req.url).pathname} -> ${c.res.status} ${Date.now() - startedAt}ms`);
});

app.onError((error, c) => {
  const requestId = crypto.randomUUID();
  console.error(`API error ${requestId} ${c.req.method} ${new URL(c.req.url).pathname}`, error);
  return c.json(
    {
      error: "Internal server error",
      requestId,
      message: error instanceof Error ? error.message : "Unknown error"
    },
    500
  );
});

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "myla-api",
    storage: "mongodb",
    mlWorkerUrl: process.env.ML_WORKER_URL ?? "http://localhost:8001"
  })
);

app.get("/tools", (c) =>
  c.json({
    tools: listPublicTools()
  })
);

app.get("/providers", (c) =>
  c.json({
    providers: listProviderStatuses()
  })
);

app.get("/tasks", async (c) => c.json({ tasks: await listToolTasks(db, undefined, Number(c.req.query("limit") ?? 50)) }));

app.get("/sessions/:sessionId/tasks", async (c) =>
  c.json({ tasks: await listToolTasks(db, c.req.param("sessionId"), Number(c.req.query("limit") ?? 50)) })
);

app.get("/planner-traces", async (c) =>
  c.json({ traces: await listPlannerTraces(db, c.req.query("sessionId") ?? undefined, Number(c.req.query("limit") ?? 50)) })
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

app.get("/approvals", async (c) => {
  const approvals = await listActivePendingApprovals();

  return c.json({ approvals });
});

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
    await updateToolTaskByProposalId(db, proposal.id, {
      status: "blocked",
      resultStatus: "blocked",
      resultNotification: `Rejected: ${proposal.dryRunSummary}`
    });
    const agentRun = await rejectAgentRunApproval({
      db,
      approval,
      proposal,
      reason: parsed.data.reason
    });
    return c.json({
      approval: { ...approval, status: "rejected", decidedAt: now },
      agentRun,
      toolResult: {
        proposalId: proposal.id,
        toolName: proposal.toolName,
        status: "blocked",
        notification: `Rejected: ${proposal.dryRunSummary}`
      } satisfies ToolResult
    });
  }

  const toolResult = await executeRegisteredTool(proposal);
  await updateToolProposalStatus(db, proposal.id, proposalStatusForToolResult(toolResult), {
    executedAt: nowIso()
  });
  await updateToolTaskByProposalId(db, proposal.id, {
    status: taskStatusForToolResult(toolResult),
    resultStatus: toolResult.status,
    resultNotification: toolResult.notification
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

  const resumePolicy = classifyIntent({ text: proposal.dryRunSummary });
  const resumeMessages = await listMessages(db, proposal.sessionId, 10);
  const resumed = await resumeAgentRunAfterApproval({
    db,
    approval: { ...approval, status: "approved", decidedAt: now },
    proposal,
    toolResult,
    privacyClass: resumePolicy.privacyClass,
    route: resumePolicy.modelRoute,
    conversationContext: resumeMessages.slice(-8).map((message) => ({
      actor: message.actor,
      content: message.content,
      createdAt: message.createdAt
    }))
  });
  let message: ChatMessage | undefined;
  if (resumed?.finalMessage) {
    message = await storeMessage(db, {
      sessionId: proposal.sessionId,
      actor: "assistant",
      content: resumed.finalMessage,
      correlationId: proposal.correlationId
    });
    await updateAgentRun(db, resumed.run.id, { outputMessageId: message.id });
    await appendAuditEvent(db, {
      actor: "system",
      kind: "model.completed",
      correlationId: proposal.correlationId,
      payload: {
        model: `agent-${resumed.status}`,
        route: "local",
        toolResultCount: resumed.toolResults.length
      }
    });
  }
  const storedMemories = resumed
    ? await maybeStoreMemoryFromToolResults(resumed.toolResults, proposal.correlationId)
    : await maybeStoreMemoryFromToolResults([toolResult], proposal.correlationId);

  return c.json({
    approval: { ...approval, status: "approved", decidedAt: now },
    toolResult,
    resumed,
    message,
    storedMemories
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
    category: parsed.data.category,
    sensitivity: parsed.data.sensitivity,
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

app.get("/audit/events", async (c) => {
  const correlationId = c.req.query("correlationId");
  const events = await db.auditEvents
    .find(correlationId ? { correlationId } : {}, { projection: { _id: 0 } })
    .sort({ seq: -1 })
    .limit(Number(c.req.query("limit") ?? 50))
    .toArray();
  return c.json({ events });
});

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
  await updateSessionTitleIfEmpty(db, sessionId, summarizeSessionTitle(parsed.data.message));

  await appendAuditEvent(db, {
    actor: "system",
    kind: "message.stored",
    correlationId,
    payload: { messageId: userMessage.id, actor: userMessage.actor }
  });

  const planningMessages = await listMessages(db, sessionId, 10);
  const activeTask = await getActiveToolTask(db, sessionId);
  const conversationContext = buildPlanningContext(planningMessages, userMessage);
  if (activeTask) {
    conversationContext.push({
      actor: "system",
      content: `Active tool task: ${activeTask.toolName ?? "unknown tool"} with draft args ${JSON.stringify(
        activeTask.draftArgs
      )}, missing fields ${activeTask.missingFields.join(", ") || "none"}, assumptions ${
        activeTask.assumptions.join("; ") || "none"
      }.`,
      createdAt: activeTask.updatedAt
    });
  }
  const isClarificationAnswer =
    activeTask?.status === "needs_clarification" && /^For the pending .+?:\s+/i.test(parsed.data.message);

  if (isClarificationAnswer) {
    await updateToolTask(db, activeTask.id, {
      status: "cancelled",
      missingFields: [],
      resultNotification: "Clarification answered; MYLA continued with the updated details."
    });
  }

  const agentResult = await startAgentRun({
    db,
    sessionId,
    correlationId,
    goal: parsed.data.message,
    inputMessageId: userMessage.id,
    privacyClass: policy.privacyClass,
    route: policy.modelRoute,
    preferredModel: parsed.data.preferredModel,
    conversationContext
  });
  const toolResults = agentResult.toolResults;
  const approvals = agentResult.approvals;
  const tasks = agentResult.tasks;

  const directToolResponse = buildDirectToolResponse(toolResults);
  let memories: Awaited<ReturnType<typeof searchMemoryFacts>> = [];
  let assistantText = agentResult.finalMessage ?? directToolResponse;
  let assistantSource = agentResult.finalMessage ? `agent-${agentResult.status}` : directToolResponse ? "direct-tool-response" : undefined;

  if (!assistantText && agentResult.status === "none") {
    assistantText = buildNoToolActionResponse(parsed.data.message, conversationContext);
    assistantSource = assistantText ? "action-guard" : undefined;
    if (assistantText) {
      tasks.push(
        await createToolTask(db, {
          sessionId,
          correlationId,
          toolName: null,
          status: "blocked",
          validationErrors: [agentResult.noneReason ?? "No matching agent step."],
          resultStatus: "blocked",
          resultNotification: assistantText
        })
      );
    }
  }

  if (!assistantText) {
    const recentMessages = await listMessages(db, sessionId, 12);
    const memoryEmbedding = await embedText(parsed.data.message);
    memories = await searchMemoryFacts(db, parsed.data.message, { embedding: memoryEmbedding });
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
    assistantText = modelResponse.text;

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
  } else {
    await appendAuditEvent(db, {
      actor: "system",
      kind: "model.completed",
      correlationId,
      payload: {
        model: assistantSource ?? "direct-tool-response",
        route: "local",
        toolResultCount: toolResults.length
      }
    });
  }

  const assistantMessage = await storeMessage(db, {
    sessionId,
    actor: "assistant",
    content: assistantText,
    correlationId
  });
  await updateAgentRun(db, agentResult.run.id, { outputMessageId: assistantMessage.id });

  const storedMemories = [
    ...(await maybeStoreMemoryFromToolResults(toolResults, correlationId)),
    ...(await maybeStoreMemoryFromMessage(parsed.data.message, userMessage.id, correlationId))
  ];

  return c.json({
    sessionId,
    correlationId,
    message: assistantMessage,
    toolResults,
    approvals,
    tasks,
    providerStatuses: listProviderStatuses(),
    memories,
    storedMemories
  });
});

app.post("/chat/stream", async (c) => {
  const payload = await c.req.json();
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const sendEvent = (eventName: string, data: unknown) => {
          if (closed) {
            return false;
          }

          try {
            controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`));
            return true;
          } catch {
            closed = true;
            if (heartbeat) {
              clearInterval(heartbeat);
            }
            return false;
          }
        };

        c.req.raw.signal.addEventListener("abort", () => {
          closed = true;
          if (heartbeat) {
            clearInterval(heartbeat);
          }
        });

        sendEvent("status", { message: "Working on it..." });
        heartbeat = setInterval(() => {
          sendEvent("status", { message: "Still working..." });
        }, 10_000);

        try {
          const response = await app.request("/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          });
          const data = await response.json().catch(async () => ({
            error: await response.text()
          }));
          sendEvent(response.ok ? "message" : "error", data);
        } catch (error) {
          sendEvent("error", {
            error: "Stream failed",
            message: error instanceof Error ? error.message : "Unknown error"
          });
        } finally {
          clearInterval(heartbeat);
          closed = true;
          try {
            controller.close();
          } catch {
            // The browser may have already closed the stream after receiving the final event.
          }
        }
      }
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no"
      }
    }
  );
});

function buildPlanningContext(messages: ChatMessage[], currentMessage: ChatMessage) {
  const currentTime = new Date(currentMessage.createdAt).getTime();
  const contextWindowMs = 30 * 60 * 1000;

  return messages
    .filter((message) => message.id !== currentMessage.id)
    .filter((message) => currentTime - new Date(message.createdAt).getTime() <= contextWindowMs)
    .slice(-8)
    .map((message) => ({
      actor: message.actor,
      content: message.content,
      createdAt: message.createdAt
    }));
}

function taskStatusForToolResult(result: ToolResult): ToolTask["status"] {
  if (result.status === "queued_for_approval") {
    return "queued_for_approval";
  }
  if (result.status === "executed") {
    return "executed";
  }
  if (result.status === "blocked") {
    return "blocked";
  }
  return "failed";
}

function summarizeSessionTitle(message: string): string {
  const cleaned = message
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .trim()
    .replace(/[?.!,;:]+$/g, "");

  if (!cleaned) {
    return "New conversation";
  }

  const withoutAssistantName = cleaned.replace(/^(?:hey|hi|hello)?\s*(?:myla|assistant)[,\s]+/i, "").trim() || cleaned;
  const core =
    withoutAssistantName.match(
      /^(?:can you|could you|please|pls|would you|i need you to|help me|tell me|show me|find|search|check|what do i|what's|what is)\s+(.+)$/i
    )?.[1] ?? withoutAssistantName;
  const compact = core
    .replace(/\b(?:for me|please|pls)\b/gi, "")
    .replace(/\b(?:the|a|an)\b\s+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const title = compact.length > 42 ? `${compact.slice(0, 39).trimEnd()}...` : compact;

  return title
    .split(" ")
    .map((word) => (word.length <= 3 && word === word.toLowerCase() ? word : word[0]?.toUpperCase() + word.slice(1)))
    .join(" ");
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function proposalStatusForToolResult(result: ToolResult) {
  if (result.status === "executed") {
    return "executed" as const;
  }
  if (result.status === "blocked") {
    return "blocked" as const;
  }
  return "failed" as const;
}

function buildNoToolActionResponse(message: string, context: Array<{ actor: string; content: string }>): string | undefined {
  if (!isLikelyExternalActionRequest(message, context)) {
    return undefined;
  }

  const combined = [message, ...context.map((entry) => entry.content)].join("\n");
  if (/\b(calendar|event|meeting|schedule)\b/i.test(combined)) {
    return "I have not created the calendar event yet because no verified calendar tool call ran. Please send the event title, date, start/end time, and location together, and I will show an approval before creating it.";
  }

  return "I have not completed that external action because no verified tool call ran. Please confirm the details, and I will show an approval or notification before taking action.";
}

function isLikelyExternalActionRequest(message: string, context: Array<{ actor: string; content: string }>): boolean {
  const combined = [message, ...context.map((entry) => entry.content)].join("\n");
  const directAction =
    /\b(add|create|book|schedule|send|delete|remove|pay|transfer|buy|sell|text|message)\b/i.test(message) &&
    /\b(calendar|event|meeting|gmail|email|draft|tesla|vehicle|bank|payment|transaction|pushcut|shortcut|iphone|imessage|sms)\b/i.test(
      combined
    );
  if (directAction) {
    return true;
  }

  const recentClarification = context.some(
    (entry) =>
      entry.actor === "assistant" &&
      /\b(what .* should i use|what date|what end time|clarif|confirm|which)\b/i.test(entry.content)
  );
  const priorExternalAction = context.some(
    (entry) =>
      entry.actor === "user" &&
      /\b(add|create|book|schedule|send|delete|remove|pay|transfer|buy|sell|text|message)\b/i.test(entry.content) &&
      /\b(calendar|event|meeting|gmail|email|draft|tesla|vehicle|bank|payment|transaction|pushcut|shortcut|iphone|imessage|sms)\b/i.test(
        entry.content
      )
  );
  const currentLooksLikeClarificationAnswer =
    /\b(today|tomorrow|tmrw|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|noon|\d{1,2}(?::\d{2})?)\b/i.test(
      message
    );

  return recentClarification && priorExternalAction && currentLooksLikeClarificationAnswer;
}

async function listActivePendingApprovals(): Promise<ApprovalRequest[]> {
  const now = Date.now();
  const active: ApprovalRequest[] = [];

  for (const approval of await listPendingApprovals(db)) {
    const expired = new Date(approval.expiresAt).getTime() < now;
    if (expired) {
      const decidedAt = nowIso();
      await updateApprovalStatus(db, approval.id, "expired", decidedAt);
      await updateToolProposalStatus(db, approval.proposalId, "blocked", { decidedAt });
      continue;
    }

    active.push({
      ...approval,
      proposal: (await getToolProposal(db, approval.proposalId)) ?? undefined
    });
  }

  return active;
}

async function maybeQueueGmailSendApproval(input: {
  sessionId: string;
  correlationId: string;
  result: ToolResult;
}) {
  if (input.result.toolName !== "google.gmail.create_draft" || input.result.status !== "executed") {
    return undefined;
  }

  const data = input.result.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const draftId = stringField(data, "draftId");
  if (!draftId) {
    return undefined;
  }

  return proposeAndMaybeExecuteTool({
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    toolName: "google.gmail.send_draft",
    args: {
      draftId,
      to: stringField(data, "to"),
      subject: stringField(data, "subject"),
      bodyPreview: stringField(data, "bodyPreview")
    },
    assumptions: ["Human must review the Gmail draft before sending."],
    plannedBy: "manual"
  });
}

function stringField(value: object, key: string): string | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

async function maybeStoreMemoryFromToolResults(toolResults: ToolResult[], correlationId: string): Promise<MemoryFact[]> {
  const stored: MemoryFact[] = [];
  for (const result of toolResults) {
    if (result.status !== "executed") {
      continue;
    }

    const data = resultData(result);
    const outcome = memoryOutcomeForToolResult(result, data);
    if (!outcome) {
      continue;
    }

    const fact = await createMemoryFact({
      subject: outcome.subject,
      predicate: outcome.predicate,
      object: outcome.object,
      category: "tool_outcome",
      sensitivity: outcome.sensitivity,
      confidence: 0.85,
      sourceMessageId: null,
      sourceToolResultId: result.proposalId
    });
    stored.push(fact);
    await appendAuditEvent(db, {
      actor: "system",
      kind: "memory.stored",
      correlationId,
      payload: { factId: fact.id, subject: fact.subject, predicate: fact.predicate, sourceToolResultId: result.proposalId }
    });
  }

  return stored;
}

function memoryOutcomeForToolResult(
  result: ToolResult,
  data: Record<string, unknown>
): { subject: string; predicate: string; object: string; sensitivity: MemoryFact["sensitivity"] } | undefined {
  if (result.toolName === "google.calendar.create_event") {
    return {
      subject: "calendar",
      predicate: "created_event",
      object: `${stringField(data, "eventId") ?? "event"}${stringField(data, "htmlLink") ? ` ${stringField(data, "htmlLink")}` : ""}`,
      sensitivity: "personal"
    };
  }

  if (result.toolName === "google.gmail.send_draft") {
    return {
      subject: "gmail",
      predicate: "sent_draft",
      object: `${stringField(data, "subject") ?? "draft"}${stringField(data, "to") ? ` to ${stringField(data, "to")}` : ""}`,
      sensitivity: "personal"
    };
  }

  return undefined;
}

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
  const candidates: Array<{ predicate: string; object: string; category?: MemoryFact["category"] }> = [];
  const rememberMatch = message.match(/\bremember that\s+(.+)$/i);
  if (rememberMatch?.[1]) {
    candidates.push({ predicate: "remembered", object: rememberMatch[1].trim(), category: "general" });
  }

  const preferenceMatch = message.match(/\bmy\s+([a-z][a-z\s]{1,40})\s+is\s+(.+)$/i);
  if (preferenceMatch?.[1] && preferenceMatch[2]) {
    candidates.push({
      predicate: preferenceMatch[1].trim().replace(/\s+/g, "_"),
      object: preferenceMatch[2].trim(),
      category: "preference"
    });
  }

  const now = nowIso();
  return candidates.map((candidate) => ({
    id: crypto.randomUUID(),
    subject: "user",
    predicate: candidate.predicate,
    object: candidate.object,
    category: candidate.category ?? "general",
    sensitivity: "personal",
    lastConfirmedAt: now,
    sourceToolResultId: null,
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
  category?: MemoryFact["category"];
  sensitivity?: MemoryFact["sensitivity"];
  confidence: number;
  sourceMessageId: string | null;
  sourceToolResultId?: string | null;
}): Promise<MemoryFact> {
  const now = nowIso();
  const fact: MemoryFact = {
    id: crypto.randomUUID(),
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    category: input.category ?? "general",
    sensitivity: input.sensitivity ?? "personal",
    sourceToolResultId: input.sourceToolResultId ?? null,
    lastConfirmedAt: now,
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
    .map((result) => {
      const data = result.data ? `\nData: ${JSON.stringify(result.data)}` : "";
      return `Tool ${result.toolName} returned ${result.status}: ${result.notification}${data}`;
    })
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

function buildDirectToolResponse(toolResults: ToolResult[]): string | undefined {
  if (toolResults.length === 0) {
    return undefined;
  }

  if (toolResults.some((result) => result.toolName === "search.web" && result.status === "executed")) {
    return undefined;
  }

  const parts = toolResults.map(formatToolResultForUser).filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

function formatToolResultForUser(result: ToolResult): string | undefined {
  if (result.status === "queued_for_approval") {
    return result.notification;
  }

  if (result.status === "failed" || result.status === "blocked") {
    return `${result.toolName} did not complete: ${result.notification}`;
  }

  if (result.toolName === "google.calendar.read_schedule") {
    const events = resultEvents(result);
    if (events.length === 0) {
      return "Your calendar is clear for that window.";
    }

    const lines = events.slice(0, 10).map((event) => {
      const start = formatCalendarDateTime(event.start);
      const end = formatCalendarDateTime(event.end);
      return `- ${event.summary ?? "Untitled event"}${start ? `: ${start}` : ""}${end ? ` to ${end}` : ""}`;
    });
    return `Here is what I found on your calendar:\n${lines.join("\n")}`;
  }

  if (result.toolName === "google.gmail.create_draft") {
    const data = resultData(result);
    return [
      `Draft created for ${stringField(data, "to") ?? "the recipient"}.`,
      stringField(data, "subject") ? `Subject: ${stringField(data, "subject")}` : undefined,
      "Review it in the approval preview before sending."
    ]
      .filter(Boolean)
      .join("\n");
  }

  return result.notification;
}

function resultData(result: ToolResult): Record<string, unknown> {
  return result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? (result.data as Record<string, unknown>)
    : {};
}

function resultEvents(result: ToolResult): Array<{
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
}> {
  const events = resultData(result).events;
  return Array.isArray(events) ? events.filter((event) => event && typeof event === "object") : [];
}

function formatCalendarDateTime(value: { dateTime?: string; date?: string; timeZone?: string } | undefined): string | undefined {
  const raw = value?.dateTime ?? value?.date;
  if (!raw) {
    return undefined;
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: value?.date ? undefined : "short",
    timeZone: value?.timeZone
  });
}

const port = Number(process.env.API_PORT ?? 3000);
serve({ fetch: app.fetch, port });

console.log(`MYLA API listening on http://localhost:${port}`);
