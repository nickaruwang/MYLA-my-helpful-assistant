import { z } from "zod";

export const ActorSchema = z.enum(["user", "assistant", "system", "tool"]);
export type Actor = z.infer<typeof ActorSchema>;

export const PrivacyClassSchema = z.enum(["public", "personal", "sensitive", "financial", "vehicle"]);
export type PrivacyClass = z.infer<typeof PrivacyClassSchema>;

export const RiskLevelSchema = z.enum(["read", "low", "sensitive", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ApprovalModeSchema = z.enum(["auto", "notify", "manual"]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const ModelRouteSchema = z.enum(["local", "hosted-fallback", "blocked"]);
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  actor: ActorSchema,
  content: z.string(),
  correlationId: z.string(),
  createdAt: z.string()
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ModelRequestSchema = z.object({
  prompt: z.string(),
  sessionId: z.string(),
  correlationId: z.string(),
  retrievedContext: z.array(z.string()).default([]),
  privacyClass: PrivacyClassSchema,
  route: ModelRouteSchema,
  preferredModel: z.string().optional()
});
export type ModelRequest = z.infer<typeof ModelRequestSchema>;

export const ModelResponseSchema = z.object({
  text: z.string(),
  model: z.string(),
  route: ModelRouteSchema,
  usage: z
    .object({
      promptTokens: z.number().optional(),
      completionTokens: z.number().optional()
    })
    .optional()
});
export type ModelResponse = z.infer<typeof ModelResponseSchema>;

export const ToolCallProposalSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  correlationId: z.string(),
  toolName: z.string(),
  operation: z.string(),
  args: z.record(z.unknown()),
  riskLevel: RiskLevelSchema,
  approvalMode: ApprovalModeSchema,
  dryRunSummary: z.string(),
  createdAt: z.string()
});
export type ToolCallProposal = z.infer<typeof ToolCallProposalSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  sessionId: z.string(),
  explanation: z.string(),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  expiresAt: z.string(),
  decidedAt: z.string().nullable().default(null)
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ToolResultSchema = z.object({
  proposalId: z.string(),
  toolName: z.string(),
  status: z.enum(["executed", "queued_for_approval", "blocked", "failed"]),
  notification: z.string(),
  data: z.unknown().optional()
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const AuditEventKindSchema = z.enum([
  "request.received",
  "message.stored",
  "model.route_selected",
  "model.completed",
  "tool.proposed",
  "tool.policy_decision",
  "tool.executed",
  "approval.created",
  "approval.decided",
  "audit.verified"
]);
export type AuditEventKind = z.infer<typeof AuditEventKindSchema>;

export const AuditEventSchema = z.object({
  seq: z.number(),
  id: z.string(),
  actor: z.string(),
  kind: AuditEventKindSchema,
  correlationId: z.string(),
  payload: z.record(z.unknown()),
  payloadDigest: z.string(),
  previousHash: z.string(),
  hash: z.string(),
  createdAt: z.string()
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const MemoryFactSchema = z.object({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  sourceMessageId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

export const ChatRequestSchema = z.object({
  sessionId: z.string().optional(),
  message: z.string().min(1),
  preferredModel: z.string().optional()
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({
  sessionId: z.string(),
  correlationId: z.string(),
  message: ChatMessageSchema,
  toolResults: z.array(ToolResultSchema),
  approvals: z.array(ApprovalRequestSchema)
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
