import { appendAuditEvent } from "@myla/audit";
import {
  appendAgentStep,
  createAgentRun,
  createToolTask,
  getAgentRunByApprovalId,
  getAgentStepByProposalId,
  listAgentSteps,
  nowIso,
  storeApproval,
  storePlannerTrace,
  storeToolProposal,
  updateAgentRun,
  updateAgentRunStatus,
  updateAgentStep,
  updateToolProposalStatus,
  type MylaDatabase
} from "@myla/db";
import type {
  AgentRun,
  ApprovalRequest,
  ModelRoute,
  PrivacyClass,
  ToolCallProposal,
  ToolResult,
  ToolTask
} from "@myla/shared";
import { proposeAndMaybeExecuteTool } from "@myla/tools";
import { planAgentNextStep, type AgentToolObservation } from "./toolPlanner.js";
import { inferToolIntent } from "./toolIntent.js";

const DEFAULT_MAX_STEPS = 5;
const DEFAULT_MAX_TOOL_CALLS = 3;
const CLARIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

interface PlannerConversationMessage {
  actor: string;
  content: string;
  createdAt?: string;
}

export interface AgentRunResult {
  run: AgentRun;
  status: "final" | "clarification" | "paused" | "none" | "failed";
  finalMessage?: string;
  noneReason?: string;
  toolResults: ToolResult[];
  approvals: ApprovalRequest[];
  tasks: ToolTask[];
}

export async function startAgentRun(input: {
  db: MylaDatabase;
  sessionId: string;
  correlationId: string;
  goal: string;
  inputMessageId: string;
  privacyClass: PrivacyClass;
  route: ModelRoute;
  preferredModel?: string;
  conversationContext: PlannerConversationMessage[];
}): Promise<AgentRunResult> {
  const run = await createAgentRun(input.db, {
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    inputMessageId: input.inputMessageId,
    goal: input.goal,
    maxSteps: DEFAULT_MAX_STEPS,
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS
  });

  await appendAuditEvent(input.db, {
    actor: "system",
    kind: "agent.run.started",
    correlationId: input.correlationId,
    payload: {
      runId: run.id,
      sessionId: input.sessionId,
      inputMessageId: input.inputMessageId,
      maxSteps: run.maxSteps,
      maxToolCalls: run.maxToolCalls
    }
  });

  return continueAgentRun({
    ...input,
    run,
    initialToolResults: [],
    initialApprovals: [],
    initialTasks: []
  });
}

export async function resumeAgentRunAfterApproval(input: {
  db: MylaDatabase;
  approval: ApprovalRequest;
  proposal: ToolCallProposal;
  toolResult: ToolResult;
  privacyClass: PrivacyClass;
  route: ModelRoute;
  preferredModel?: string;
  conversationContext?: PlannerConversationMessage[];
}): Promise<AgentRunResult | undefined> {
  const run = await getAgentRunByApprovalId(input.db, input.approval.id);
  if (!run) {
    return undefined;
  }

  const step = await getAgentStepByProposalId(input.db, input.proposal.id);
  if (step) {
    await updateAgentStep(input.db, step.id, {
      status: input.toolResult.status === "executed" ? "completed" : input.toolResult.status === "blocked" ? "blocked" : "failed",
      output: {
        ...step.output,
        toolResult: input.toolResult
      },
      error: input.toolResult.status === "failed" ? input.toolResult.notification : null
    });
  }

  await updateAgentRun(input.db, run.id, {
    status: "running",
    waitingApprovalId: null,
    waitingTaskId: null,
    toolCallCount: run.toolCallCount + (input.toolResult.status === "queued_for_approval" ? 0 : 1)
  });

  return continueAgentRun({
    db: input.db,
    run: {
      ...run,
      status: "running",
      waitingApprovalId: null,
      waitingTaskId: null,
      toolCallCount: run.toolCallCount + (input.toolResult.status === "queued_for_approval" ? 0 : 1)
    },
    sessionId: run.sessionId,
    correlationId: run.correlationId,
    goal: run.goal,
    inputMessageId: run.inputMessageId,
    privacyClass: input.privacyClass,
    route: input.route,
    preferredModel: input.preferredModel,
    conversationContext: input.conversationContext ?? [],
    initialToolResults: [input.toolResult],
    initialApprovals: [],
    initialTasks: []
  });
}

export async function rejectAgentRunApproval(input: {
  db: MylaDatabase;
  approval: ApprovalRequest;
  proposal: ToolCallProposal;
  reason?: string;
}): Promise<AgentRun | undefined> {
  const run = await getAgentRunByApprovalId(input.db, input.approval.id);
  if (!run) {
    return undefined;
  }

  const step = await getAgentStepByProposalId(input.db, input.proposal.id);
  if (step) {
    await updateAgentStep(input.db, step.id, {
      status: "blocked",
      output: {
        ...step.output,
        rejected: true,
        reason: input.reason
      },
      error: `Rejected: ${input.proposal.dryRunSummary}`
    });
  }

  const lastError = `Rejected: ${input.proposal.dryRunSummary}`;
  await updateAgentRunStatus(input.db, run.id, "cancelled", {
    waitingApprovalId: null,
    waitingTaskId: null,
    lastError
  });
  await appendRunCompleted(input.db, run, "failed", { rejected: true, approvalId: input.approval.id, reason: input.reason });
  return { ...run, status: "cancelled", waitingApprovalId: null, waitingTaskId: null, lastError, finishedAt: nowIso() };
}

async function continueAgentRun(input: {
  db: MylaDatabase;
  run: AgentRun;
  sessionId: string;
  correlationId: string;
  goal: string;
  inputMessageId: string;
  privacyClass: PrivacyClass;
  route: ModelRoute;
  preferredModel?: string;
  conversationContext: PlannerConversationMessage[];
  initialToolResults: ToolResult[];
  initialApprovals: ApprovalRequest[];
  initialTasks: ToolTask[];
}): Promise<AgentRunResult> {
  let run = input.run;
  const toolResults = [...input.initialToolResults];
  const approvals = [...input.initialApprovals];
  const tasks = [...input.initialTasks];
  const observations = await loadToolObservations(input.db, run.id);
  for (const result of input.initialToolResults) {
    observations.push(observationFromToolResult(observations.length, result));
  }

  for (let iteration = 0; iteration < run.maxSteps; iteration += 1) {
    const remainingSteps = Math.max(0, run.maxSteps - run.currentStepIndex);
    const remainingToolCalls = Math.max(0, run.maxToolCalls - run.toolCallCount);
    if (remainingSteps <= 0) {
      return failRun(input.db, run, "Agent step budget exhausted.", toolResults, approvals, tasks);
    }

    const planning = await planAgentNextStep({
      goal: input.goal,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      privacyClass: input.privacyClass,
      route: input.route,
      preferredModel: input.preferredModel,
      conversationContext: input.conversationContext,
      observations,
      remainingSteps,
      remainingToolCalls
    });

    const plannerTraceId = crypto.randomUUID();
    if (planning.trace) {
      await storePlannerTrace(input.db, {
        id: plannerTraceId,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        selectedToolNames: planning.trace.selectedToolNames,
        rawModelResponse: planning.trace.rawModelResponse,
        plannerResult: planning.trace.plannerResult,
        fallbackReason: planning.trace.fallbackReason,
        validationErrors: planning.trace.validationErrors,
        createdAt: nowIso()
      });
    }

    await appendAgentStep(input.db, {
      runId: run.id,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      stepIndex: run.currentStepIndex,
      kind: "planner",
      status: "completed",
      input: {
        goal: input.goal,
        remainingSteps,
        remainingToolCalls,
        observationCount: observations.length
      },
      output: { kind: planning.kind },
      plannerTraceId: planning.trace ? plannerTraceId : null
    });
    run = { ...run, currentStepIndex: run.currentStepIndex + 1 };

    if (planning.kind === "final") {
      await appendAgentStep(input.db, {
        runId: run.id,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        stepIndex: run.currentStepIndex,
        kind: "final",
        status: "completed",
        input: { observationCount: observations.length },
        output: { message: planning.message }
      });
      run = { ...run, currentStepIndex: run.currentStepIndex + 1, status: "completed", finishedAt: nowIso() };
      await updateAgentRunStatus(input.db, run.id, "completed", { finishedAt: run.finishedAt });
      await appendRunCompleted(input.db, run, "completed", { final: true, toolResultCount: toolResults.length });
      return { run, status: "final", finalMessage: planning.message, toolResults, approvals, tasks };
    }

    const fallbackIntent = planning.kind === "clarification" ? inferToolIntent(input.goal) : undefined;
    const actionablePlanning = fallbackIntent
      ? {
          kind: "tool" as const,
          plannedBy: "fallback" as const,
          plan: {
            toolName: fallbackIntent.toolName,
            args: fallbackIntent.args,
            confidence: 0.4,
            assumptions: ["Used deterministic fallback routing after the planner asked for clarification."],
            missingFields: [],
            needsClarification: false
          }
        }
      : planning;

    if (actionablePlanning.kind === "clarification") {
      const task = await createToolTask(input.db, {
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        toolName: actionablePlanning.plan?.toolName,
        status: "needs_clarification",
        draftArgs: actionablePlanning.plan?.args,
        missingFields: actionablePlanning.missingFields ?? actionablePlanning.plan?.missingFields,
        assumptions: actionablePlanning.plan?.assumptions,
        validationErrors: [actionablePlanning.message],
        resultNotification: actionablePlanning.message,
        expiresAt: new Date(Date.now() + CLARIFICATION_TTL_MS).toISOString()
      });
      tasks.push(task);

      await appendAgentStep(input.db, {
        runId: run.id,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        stepIndex: run.currentStepIndex,
        kind: "clarification",
        status: "completed",
        output: { message: actionablePlanning.message },
        taskId: task.id
      });
      await updateAgentRunStatus(input.db, run.id, "waiting_input", { waitingTaskId: task.id });
      await appendRunPaused(input.db, run, "waiting_input", { taskId: task.id });
      return { run: { ...run, status: "waiting_input", waitingTaskId: task.id }, status: "clarification", finalMessage: actionablePlanning.message, toolResults, approvals, tasks };
    }

    if (actionablePlanning.kind === "none") {
      return { run, status: "none", noneReason: actionablePlanning.reason, toolResults, approvals, tasks };
    }

    if (remainingToolCalls <= 0) {
      return failRun(input.db, run, "Agent tool-call budget exhausted.", toolResults, approvals, tasks);
    }

    const decision = await proposeAndMaybeExecuteTool({
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      toolName: actionablePlanning.plan.toolName,
      args: actionablePlanning.plan.args,
      assumptions: actionablePlanning.plan.assumptions,
      plannedBy: actionablePlanning.plannedBy
    });

    await storeToolProposal(input.db, decision.proposal);
    const task = await createToolTask(input.db, {
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      toolName: decision.proposal.toolName,
      status: taskStatusForToolResult(decision.result),
      draftArgs: decision.proposal.args,
      assumptions: decision.proposal.assumptions,
      proposalId: decision.proposal.id,
      approvalId: decision.approval?.id,
      resultStatus: decision.result.status,
      resultNotification: decision.result.notification,
      expiresAt: decision.approval?.expiresAt ?? null
    });
    tasks.push(task);

    if (decision.result.status === "executed" || decision.result.status === "failed" || decision.result.status === "blocked") {
      await updateToolProposalStatus(input.db, decision.proposal.id, proposalStatusForToolResult(decision.result), { executedAt: nowIso() });
    }

    await appendAuditEvent(input.db, {
      actor: "system",
      kind: "tool.proposed",
      correlationId: input.correlationId,
      payload: {
        runId: run.id,
        proposalId: decision.proposal.id,
        toolName: decision.proposal.toolName,
        riskLevel: decision.proposal.riskLevel,
        approvalMode: decision.proposal.approvalMode,
        plannedBy: decision.proposal.plannedBy,
        assumptions: decision.proposal.assumptions
      }
    });

    if (decision.approval) {
      await storeApproval(input.db, decision.approval);
      approvals.push({ ...decision.approval, proposal: decision.proposal });
      toolResults.push(decision.result);
      await appendAgentStep(input.db, {
        runId: run.id,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        stepIndex: run.currentStepIndex,
        kind: "tool",
        status: "waiting_approval",
        input: {
          toolName: decision.proposal.toolName,
          args: decision.proposal.args
        },
        output: { toolResult: decision.result },
        proposalId: decision.proposal.id,
        taskId: task.id,
        approvalId: decision.approval.id
      });
      await appendAuditEvent(input.db, {
        actor: "system",
        kind: "approval.created",
        correlationId: input.correlationId,
        payload: { runId: run.id, approvalId: decision.approval.id, proposalId: decision.proposal.id }
      });
      await appendAuditEvent(input.db, {
        actor: "tool",
        kind: "tool.policy_decision",
        correlationId: input.correlationId,
        payload: {
          runId: run.id,
          proposalId: decision.proposal.id,
          status: decision.result.status,
          notification: decision.result.notification
        }
      });
      await updateAgentRun(input.db, run.id, {
        status: "waiting_approval",
        waitingApprovalId: decision.approval.id,
        waitingTaskId: task.id
      });
      await appendRunPaused(input.db, run, "waiting_approval", {
        approvalId: decision.approval.id,
        proposalId: decision.proposal.id
      });
      return {
        run: { ...run, status: "waiting_approval", waitingApprovalId: decision.approval.id, waitingTaskId: task.id },
        status: "paused",
        toolResults,
        approvals,
        tasks
      };
    }

    toolResults.push(decision.result);
    observations.push(observationFromToolResult(observations.length, decision.result));
    await appendAgentStep(input.db, {
      runId: run.id,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      stepIndex: run.currentStepIndex,
      kind: "tool",
      status: decision.result.status === "executed" ? "completed" : decision.result.status === "blocked" ? "blocked" : "failed",
      input: {
        toolName: decision.proposal.toolName,
        args: decision.proposal.args
      },
      output: { toolResult: decision.result },
      proposalId: decision.proposal.id,
      taskId: task.id,
      error: decision.result.status === "failed" ? decision.result.notification : null
    });
    run = {
      ...run,
      currentStepIndex: run.currentStepIndex + 1,
      toolCallCount: run.toolCallCount + 1
    };
    await updateAgentRun(input.db, run.id, { toolCallCount: run.toolCallCount });
    await appendAuditEvent(input.db, {
      actor: "tool",
      kind: decision.result.status === "executed" ? "tool.executed" : "tool.policy_decision",
      correlationId: input.correlationId,
      payload: {
        runId: run.id,
        proposalId: decision.proposal.id,
        status: decision.result.status,
        notification: decision.result.notification
      }
    });
  }

  return failRun(input.db, run, "Agent loop terminated without a final step.", toolResults, approvals, tasks);
}

async function loadToolObservations(db: MylaDatabase, runId: string): Promise<AgentToolObservation[]> {
  const steps = await listAgentSteps(db, runId);
  return steps
    .filter((step) => step.kind === "tool")
    .flatMap((step, index) => {
      const result = step.output.toolResult;
      if (!isToolResult(result) || result.status === "queued_for_approval") {
        return [];
      }
      return [observationFromToolResult(index, result)];
    });
}

function observationFromToolResult(stepIndex: number, result: ToolResult): AgentToolObservation {
  return {
    stepIndex,
    toolName: result.toolName,
    status: result.status,
    notification: result.notification,
    data: result.data
  };
}

function isToolResult(value: unknown): value is ToolResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "proposalId" in value &&
      "toolName" in value &&
      "status" in value &&
      "notification" in value
  );
}

async function failRun(
  db: MylaDatabase,
  run: AgentRun,
  message: string,
  toolResults: ToolResult[],
  approvals: ApprovalRequest[],
  tasks: ToolTask[]
): Promise<AgentRunResult> {
  await updateAgentRunStatus(db, run.id, "failed", { lastError: message });
  await appendRunCompleted(db, run, "failed", { error: message });
  return {
    run: { ...run, status: "failed", lastError: message, finishedAt: nowIso() },
    status: "failed",
    finalMessage: message,
    toolResults,
    approvals,
    tasks
  };
}

async function appendRunPaused(
  db: MylaDatabase,
  run: AgentRun,
  status: "waiting_approval" | "waiting_input",
  payload: Record<string, unknown>
): Promise<void> {
  await appendAuditEvent(db, {
    actor: "system",
    kind: "agent.run.paused",
    correlationId: run.correlationId,
    payload: { runId: run.id, status, ...payload }
  });
}

async function appendRunCompleted(
  db: MylaDatabase,
  run: AgentRun,
  status: "completed" | "failed",
  payload: Record<string, unknown>
): Promise<void> {
  await appendAuditEvent(db, {
    actor: "system",
    kind: "agent.run.completed",
    correlationId: run.correlationId,
    payload: { runId: run.id, status, ...payload }
  });
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

function proposalStatusForToolResult(result: ToolResult) {
  if (result.status === "executed") {
    return "executed" as const;
  }
  if (result.status === "blocked") {
    return "blocked" as const;
  }
  return "failed" as const;
}
