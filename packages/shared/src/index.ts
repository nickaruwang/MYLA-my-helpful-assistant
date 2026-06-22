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

export const ToolProposalStatusSchema = z.enum([
  "proposed",
  "queued_for_approval",
  "approved",
  "rejected",
  "executed",
  "blocked",
  "failed"
]);
export type ToolProposalStatus = z.infer<typeof ToolProposalStatusSchema>;

export const InputModeSchema = z.enum(["chat", "voice"]).default("chat");
export type InputMode = z.infer<typeof InputModeSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Session = z.infer<typeof SessionSchema>;

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
  provider: z.string(),
  toolName: z.string(),
  operation: z.string(),
  args: z.record(z.unknown()),
  requiredScopes: z.array(z.string()).default([]),
  riskLevel: RiskLevelSchema,
  approvalMode: ApprovalModeSchema,
  status: ToolProposalStatusSchema,
  dryRunSummary: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable().default(null),
  executedAt: z.string().nullable().default(null)
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
  "memory.stored",
  "memory.deleted",
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
  embeddingId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

export const MemoryRelationshipSchema = z.object({
  id: z.string(),
  fromEntity: z.string(),
  relationship: z.string(),
  toEntity: z.string(),
  sourceFactId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type MemoryRelationship = z.infer<typeof MemoryRelationshipSchema>;

export const MemorySearchResultSchema = MemoryFactSchema.extend({
  score: z.number().optional()
});
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;

export const ChatRequestSchema = z.object({
  sessionId: z.string().optional(),
  message: z.string().min(1),
  preferredModel: z.string().optional(),
  inputMode: InputModeSchema.optional()
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({
  sessionId: z.string(),
  correlationId: z.string(),
  message: ChatMessageSchema,
  toolResults: z.array(ToolResultSchema),
  approvals: z.array(ApprovalRequestSchema),
  memories: z.array(MemorySearchResultSchema).default([]),
  storedMemories: z.array(MemoryFactSchema).default([])
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export const ApprovalDecisionRequestSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().optional()
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export const MemoryCreateRequestSchema = z.object({
  subject: z.string().default("user"),
  predicate: z.string().default("memory"),
  object: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.8)
});
export type MemoryCreateRequest = z.infer<typeof MemoryCreateRequestSchema>;
