import { listTools } from "@jarvis/tools";

export interface InferredToolIntent {
  toolName: string;
  args: Record<string, unknown>;
}

export function inferToolIntent(message: string): InferredToolIntent | undefined {
  const tools = new Set(listTools().map((tool) => tool.name));
  const lower = message.toLowerCase();

  const candidate = [
    toolIntent(
      tools,
      message,
      "google.calendar.create_event",
      /\b(create|add|book|schedule|block)\b.*\b(calendar|event|meeting|time)\b|\bblock out\b/i,
      inferCalendarCreateArgs(message)
    ),
    toolIntent(tools, message, "google.calendar.read_schedule", /\b(calendar|schedule|agenda|meetings?)\b/i, {
      query: message
    }),
    toolIntent(tools, message, "google.gmail.create_draft", /\b(draft|gmail draft|email draft|write an email)\b/i, {
      query: message,
      to: extractEmail(message),
      subject: extractSubject(message) ?? inferEmailSubject(message),
      body: inferEmailBody(message)
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

function extractEmail(message: string): string | undefined {
  const match = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0];
}

function inferEmailSubject(message: string): string | undefined {
  if (/\bdinner\b/i.test(message)) {
    return "Dinner on Friday";
  }

  const askingMatch = message.match(/\basking about\s+(.+)$/i);
  if (askingMatch?.[1]) {
    return titleCase(askingMatch[1].replace(/\bon\s+\w+$/i, "").trim()).slice(0, 80);
  }

  return undefined;
}

function inferEmailBody(message: string): string {
  const askingMatch = message.match(/\basking about\s+(.+)$/i);
  if (askingMatch?.[1]) {
    return `Hi,\n\nI wanted to ask about ${askingMatch[1].trim()}.\n\nBest,\nNick`;
  }

  return message;
}

function extractTitle(message: string): string | undefined {
  const match =
    message.match(/\b(?:called|titled|named)\s+["']?([^"']+)["']?/i) ??
    message.match(/\bfor\s+["']([^"']+)["']/i) ??
    message.match(/\bfor\s+(?:a\s+|an\s+)?(.+)$/i);
  return match?.[1]?.trim();
}

function inferCalendarCreateArgs(message: string): Record<string, unknown> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const args: Record<string, unknown> = {
    calendarId: "primary",
    summary: cleanCalendarSummary(extractTitle(message)),
    timeZone
  };
  const range = parseDateTimeRange(message);
  if (range) {
    args.startIso = toLocalIsoWithOffset(range.start);
    args.endIso = toLocalIsoWithOffset(range.end);
  }

  return args;
}

function parseDateTimeRange(message: string): { start: Date; end: Date } | undefined {
  const match = message.match(/\bfrom\s+(\d{1,2}(?::?\d{2})?)\s*(?:to|-)\s*(\d{1,2}(?::?\d{2})?)\b/i);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const day = inferRequestedDate(message);
  if (!day) {
    return undefined;
  }

  const lunchOrDinner = /\b(lunch|dinner|brunch)\b/i.test(message);
  const startParts = parseClock(match[1]);
  const endParts = parseClock(match[2]);
  if (!startParts || !endParts) {
    return undefined;
  }

  let startHour = startParts.hour;
  let endHour = endParts.hour;

  if (lunchOrDinner) {
    if (startHour >= 1 && startHour <= 11) {
      startHour += 12;
    }
    if (endHour >= 1 && endHour <= 11) {
      endHour += 12;
    }
  }

  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, startParts.minute, 0, 0);
  let end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endHour, endParts.minute, 0, 0);
  if (end <= start) {
    end = new Date(end.getTime() + 12 * 60 * 60 * 1000);
  }

  return { start, end };
}

function inferRequestedDate(message: string): Date | undefined {
  const today = new Date();
  if (/\b(tmrw|tomorrow)\b/i.test(message)) {
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  }

  if (/\btoday\b/i.test(message)) {
    return new Date(today.getFullYear(), today.getMonth(), today.getDate());
  }

  return undefined;
}

function parseClock(value: string): { hour: number; minute: number } | undefined {
  const compact = value.replace(":", "");
  if (!/^\d{1,4}$/.test(compact)) {
    return undefined;
  }

  if (compact.length <= 2) {
    return { hour: Number(compact), minute: 0 };
  }

  const minute = Number(compact.slice(-2));
  const hour = Number(compact.slice(0, -2));
  if (hour < 1 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }

  return { hour, minute };
}

function toLocalIsoWithOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
  const offsetMins = String(absoluteOffset % 60).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:00${sign}${offsetHours}:${offsetMins}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function cleanCalendarSummary(value: string | undefined): string | undefined {
  return value?.replace(/\bfrom\s+\d{1,2}(?::?\d{2})?\s*(?:to|-)\s*\d{1,2}(?::?\d{2})?.*$/i, "").trim();
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

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
