import type { ApprovalMode, ApprovalRequest, RiskLevel, ToolCallProposal, ToolResult } from "@jarvis/shared";
import { z } from "zod";
import { createSafeGoogleTools } from "./google.js";
import { createFinanceTools } from "./finance.js";
import { createSearchTools } from "./search.js";
import { createTeslaTools } from "./tesla.js";

export { getGoogleAuthUrl, GOOGLE_SAFE_SCOPES, hasGoogleOAuthConfig, saveGoogleTokensFromCode } from "./google.js";

export interface ToolDefinition {
  name: string;
  provider: string;
  operation: string;
  description: string;
  requiredScopes: string[];
  riskLevel: RiskLevel;
  approvalMode: ApprovalMode;
  argsSchema: z.ZodType<Record<string, unknown>>;
  examples?: Array<{
    user: string;
    args: Record<string, unknown>;
    assumptions?: string[];
  }>;
  clarificationPrompts?: Record<string, string>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  dryRun: (args: Record<string, unknown>) => string;
}

export interface PublicToolDefinition {
  name: string;
  provider: string;
  operation: string;
  description: string;
  requiredScopes: string[];
  riskLevel: RiskLevel;
  approvalMode: ApprovalMode;
  argsSchema: unknown;
}

export interface ModelToolCard extends PublicToolDefinition {
  requiredFields: string[];
  examples: Array<{
    user: string;
    args: Record<string, unknown>;
    assumptions?: string[];
  }>;
  clarificationPrompts: Record<string, string>;
}

export interface ToolGatewayDecision {
  proposal: ToolCallProposal;
  approval?: ApprovalRequest;
  result: ToolResult;
}

const toolRegistry = new Map<string, ToolDefinition>();
const MANUAL_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export function registerTool(tool: ToolDefinition): void {
  toolRegistry.set(tool.name, tool);
}

export function listTools(): ToolDefinition[] {
  return [...toolRegistry.values()];
}

export function listPublicTools(): PublicToolDefinition[] {
  return listTools().map((tool) => ({
    name: tool.name,
    provider: tool.provider,
    operation: tool.operation,
    description: tool.description,
    requiredScopes: tool.requiredScopes,
    riskLevel: tool.riskLevel,
    approvalMode: tool.approvalMode,
    argsSchema: zodSchemaToHint(tool.argsSchema)
  }));
}

export function listModelToolCards(): ModelToolCard[] {
  return listTools().map((tool) => ({
    name: tool.name,
    provider: tool.provider,
    operation: tool.operation,
    description: tool.description,
    requiredScopes: tool.requiredScopes,
    riskLevel: tool.riskLevel,
    approvalMode: tool.approvalMode,
    argsSchema: zodSchemaToHint(tool.argsSchema),
    requiredFields: requiredFieldsForSchema(tool.argsSchema),
    examples: tool.examples ?? [],
    clarificationPrompts: tool.clarificationPrompts ?? {}
  }));
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return toolRegistry.get(name);
}

export async function proposeAndMaybeExecuteTool(input: {
  sessionId: string;
  correlationId: string;
  toolName: string;
  args: Record<string, unknown>;
  assumptions?: string[];
  plannedBy?: "model" | "fallback" | "manual";
}): Promise<ToolGatewayDecision> {
  const tool = toolRegistry.get(input.toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${input.toolName}`);
  }

  const args = tool.argsSchema.parse(input.args);
  const proposal: ToolCallProposal = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    provider: tool.provider,
    toolName: tool.name,
    operation: tool.operation,
    args,
    requiredScopes: tool.requiredScopes,
    riskLevel: tool.riskLevel,
    approvalMode: tool.approvalMode,
    status: tool.approvalMode === "manual" ? "queued_for_approval" : "proposed",
    dryRunSummary: tool.dryRun(args),
    assumptions: input.assumptions ?? [],
    plannedBy: input.plannedBy ?? "fallback",
    createdAt: new Date().toISOString(),
    decidedAt: null,
    executedAt: null
  };

  if (proposal.approvalMode === "manual") {
    const approval: ApprovalRequest = {
      id: crypto.randomUUID(),
      proposalId: proposal.id,
      sessionId: input.sessionId,
      explanation: `Approval required before ${tool.name} can run: ${proposal.dryRunSummary}${formatAssumptions(proposal.assumptions)}`,
      status: "pending",
      expiresAt: new Date(Date.now() + MANUAL_APPROVAL_TTL_MS).toISOString(),
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

  const result = await executeRegisteredTool(proposal);
  return {
    proposal,
    result
  };
}

export async function executeRegisteredTool(proposal: ToolCallProposal): Promise<ToolResult> {
  const tool = toolRegistry.get(proposal.toolName);
  if (!tool) {
    return {
      proposalId: proposal.id,
      toolName: proposal.toolName,
      status: "failed",
      notification: `Unknown tool: ${proposal.toolName}`
    };
  }

  try {
    const args = tool.argsSchema.parse(proposal.args);
    const data = await tool.execute(args);
    const blockedMessage = extractBlockedProviderMessage(data);
    if (blockedMessage) {
      return {
        proposalId: proposal.id,
        toolName: tool.name,
        status: "blocked",
        notification: blockedMessage,
        data
      };
    }

    const providerMessage = extractProviderMessage(data);
    return {
      proposalId: proposal.id,
      toolName: tool.name,
      status: "executed",
      notification:
        providerMessage ??
        (proposal.approvalMode === "notify"
          ? `Executed with notification: ${proposal.dryRunSummary}`
          : `Executed: ${proposal.dryRunSummary}`),
      data
    };
  } catch (error) {
    return {
      proposalId: proposal.id,
      toolName: proposal.toolName,
      status: "failed",
      notification: error instanceof Error ? error.message : "Tool execution failed."
    };
  }
}

export function registerDefaultTools(): void {
  for (const tool of createSafeGoogleTools()) {
    registerTool(tool);
  }

  for (const tool of createSearchTools()) {
    registerTool(tool);
  }

  for (const tool of createTeslaTools()) {
    registerTool(tool);
  }

  for (const tool of createFinanceTools()) {
    registerTool(tool);
  }
}

function zodSchemaToHint(schema: z.ZodType<Record<string, unknown>>): unknown {
  if (schema instanceof z.ZodObject) {
    return Object.fromEntries(
      Object.entries(schema.shape).map(([key, value]) => [key, describeZodType(value as z.ZodTypeAny)])
    );
  }

  return { type: "object" };
}

function requiredFieldsForSchema(schema: z.ZodType<Record<string, unknown>>): string[] {
  if (!(schema instanceof z.ZodObject)) {
    return [];
  }

  return Object.entries(schema.shape)
    .filter(([, value]) => !isOptionalSchema(value as z.ZodTypeAny))
    .map(([key]) => key);
}

function isOptionalSchema(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return true;
  }

  if (schema instanceof z.ZodNullable) {
    return isOptionalSchema(schema._def.innerType);
  }

  return false;
}

function describeZodType(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return `${describeZodType(schema._def.innerType)}?`;
  }

  if (schema instanceof z.ZodString) {
    return "string";
  }

  if (schema instanceof z.ZodNumber) {
    return "number";
  }

  if (schema instanceof z.ZodBoolean) {
    return "boolean";
  }

  if (schema instanceof z.ZodEnum) {
    return schema.options.join(" | ");
  }

  if (schema instanceof z.ZodArray) {
    return "array";
  }

  return "unknown";
}

function extractProviderMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const message = (data as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

function extractBlockedProviderMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const record = data as { kind?: unknown; message?: unknown };
  if (record.kind !== "scaffold") {
    return undefined;
  }

  return typeof record.message === "string" && record.message.trim() ? record.message : "Tool provider is not configured.";
}

function formatAssumptions(assumptions: string[]): string {
  return assumptions.length > 0 ? ` Assumptions: ${assumptions.join("; ")}.` : "";
}
