import { classifyTool } from "@jarvis/policy";
import type { ApprovalRequest, ToolCallProposal, ToolResult } from "@jarvis/shared";
import { createSafeGoogleTools } from "./google.js";

export { getGoogleAuthUrl, GOOGLE_SAFE_SCOPES, hasGoogleOAuthConfig, saveGoogleTokensFromCode } from "./google.js";

export interface ToolDefinition {
  name: string;
  operation: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  dryRun: (args: Record<string, unknown>) => string;
}

export interface ToolGatewayDecision {
  proposal: ToolCallProposal;
  approval?: ApprovalRequest;
  result: ToolResult;
}

const toolRegistry = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
  toolRegistry.set(tool.name, tool);
}

export function listTools(): ToolDefinition[] {
  return [...toolRegistry.values()];
}

export async function proposeAndMaybeExecuteTool(input: {
  sessionId: string;
  correlationId: string;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<ToolGatewayDecision> {
  const tool = toolRegistry.get(input.toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${input.toolName}`);
  }

  const policy = classifyTool(tool.name, tool.operation, input.args);
  const proposal: ToolCallProposal = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    toolName: tool.name,
    operation: tool.operation,
    args: input.args,
    riskLevel: policy.riskLevel,
    approvalMode: policy.approvalMode,
    dryRunSummary: tool.dryRun(input.args),
    createdAt: new Date().toISOString()
  };

  if (proposal.approvalMode === "manual") {
    const approval: ApprovalRequest = {
      id: crypto.randomUUID(),
      proposalId: proposal.id,
      sessionId: input.sessionId,
      explanation: `Approval required before ${tool.name} can run: ${proposal.dryRunSummary}`,
      status: "pending",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      decidedAt: null
    };

    return {
      proposal,
      approval,
      result: {
        proposalId: proposal.id,
        toolName: tool.name,
        status: "queued_for_approval",
        notification: approval.explanation
      }
    };
  }

  const data = await tool.execute(input.args);
  return {
    proposal,
    result: {
      proposalId: proposal.id,
      toolName: tool.name,
      status: "executed",
      notification:
        proposal.approvalMode === "notify"
          ? `Auto-executed low-risk tool with notification: ${proposal.dryRunSummary}`
          : `Auto-executed read-only tool: ${proposal.dryRunSummary}`,
      data
    }
  };
}

export function registerDefaultTools(): void {
  for (const tool of createSafeGoogleTools()) {
    registerTool(tool);
  }

  registerTool({
    name: "apple.messages.send",
    operation: "send message",
    description: "Future Apple companion send-message contract. Always requires approval.",
    dryRun: (args) => `Would send an Apple Message with args ${JSON.stringify(args)}.`,
    execute: async () => {
      throw new Error("Apple sending is disabled in the skeleton.");
    }
  });

  registerTool({
    name: "tesla.vehicle.command",
    operation: "tesla vehicle command",
    description: "Future Tesla command contract. Always requires approval.",
    dryRun: (args) => `Would issue Tesla vehicle command with args ${JSON.stringify(args)}.`,
    execute: async () => {
      throw new Error("Tesla commands are disabled in the skeleton.");
    }
  });
}
