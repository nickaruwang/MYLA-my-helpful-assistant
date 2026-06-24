import { z } from "zod";
import {
  getToolDefinition,
  listModelToolCards,
  type ModelToolCard
} from "@jarvis/tools";
import type { ModelRoute, PrivacyClass } from "@jarvis/shared";
import { callMlWorker } from "./modelClient.js";
import { inferToolIntent } from "./toolIntent.js";

const PlannedToolCallSchema = z.object({
  intent: z.string().optional(),
  toolName: z.string(),
  args: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1).default(0.5),
  assumptions: z.array(z.string()).default([]),
  missingFields: z.array(z.string()).default([]),
  needsClarification: z.boolean().default(false),
  clarificationQuestion: z.string().optional()
});

export type PlannedToolCall = z.infer<typeof PlannedToolCallSchema>;

export type ToolPlanningResult =
  | {
      kind: "tool";
      plan: PlannedToolCall;
      plannedBy: "model" | "fallback";
    }
  | {
      kind: "clarification";
      message: string;
      plan?: PlannedToolCall;
    }
  | {
      kind: "none";
      reason: string;
    };

export async function planToolCall(input: {
  message: string;
  sessionId: string;
  correlationId: string;
  privacyClass: PrivacyClass;
  route: ModelRoute;
  preferredModel?: string;
}): Promise<ToolPlanningResult> {
  const toolCards = selectRelevantToolCards(input.message);
  if (toolCards.length === 0) {
    return fallbackPlanning(input.message);
  }

  const modelResponse = await callMlWorker({
    prompt: buildPlannerPrompt(input.message, toolCards),
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    retrievedContext: [],
    privacyClass: input.privacyClass,
    route: input.route,
    preferredModel: input.preferredModel
  });

  const planned = parseToolPlannerResponse(modelResponse.text);
  if (planned) {
    const validated = validatePlannedToolCall(planned);
    if (validated.kind === "tool") {
      return { ...validated, plannedBy: "model" };
    }

    const fallback = fallbackPlanning(input.message);
    if (fallback.kind === "tool") {
      return fallback;
    }

    if (validated.kind === "clarification") {
      return validated;
    }
  }

  return fallbackPlanning(input.message);
}

export function selectRelevantToolCards(message: string): ModelToolCard[] {
  const cards = listModelToolCards();
  const lower = message.toLowerCase();
  const selected = cards.filter((card) => {
    const haystack = [card.name, card.provider, card.operation, card.description].join(" ").toLowerCase();
    return (
      (/\b(calendar|event|meeting|schedule|book|lunch|dinner|time|tmrw|tomorrow)\b/.test(lower) &&
        haystack.includes("calendar")) ||
      (/\b(email|gmail|draft|send|write)\b/.test(lower) && haystack.includes("gmail")) ||
      (/\b(drive|file|doc)\b/.test(lower) && haystack.includes("drive")) ||
      (/\b(search|web|internet|latest|look up)\b/.test(lower) && haystack.includes("search")) ||
      (/\b(tesla|car|vehicle)\b/.test(lower) && haystack.includes("tesla")) ||
      (/\b(bank|finance|spending|transaction|portfolio|robinhood)\b/.test(lower) && haystack.includes("plaid"))
    );
  });

  return selected.length > 0 ? selected.slice(0, 5) : cards.slice(0, 5);
}

export function parseToolPlannerResponse(text: string): PlannedToolCall | undefined {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
    return PlannedToolCallSchema.parse(candidate);
  } catch {
    return undefined;
  }
}

export function validatePlannedToolCall(plan: PlannedToolCall): ToolPlanningResult {
  if (plan.needsClarification || plan.missingFields.length > 0) {
    return {
      kind: "clarification",
      message: plan.clarificationQuestion ?? clarificationForMissingFields(plan)
    };
  }

  const tool = getToolDefinition(plan.toolName);
  if (!tool) {
    return { kind: "none", reason: `Unknown tool ${plan.toolName}` };
  }

  const parsed = tool.argsSchema.safeParse(plan.args);
  if (!parsed.success) {
    return {
      kind: "clarification",
      message: clarificationForZodError(tool.clarificationPrompts ?? {}, parsed.error)
    };
  }

  return {
    kind: "tool",
    plannedBy: "model",
    plan: {
      ...plan,
      args: parsed.data
    }
  };
}

function fallbackPlanning(message: string): ToolPlanningResult {
  const fallback = inferToolIntent(message);
  if (!fallback) {
    return { kind: "none", reason: "No matching tool intent." };
  }

  const validated = validatePlannedToolCall({
    toolName: fallback.toolName,
    args: fallback.args,
    confidence: 0.4,
    assumptions: ["Used deterministic fallback routing."],
    missingFields: [],
    needsClarification: false
  });

  return validated.kind === "tool" ? { ...validated, plannedBy: "fallback" } : validated;
}

function buildPlannerPrompt(message: string, toolCards: ModelToolCard[]): string {
  return `You are a structured tool planner. Convert the user request into exactly one JSON object.

Return JSON only. Do not use markdown.

Current date/time: ${new Date().toISOString()}
User timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}

Rules:
- Pick one tool from the provided tool cards, or set needsClarification=true if required details are missing.
- Fill all required args exactly as the schema requires.
- Use ISO-8601 datetimes with timezone offsets for fields named startIso, endIso, timeMin, or timeMax.
- Interpret "tmrw" as tomorrow.
- For lunch or "1230 to 130" in a lunch context, assume 12:30 PM to 1:30 PM and include that assumption.
- For Gmail drafts, write a polished subject and body. Do not copy the user's request as the body. Sign the email with "Best,\\nNick" unless the user asks for a different sign-off.
- Do not invent recipients, dates, or times that are not present or strongly implied.
- For write actions, include assumptions so the application can show them before execution.

Output shape:
{
  "intent": "short intent name",
  "toolName": "one tool name",
  "args": {},
  "confidence": 0.0,
  "assumptions": [],
  "missingFields": [],
  "needsClarification": false,
  "clarificationQuestion": ""
}

Tool cards:
${JSON.stringify(toolCards, null, 2)}

User request:
${message}`;
}

function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    return undefined;
  }

  return text.slice(first, last + 1);
}

function clarificationForMissingFields(plan: PlannedToolCall): string {
  if (plan.clarificationQuestion) {
    return plan.clarificationQuestion;
  }

  return `I need more information before using ${plan.toolName}: ${plan.missingFields.join(", ")}.`;
}

function clarificationForZodError(prompts: Record<string, string>, error: z.ZodError): string {
  const field = error.issues[0]?.path?.[0];
  if (typeof field === "string" && prompts[field]) {
    return prompts[field];
  }

  return "I need a little more detail before I can use that tool safely.";
}
