import { z } from "zod";
import {
  getToolDefinition,
  listModelToolCards,
  type ModelToolCard
} from "@myla/tools";
import type { ModelRoute, PrivacyClass } from "@myla/shared";
import { callMlWorker } from "./modelClient.js";
import { inferToolIntent } from "./toolIntent.js";

interface PlannerConversationMessage {
  actor: string;
  content: string;
  createdAt?: string;
}

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

const AgentFinalStepSchema = z.object({
  kind: z.literal("final"),
  message: z.string().min(1)
});

const AgentClarificationStepSchema = z.object({
  kind: z.literal("clarification"),
  message: z.string().min(1),
  missingFields: z.array(z.string()).default([])
});

const AgentToolStepSchema = PlannedToolCallSchema.extend({
  kind: z.literal("tool").default("tool")
});

export interface AgentToolObservation {
  stepIndex: number;
  toolName: string;
  status: string;
  notification: string;
  data?: unknown;
}

export interface ToolPlanningTrace {
  selectedToolNames: string[];
  rawModelResponse: string | null;
  plannerResult: string;
  fallbackReason: string | null;
  validationErrors: string[];
}

export type ToolPlanningResult = (
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
    }
) & { trace?: ToolPlanningTrace };

export type AgentNextStepPlanningResult = (
  | {
      kind: "tool";
      plan: PlannedToolCall;
      plannedBy: "model" | "fallback";
    }
  | {
      kind: "clarification";
      message: string;
      missingFields?: string[];
      plan?: PlannedToolCall;
    }
  | {
      kind: "final";
      message: string;
    }
  | {
      kind: "none";
      reason: string;
    }
) & { trace?: ToolPlanningTrace };

export async function planToolCall(input: {
  message: string;
  sessionId: string;
  correlationId: string;
  privacyClass: PrivacyClass;
  route: ModelRoute;
  preferredModel?: string;
  conversationContext?: PlannerConversationMessage[];
}): Promise<ToolPlanningResult> {
  const toolCards = selectRelevantToolCards(input.message, input.conversationContext);
  const selectedToolNames = toolCards.map((card) => card.name);
  if (toolCards.length === 0) {
    const fallback = fallbackPlanning(input.message);
    return attachTrace(fallback, {
      selectedToolNames,
      rawModelResponse: null,
      plannerResult: fallback.kind,
      fallbackReason: fallback.kind === "none" ? fallback.reason : "No relevant tool cards selected.",
      validationErrors: []
    });
  }

  const modelResponse = await callMlWorker({
    prompt: buildPlannerPrompt(input.message, toolCards, input.conversationContext),
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    retrievedContext: [],
    privacyClass: input.privacyClass,
    route: input.route,
    preferredModel: input.preferredModel
  });

  const planned = parseToolPlannerResponse(modelResponse.text);
  if (planned) {
    const validated = validatePlannedToolCall(planned, {
      message: input.message,
      conversationContext: input.conversationContext
    });
    if (validated.kind === "tool") {
      return attachTrace({ ...validated, plannedBy: "model" as const }, {
        selectedToolNames,
        rawModelResponse: modelResponse.text,
        plannerResult: "tool",
        fallbackReason: null,
        validationErrors: []
      });
    }

    const fallback = fallbackPlanning(input.message);
    if (fallback.kind === "tool") {
      return attachTrace(fallback, {
        selectedToolNames,
        rawModelResponse: modelResponse.text,
        plannerResult: "tool",
        fallbackReason: "Model plan did not validate; deterministic fallback produced a tool.",
        validationErrors: validated.kind === "clarification" ? [validated.message] : []
      });
    }

    if (validated.kind === "clarification") {
      return attachTrace(validated, {
        selectedToolNames,
        rawModelResponse: modelResponse.text,
        plannerResult: "clarification",
        fallbackReason: fallback.kind === "none" ? fallback.reason : null,
        validationErrors: [validated.message]
      });
    }
  }

  const fallback = fallbackPlanning(input.message);
  return attachTrace(fallback, {
    selectedToolNames,
    rawModelResponse: modelResponse.text,
    plannerResult: fallback.kind,
    fallbackReason: planned ? "Parsed model plan did not produce a valid result." : "Model response did not contain parseable tool JSON.",
    validationErrors: []
  });
}

export async function planAgentNextStep(input: {
  goal: string;
  sessionId: string;
  correlationId: string;
  privacyClass: PrivacyClass;
  route: ModelRoute;
  preferredModel?: string;
  conversationContext?: PlannerConversationMessage[];
  observations?: AgentToolObservation[];
  remainingSteps: number;
  remainingToolCalls: number;
}): Promise<AgentNextStepPlanningResult> {
  const observations = input.observations ?? [];
  const toolCards = selectRelevantToolCards(
    [input.goal, ...observations.map((observation) => `${observation.toolName}: ${observation.notification}`)].join("\n"),
    input.conversationContext
  );
  const selectedToolNames = toolCards.map((card) => card.name);
  if (toolCards.length === 0) {
    const fallback = observations.length > 0 ? finalFromObservations(observations) : fallbackPlanning(input.goal);
    return attachTrace(fallback, {
      selectedToolNames,
      rawModelResponse: null,
      plannerResult: fallback.kind,
      fallbackReason: fallback.kind === "none" ? fallback.reason : "No relevant tool cards selected.",
      validationErrors: []
    });
  }

  const modelResponse = await callMlWorker({
    prompt: buildAgentPlannerPrompt(input.goal, toolCards, {
      conversationContext: input.conversationContext,
      observations,
      remainingSteps: input.remainingSteps,
      remainingToolCalls: input.remainingToolCalls
    }),
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    retrievedContext: [],
    privacyClass: input.privacyClass,
    route: input.route,
    preferredModel: input.preferredModel
  });

  const parsed = parseAgentPlannerResponse(modelResponse.text);
  if (parsed) {
    const validated = validateAgentNextStep(parsed, {
      message: input.goal,
      conversationContext: input.conversationContext
    });
    if (validated.kind !== "none") {
      return attachTrace(validated, {
        selectedToolNames,
        rawModelResponse: modelResponse.text,
        plannerResult: validated.kind,
        fallbackReason: null,
        validationErrors: validated.kind === "clarification" ? [validated.message] : []
      });
    }
  }

  const fallback = observations.length > 0 ? finalFromObservations(observations) : fallbackPlanning(input.goal);
  return attachTrace(fallback, {
    selectedToolNames,
    rawModelResponse: modelResponse.text,
    plannerResult: fallback.kind,
    fallbackReason: parsed ? "Parsed agent step did not validate." : "Model response did not contain parseable agent step JSON.",
    validationErrors: []
  });
}

export function selectRelevantToolCards(message: string, conversationContext: PlannerConversationMessage[] = []): ModelToolCard[] {
  const cards = listModelToolCards();
  const lower = [message, ...conversationContext.map((entry) => entry.content)].join("\n").toLowerCase();
  const selected = cards.filter((card) => {
    const haystack = [card.name, card.provider, card.operation, card.description].join(" ").toLowerCase();
    return (
      (/\b(calendar|event|meeting|schedule|book|reschedule|update|delete|cancel|lunch|dinner|time|tmrw|tomorrow)\b/.test(lower) &&
        haystack.includes("calendar")) ||
      (/\b(email|gmail|draft|send|write|inbox|thread|message)\b/.test(lower) && haystack.includes("gmail")) ||
      (/\b(drive|file|doc|document|summarize|read)\b/.test(lower) && haystack.includes("drive")) ||
      (/\b(search|web|internet|latest|look up)\b/.test(lower) && haystack.includes("search")) ||
      (/\b(tesla|car|vehicle)\b/.test(lower) && haystack.includes("tesla")) ||
      (/\b(bank|finance|spending|transaction|portfolio|robinhood)\b/.test(lower) && haystack.includes("plaid")) ||
      (/\b(pushcut|shortcut|shortcuts|iphone|ios|imessage|sms|text|tesla|car|vehicle|lock|unlock)\b/.test(lower) &&
        haystack.includes("pushcut"))
    );
  });

  return selected.length > 0
    ? selected.sort((left, right) => relevanceScore(right, lower) - relevanceScore(left, lower)).slice(0, 5)
    : cards.slice(0, 5);
}

function relevanceScore(card: ModelToolCard, lower: string): number {
  let score = 0;
  if (lower.includes(card.provider)) {
    score += 10;
  }
  for (const part of card.name.split(".")) {
    if (lower.includes(part.replace(/_/g, " "))) {
      score += 4;
    }
  }
  if (lower.includes("gmail") && card.name.includes("gmail")) {
    score += 8;
  }
  if (lower.includes("drive") && card.name.includes("drive")) {
    score += 8;
  }
  if (lower.includes("calendar") && card.name.includes("calendar")) {
    score += 8;
  }
  if (/\b(update|reschedule)\b/.test(lower) && card.name.includes("update")) {
    score += 6;
  }
  if (/\b(delete|cancel)\b/.test(lower) && card.name.includes("delete")) {
    score += 6;
  }
  if (/\b(read|summarize)\b/.test(lower) && card.name.includes("read")) {
    score += 6;
  }
  if (/\b(search|find)\b/.test(lower) && card.name.includes("search")) {
    score += 6;
  }
  if (/\b(pushcut|shortcut|shortcuts|iphone|ios|imessage|sms|text|tesla|car|vehicle|lock|unlock)\b/.test(lower) && card.name.includes("pushcut")) {
    score += 8;
  }
  return score;
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

export function parseAgentPlannerResponse(
  text: string
): z.infer<typeof AgentFinalStepSchema> | z.infer<typeof AgentClarificationStepSchema> | z.infer<typeof AgentToolStepSchema> | undefined {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!candidate || typeof candidate !== "object") {
      return undefined;
    }

    const kind = (candidate as { kind?: unknown }).kind;
    if (kind === "final") {
      return AgentFinalStepSchema.parse(candidate);
    }
    if (kind === "clarification") {
      return AgentClarificationStepSchema.parse(candidate);
    }

    return AgentToolStepSchema.parse({ kind: "tool", ...(candidate as Record<string, unknown>) });
  } catch {
    return undefined;
  }
}

export function validatePlannedToolCall(
  plan: PlannedToolCall,
  context: { message?: string; conversationContext?: PlannerConversationMessage[] } = {}
): ToolPlanningResult {
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

  const temporalClarification = validateCalendarTemporalConsistency(plan.toolName, parsed.data, context);
  if (temporalClarification) {
    return temporalClarification;
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

export function validateAgentNextStep(
  step:
    | z.infer<typeof AgentFinalStepSchema>
    | z.infer<typeof AgentClarificationStepSchema>
    | z.infer<typeof AgentToolStepSchema>,
  context: { message?: string; conversationContext?: PlannerConversationMessage[] } = {}
): AgentNextStepPlanningResult {
  if (step.kind === "final") {
    return {
      kind: "final",
      message: step.message
    };
  }

  if (step.kind === "clarification") {
    return {
      kind: "clarification",
      message: step.message,
      missingFields: step.missingFields
    };
  }

  const validated = validatePlannedToolCall(step, context);
  if (validated.kind === "tool") {
    return { ...validated, plannedBy: "model" };
  }
  return validated;
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

function attachTrace<T extends { kind: string }>(result: T, trace: ToolPlanningTrace): T & { trace: ToolPlanningTrace } {
  return { ...result, trace };
}

function finalFromObservations(observations: AgentToolObservation[]): AgentNextStepPlanningResult {
  const executed = observations.filter((observation) => observation.status === "executed");
  if (executed.length === 0) {
    return {
      kind: "final",
      message: observations.at(-1)?.notification ?? "I could not complete the requested tool workflow."
    };
  }

  return {
    kind: "final",
    message: executed.map((observation) => observation.notification).join("\n\n")
  };
}

function buildPlannerPrompt(
  message: string,
  toolCards: ModelToolCard[],
  conversationContext: PlannerConversationMessage[] = []
): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const contextBlock = conversationContext
    .slice(-8)
    .map((entry) => `${entry.actor}${entry.createdAt ? ` at ${entry.createdAt}` : ""}: ${entry.content}`)
    .join("\n");

  return `You are a structured tool planner. Convert the user request into exactly one JSON object.

Return JSON only. Do not use markdown.

${buildPlannerDateContext(timeZone)}

Rules:
- Pick one tool from the provided tool cards, or set needsClarification=true if required details are missing.
- When needsClarification=true, write clarificationQuestion as one direct, friendly question the user can answer in one sentence.
- The clarificationQuestion must name the missing information in plain language, not schema names. Example: "What date range should I check on your calendar?"
- Ask only for details required to continue safely; do not ask about optional fields unless the user explicitly requested them.
- If the current request answers a prior assistant clarification for a pending tool, carry forward the prior details and fill the missing args.
- Existing details from the conversation carry forward unless the user clearly changes them.
- Fill all required args exactly as the schema requires.
- Use ISO-8601 datetimes with timezone offsets for fields named startIso, endIso, timeMin, or timeMax.
- Interpret "tmrw" as tomorrow using the server date facts above.
- Use the server date facts above for weekday/date math; do not recalculate weekday names from memory.
- For lunch or "1230 to 130" in a lunch context, assume 12:30 PM to 1:30 PM and include that assumption.
- For Gmail drafts, write a polished subject and body. Do not copy the user's request as the body. Sign the email with "Best,\\nNick" unless the user asks for a different sign-off.
- Do not invent recipients, dates, or times that are not present or strongly implied.
- For write actions, include assumptions so the application can show them before execution.
- For calendar events, include location when the user gives one.

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

Conversation context:
${contextBlock || "(none)"}

User request:
${message}`;
}

function buildAgentPlannerPrompt(
  goal: string,
  toolCards: ModelToolCard[],
  input: {
    conversationContext?: PlannerConversationMessage[];
    observations: AgentToolObservation[];
    remainingSteps: number;
    remainingToolCalls: number;
  }
): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const contextBlock = (input.conversationContext ?? [])
    .slice(-8)
    .map((entry) => `${entry.actor}${entry.createdAt ? ` at ${entry.createdAt}` : ""}: ${entry.content}`)
    .join("\n");
  const observationBlock =
    input.observations.length > 0
      ? JSON.stringify(
          input.observations.map((observation) => ({
            stepIndex: observation.stepIndex,
            toolName: observation.toolName,
            status: observation.status,
            notification: observation.notification,
            data: observation.data
          })),
          null,
          2
        )
      : "(none)";

  return `You are a bounded multi-step tool planner. Decide exactly one next step toward the user's goal.

Return JSON only. Do not use markdown.

${buildPlannerDateContext(timeZone)}

Rules:
- Choose kind="tool" when another tool result is required to satisfy the goal.
- Choose kind="final" when the observations are sufficient to answer the user.
- Choose kind="clarification" when a required detail is missing or a safe action cannot be planned.
- Never invent tool outputs. Use only the observations shown below.
- Do not repeat a tool call unless the previous result failed and retrying with changed args is useful.
- Respect the remaining budgets: ${input.remainingSteps} planner steps and ${input.remainingToolCalls} tool calls.
- For write actions, include assumptions so the app can show them before execution.
- For Gmail drafts, write a polished subject and body. Sign with "Best,\\nNick" unless requested otherwise.
- Use ISO-8601 datetimes with timezone offsets for fields named startIso, endIso, timeMin, or timeMax.

Output shapes:
Tool:
{
  "kind": "tool",
  "intent": "short intent name",
  "toolName": "one tool name",
  "args": {},
  "confidence": 0.0,
  "assumptions": [],
  "missingFields": [],
  "needsClarification": false,
  "clarificationQuestion": ""
}

Clarification:
{
  "kind": "clarification",
  "message": "one direct question",
  "missingFields": []
}

Final:
{
  "kind": "final",
  "message": "answer grounded in observations"
}

Tool cards:
${JSON.stringify(toolCards, null, 2)}

Conversation context:
${contextBlock || "(none)"}

Tool observations:
${observationBlock}

User goal:
${goal}`;
}

function buildPlannerDateContext(timeZone: string): string {
  const now = new Date();
  const today = dateAtLocalNoon(now, 0);
  const tomorrow = dateAtLocalNoon(now, 1);

  return [
    `Current date/time: ${now.toISOString()}`,
    `User timezone: ${timeZone}`,
    `Today: ${formatDateFact(today, timeZone)} (${formatDateKey(today, timeZone)})`,
    `Tomorrow: ${formatDateFact(tomorrow, timeZone)} (${formatDateKey(tomorrow, timeZone)})`
  ].join("\n");
}

function validateCalendarTemporalConsistency(
  toolName: string,
  args: Record<string, unknown>,
  context: { message?: string; conversationContext?: PlannerConversationMessage[] }
): ToolPlanningResult | undefined {
  if (toolName !== "google.calendar.create_event" && toolName !== "google.calendar.read_schedule") {
    return undefined;
  }

  const timeZone = stringArg(args.timeZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const text = [context.message, ...(context.conversationContext ?? []).map((entry) => entry.content)]
    .filter(Boolean)
    .join("\n");
  const dateFactConflict = findDateFactConflict(text, timeZone);
  if (dateFactConflict) {
    return {
      kind: "clarification",
      message: dateFactConflict
    };
  }

  const expectedDate = inferExpectedCalendarDate(text, timeZone);
  if (!expectedDate) {
    return undefined;
  }

  const actualStart = stringArg(args.startIso) ?? stringArg(args.timeMin);
  if (!actualStart) {
    return undefined;
  }

  const actualDate = new Date(actualStart);
  if (Number.isNaN(actualDate.getTime())) {
    return undefined;
  }

  if (formatDateKey(actualDate, timeZone) !== expectedDate.key) {
    return {
      kind: "clarification",
      message: `I resolved the date as ${formatDateFact(expectedDate.date, timeZone)}, but the planned tool call used ${formatDateFact(
        actualDate,
        timeZone
      )}. Please confirm the exact date before I use the calendar.`
    };
  }

  return undefined;
}

function findDateFactConflict(text: string, timeZone: string): string | undefined {
  const monthDayFacts = extractMonthDayFacts(text, timeZone);
  const weekdayFacts = [
    ...monthDayFacts
      .flatMap((fact) =>
        fact.weekday
          ? [
              {
                label: fact.label,
                expected: weekdayName(fact.date, timeZone),
                stated: fact.weekday
              }
            ]
          : []
      ),
    ...extractRelativeWeekdayFacts(text, timeZone)
  ];

  const conflict = weekdayFacts.find((fact) => fact.stated && fact.stated !== fact.expected);
  if (!conflict) {
    return undefined;
  }

  return `I see a date mismatch: ${conflict.label} is a ${titleCase(conflict.expected)}, but the request says ${titleCase(
    conflict.stated
  )}. Please confirm which date you want.`;
}

function inferExpectedCalendarDate(text: string, timeZone: string): { date: Date; key: string } | undefined {
  if (/\b(tmrw|tomorrow)\b/i.test(text)) {
    const date = dateAtLocalNoon(new Date(), 1);
    return { date, key: formatDateKey(date, timeZone) };
  }

  const explicitDate = extractMonthDayFacts(text, timeZone).at(-1)?.date;
  if (explicitDate) {
    return { date: explicitDate, key: formatDateKey(explicitDate, timeZone) };
  }

  if (/\btoday\b/i.test(text)) {
    const date = dateAtLocalNoon(new Date(), 0);
    return { date, key: formatDateKey(date, timeZone) };
  }

  return undefined;
}

function extractRelativeWeekdayFacts(text: string, timeZone: string): Array<{ label: string; expected: string; stated: string }> {
  const facts: Array<{ label: string; expected: string; stated: string }> = [];
  const todayMatch = text.match(/\btoday\s+(?:is\s+)?(?:[a-z]+\s+\d{1,2}\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (todayMatch?.[1]) {
    const date = dateAtLocalNoon(new Date(), 0);
    facts.push({ label: "today", expected: weekdayName(date, timeZone), stated: todayMatch[1].toLowerCase() });
  }

  const tomorrowMatch = text.match(
    /\btomorrow\s+(?:is\s+)?(?:[a-z]+\s+\d{1,2}\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
  );
  if (tomorrowMatch?.[1]) {
    const date = dateAtLocalNoon(new Date(), 1);
    facts.push({ label: "tomorrow", expected: weekdayName(date, timeZone), stated: tomorrowMatch[1].toLowerCase() });
  }

  return facts;
}

function extractMonthDayFacts(
  text: string,
  timeZone: string
): Array<{ date: Date; label: string; weekday?: string }> {
  const facts: Array<{ date: Date; label: string; weekday?: string }> = [];
  const pattern =
    /\b(?:(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday))?\b/gi;

  for (const match of text.matchAll(pattern)) {
    const month = match[2] ? monthIndex(match[2]) : undefined;
    const day = match[3] ? Number(match[3]) : NaN;
    if (month === undefined || !Number.isFinite(day) || day < 1 || day > 31) {
      continue;
    }

    const date = new Date(new Date().getFullYear(), month, day, 12, 0, 0, 0);
    facts.push({
      date,
      label: `${titleCase(match[2]!)} ${day}`,
      weekday: (match[1] ?? match[4])?.toLowerCase()
    });
  }

  // A second pattern catches "June 26 is Friday" and "June 26th as Friday".
  const trailingWeekdayPattern =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:is|as)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
  for (const match of text.matchAll(trailingWeekdayPattern)) {
    const month = match[1] ? monthIndex(match[1]) : undefined;
    const day = match[2] ? Number(match[2]) : NaN;
    if (month === undefined || !Number.isFinite(day) || day < 1 || day > 31) {
      continue;
    }

    facts.push({
      date: new Date(new Date().getFullYear(), month, day, 12, 0, 0, 0),
      label: `${titleCase(match[1]!)} ${day}`,
      weekday: match[3]?.toLowerCase()
    });
  }

  return facts.map((fact) => ({
    ...fact,
    label: `${fact.label}, ${new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(fact.date)}`
  }));
}

function dateAtLocalNoon(base: Date, dayOffset: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, 12, 0, 0, 0);
}

function formatDateFact(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone
  }).format(date);
}

function formatDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function weekdayName(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(date).toLowerCase();
}

function monthIndex(value: string): number | undefined {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = months.findIndex((month) => value.toLowerCase().startsWith(month));
  return index === -1 ? undefined : index;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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

  return `What ${humanReadableMissingFields(plan.missingFields)} should I use before I continue with ${humanReadableToolName(plan.toolName)}?`;
}

function clarificationForZodError(prompts: Record<string, string>, error: z.ZodError): string {
  const field = error.issues[0]?.path?.[0];
  if (typeof field === "string" && prompts[field]) {
    return prompts[field];
  }

  return "I need a little more detail before I can use that tool safely.";
}

function humanReadableMissingFields(fields: string[]): string {
  if (fields.length === 0) {
    return "missing detail";
  }

  return fields.map(humanReadableFieldName).join(fields.length === 2 ? " and " : ", ");
}

function humanReadableFieldName(field: string): string {
  return field
    .replace(/Iso$/i, "")
    .replace(/Id$/i, "")
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

function humanReadableToolName(toolName: string): string {
  return toolName
    .replace(/^google\./, "")
    .replace(/[._-]+/g, " ")
    .replace(/\bread schedule\b/i, "checking your calendar")
    .replace(/\bcreate event\b/i, "creating the calendar event")
    .replace(/\bcreate draft\b/i, "drafting the email")
    .replace(/\bsend draft\b/i, "sending the draft");
}
