import { listTools } from "@jarvis/tools";

export interface InferredToolIntent {
  toolName: string;
  args: Record<string, unknown>;
}

export function inferToolIntent(message: string): InferredToolIntent | undefined {
  const tools = new Set(listTools().map((tool) => tool.name));
  const lower = message.toLowerCase();

  const candidate = [
    toolIntent(tools, message, "google.calendar.create_event", /\b(create|add|book|schedule)\b.*\b(calendar|event|meeting)\b/i, {
      summary: extractTitle(message) ?? "New event",
      startIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      endIso: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }),
    toolIntent(tools, message, "google.calendar.read_schedule", /\b(calendar|schedule|agenda|meetings?)\b/i, {
      query: message
    }),
    toolIntent(tools, message, "google.gmail.create_draft", /\b(draft|gmail draft|email draft|write an email)\b/i, {
      query: message,
      subject: extractSubject(message),
      body: message
    }),
    toolIntent(tools, message, "google.drive.list_files", /\b(drive|google drive|files?|docs?)\b/i, {
      query: stripProviderWords(message, ["drive", "google drive", "files", "file", "docs"])
    }),
    toolIntent(tools, message, "search.web", /\b(search|look up|web|internet|latest|current)\b/i, {
      query: stripProviderWords(message, ["search", "look up", "web", "internet"]),
      count: 5
    }),
    toolIntent(tools, message, "finance.plaid.transactions", /\b(spending|transactions?|purchases?|expenses?)\b/i, {
      count: 25
    }),
    toolIntent(tools, message, "finance.plaid.balances", /\b(balance|balances|bank accounts?|credit)\b/i, {}),
    toolIntent(tools, message, "finance.plaid.investments", /\b(robinhood|portfolio|holdings|investments?)\b/i, {}),
    toolIntent(tools, message, "tesla.vehicle.command", /\b(tesla|vehicle|car)\b.*\b(start charging|stop charging|climate|wake)\b/i, {
      command: inferTeslaCommand(lower),
      parameters: {}
    }),
    toolIntent(tools, message, "tesla.vehicle.status", /\b(tesla|vehicle|car)\b/i, {})
  ].find(Boolean);

  return candidate;
}

function toolIntent(
  registeredTools: Set<string>,
  message: string,
  toolName: string,
  pattern: RegExp,
  args: Record<string, unknown>
): InferredToolIntent | undefined {
  if (!registeredTools.has(toolName) || !pattern.test(message)) {
    return undefined;
  }

  return { toolName, args };
}

function stripProviderWords(message: string, words: string[]): string {
  let cleaned = message;
  for (const word of words) {
    cleaned = cleaned.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi"), " ");
  }
  return cleaned.replace(/\s+/g, " ").trim() || message;
}

function extractSubject(message: string): string | undefined {
  const match = message.match(/\bsubject[:\s]+(.+)$/i);
  return match?.[1]?.trim();
}

function extractTitle(message: string): string | undefined {
  const match = message.match(/\b(?:called|titled|named)\s+["']?([^"']+)["']?/i);
  return match?.[1]?.trim();
}

function inferTeslaCommand(message: string): string {
  if (/\b(start charging|charge start)\b/i.test(message)) {
    return "charge_start";
  }
  if (/\b(stop charging|charge stop)\b/i.test(message)) {
    return "charge_stop";
  }
  if (/\b(stop climate|turn off climate)\b/i.test(message)) {
    return "auto_conditioning_stop";
  }
  if (/\b(climate|heat|cool)\b/i.test(message)) {
    return "auto_conditioning_start";
  }
  return "wake_up";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
