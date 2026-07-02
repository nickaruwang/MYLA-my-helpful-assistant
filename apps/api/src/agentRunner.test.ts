import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MylaDatabase } from "@myla/db";
import type { AgentRun, AgentStep, ApprovalRequest, ToolCallProposal, ToolResult } from "@myla/shared";

const state = vi.hoisted(() => ({
  run: undefined as AgentRun | undefined,
  steps: [] as AgentStep[],
  plannerResults: [] as unknown[],
  toolDecisions: [] as Array<{ proposal: ToolCallProposal; approval?: ApprovalRequest; result: ToolResult }>,
  approvals: [] as ApprovalRequest[],
  tasks: [] as unknown[]
}));

vi.mock("@myla/audit", () => ({
  appendAuditEvent: vi.fn(async () => undefined)
}));

vi.mock("./toolPlanner.js", () => ({
  planAgentNextStep: vi.fn(async () => state.plannerResults.shift() ?? { kind: "final", message: "Done." })
}));

vi.mock("@myla/tools", () => ({
  listTools: vi.fn(() => [
    {
      name: "pushcut.lock_car",
      provider: "pushcut",
      operation: "trigger lock car shortcut",
      description: "Lock my car through a Pushcut-triggered iPhone Shortcut."
    }
  ]),
  proposeAndMaybeExecuteTool: vi.fn(async () => {
    const decision = state.toolDecisions.shift();
    if (!decision) {
      throw new Error("No mocked tool decision.");
    }
    return decision;
  })
}));

vi.mock("@myla/db", () => ({
  nowIso: () => new Date("2026-07-01T12:00:00.000Z").toISOString(),
  createAgentRun: vi.fn(async (_db, input) => {
    state.run = {
      id: "run-1",
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      inputMessageId: input.inputMessageId,
      outputMessageId: null,
      status: "running",
      goal: input.goal,
      currentStepIndex: 0,
      maxSteps: input.maxSteps,
      maxToolCalls: input.maxToolCalls,
      toolCallCount: 0,
      waitingApprovalId: null,
      waitingTaskId: null,
      lastError: null,
      startedAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z",
      finishedAt: null
    };
    return state.run;
  }),
  updateAgentRun: vi.fn(async (_db, _runId, updates) => {
    if (state.run) {
      state.run = { ...state.run, ...updates, updatedAt: "2026-07-01T12:00:00.000Z" };
    }
  }),
  updateAgentRunStatus: vi.fn(async (_db, _runId, status, updates = {}) => {
    if (state.run) {
      state.run = { ...state.run, status, ...updates, updatedAt: "2026-07-01T12:00:00.000Z" };
    }
  }),
  appendAgentStep: vi.fn(async (_db, input) => {
    const step = {
      id: `step-${state.steps.length + 1}`,
      runId: input.runId,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      stepIndex: input.stepIndex,
      kind: input.kind,
      status: input.status,
      input: input.input ?? {},
      output: input.output ?? {},
      plannerTraceId: input.plannerTraceId ?? null,
      proposalId: input.proposalId ?? null,
      taskId: input.taskId ?? null,
      approvalId: input.approvalId ?? null,
      error: input.error ?? null,
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z",
      completedAt: input.status === "completed" ? "2026-07-01T12:00:00.000Z" : null
    } satisfies AgentStep;
    state.steps.push(step);
    if (state.run) {
      state.run = { ...state.run, currentStepIndex: input.stepIndex + 1 };
    }
    return step;
  }),
  updateAgentStep: vi.fn(async (_db, stepId, updates) => {
    state.steps = state.steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step));
  }),
  listAgentSteps: vi.fn(async () => state.steps),
  getAgentRunByApprovalId: vi.fn(async (_db, approvalId) =>
    state.run?.waitingApprovalId === approvalId ? state.run : undefined
  ),
  getAgentStepByProposalId: vi.fn(async (_db, proposalId) => state.steps.find((step) => step.proposalId === proposalId) ?? undefined),
  storePlannerTrace: vi.fn(async () => undefined),
  storeToolProposal: vi.fn(async () => undefined),
  updateToolProposalStatus: vi.fn(async () => undefined),
  storeApproval: vi.fn(async (_db, approval) => {
    state.approvals.push(approval);
  }),
  createToolTask: vi.fn(async (_db, input) => {
    const task = {
      id: `task-${state.tasks.length + 1}`,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      toolName: input.toolName ?? null,
      status: input.status,
      draftArgs: input.draftArgs ?? {},
      missingFields: input.missingFields ?? [],
      assumptions: input.assumptions ?? [],
      validationErrors: input.validationErrors ?? [],
      proposalId: input.proposalId ?? null,
      approvalId: input.approvalId ?? null,
      resultStatus: input.resultStatus ?? null,
      resultNotification: input.resultNotification ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z"
    };
    state.tasks.push(task);
    return task;
  })
}));

describe("agent runner", () => {
  beforeEach(() => {
    state.run = undefined;
    state.steps = [];
    state.plannerResults = [];
    state.toolDecisions = [];
    state.approvals = [];
    state.tasks = [];
  });

  it("executes sequential tool steps and returns a final answer", async () => {
    const { startAgentRun } = await import("./agentRunner.js");
    state.plannerResults = [
      toolPlan("search.web", { query: "weather" }),
      toolPlan("search.web", { query: "calendar context" }),
      { kind: "final", message: "It is handled." }
    ];
    state.toolDecisions = [executedDecision("p1", "search.web", "Weather found."), executedDecision("p2", "search.web", "Context found.")];

    const result = await startAgentRun(baseInput());

    expect(result.status).toBe("final");
    expect(result.finalMessage).toBe("It is handled.");
    expect(result.toolResults).toHaveLength(2);
    expect(state.run?.status).toBe("completed");
  });

  it("pauses when a manual approval is queued", async () => {
    const { startAgentRun } = await import("./agentRunner.js");
    state.plannerResults = [toolPlan("pushcut.send_imessage", { recipient: "Sam", message: "On my way" })];
    state.toolDecisions = [approvalDecision("p1", "a1", "pushcut.send_imessage")];

    const result = await startAgentRun(baseInput());

    expect(result.status).toBe("paused");
    expect(result.approvals).toHaveLength(1);
    expect(result.toolResults[0]?.status).toBe("queued_for_approval");
    expect(state.run?.status).toBe("waiting_approval");
  });

  it("uses deterministic Pushcut fallback when planner asks an irrelevant clarification", async () => {
    const { startAgentRun } = await import("./agentRunner.js");
    state.plannerResults = [
      {
        kind: "clarification",
        message: "I cannot find a command to lock the car using your connected Tesla system.",
        missingFields: []
      }
    ];
    state.toolDecisions = [approvalDecision("p1", "a1", "pushcut.lock_car")];

    const result = await startAgentRun({ ...baseInput(), goal: "lock the car" });

    expect(result.status).toBe("paused");
    expect(result.approvals[0]?.proposal?.toolName).toBe("pushcut.lock_car");
  });

  it("resumes a paused run after approval", async () => {
    const { resumeAgentRunAfterApproval } = await import("./agentRunner.js");
    state.run = {
      id: "run-1",
      sessionId: "session",
      correlationId: "correlation",
      inputMessageId: "message",
      outputMessageId: null,
      status: "waiting_approval",
      goal: "text Sam",
      currentStepIndex: 1,
      maxSteps: 5,
      maxToolCalls: 3,
      toolCallCount: 0,
      waitingApprovalId: "a1",
      waitingTaskId: "task-1",
      lastError: null,
      startedAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z",
      finishedAt: null
    };
    state.steps = [
      {
        id: "step-1",
        runId: "run-1",
        sessionId: "session",
        correlationId: "correlation",
        stepIndex: 0,
        kind: "tool",
        status: "waiting_approval",
        input: {},
        output: {},
        plannerTraceId: null,
        proposalId: "p1",
        taskId: "task-1",
        approvalId: "a1",
        error: null,
        createdAt: "2026-07-01T12:00:00.000Z",
        updatedAt: "2026-07-01T12:00:00.000Z",
        completedAt: null
      }
    ];
    state.plannerResults = [{ kind: "final", message: "Message sent." }];

    const result = await resumeAgentRunAfterApproval({
      db: mockDb(),
      approval: approval("a1", "p1"),
      proposal: proposal("p1", "pushcut.send_imessage"),
      toolResult: { proposalId: "p1", toolName: "pushcut.send_imessage", status: "executed", notification: "Sent." },
      privacyClass: "personal",
      route: "local"
    });

    expect(result?.status).toBe("final");
    expect(result?.finalMessage).toBe("Message sent.");
    expect(state.run?.status).toBe("completed");
  });
});

function baseInput() {
  return {
    db: mockDb(),
    sessionId: "session",
    correlationId: "correlation",
    goal: "do the thing",
    inputMessageId: "message",
    privacyClass: "personal" as const,
    route: "local" as const,
    conversationContext: []
  };
}

function mockDb(): MylaDatabase {
  return {} as MylaDatabase;
}

function toolPlan(toolName: string, args: Record<string, unknown>) {
  return {
    kind: "tool" as const,
    plannedBy: "model" as const,
    plan: {
      toolName,
      args,
      confidence: 0.9,
      assumptions: [],
      missingFields: [],
      needsClarification: false
    }
  };
}

function proposal(id: string, toolName: string): ToolCallProposal {
  return {
    id,
    sessionId: "session",
    correlationId: "correlation",
    provider: toolName.split(".")[0] ?? "tool",
    toolName,
    operation: toolName,
    args: {},
    requiredScopes: [],
    riskLevel: "read",
    approvalMode: "auto",
    status: "proposed",
    dryRunSummary: `Run ${toolName}`,
    assumptions: [],
    plannedBy: "model",
    createdAt: "2026-07-01T12:00:00.000Z",
    decidedAt: null,
    executedAt: null
  };
}

function approval(id: string, proposalId: string): ApprovalRequest {
  return {
    id,
    proposalId,
    sessionId: "session",
    explanation: "Approval required.",
    status: "pending",
    expiresAt: "2026-07-02T12:00:00.000Z",
    decidedAt: null
  };
}

function executedDecision(proposalId: string, toolName: string, notification: string) {
  return {
    proposal: proposal(proposalId, toolName),
    result: {
      proposalId,
      toolName,
      status: "executed" as const,
      notification
    }
  };
}

function approvalDecision(proposalId: string, approvalId: string, toolName: string) {
  return {
    proposal: {
      ...proposal(proposalId, toolName),
      riskLevel: "high" as const,
      approvalMode: "manual" as const,
      status: "queued_for_approval" as const
    },
    approval: approval(approvalId, proposalId),
    result: {
      proposalId,
      toolName,
      status: "queued_for_approval" as const,
      notification: "Approval required."
    }
  };
}
