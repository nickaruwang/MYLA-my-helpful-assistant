import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { google } from "googleapis";
import { z } from "zod";
import type { ToolDefinition } from "./index.js";
import type { ProviderStatus } from "@myla/shared";

export const GOOGLE_SAFE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose"
] as const;

export function hasGoogleOAuthConfig(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

export function getGoogleAuthUrl(): string {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GOOGLE_SAFE_SCOPES]
  });
}

export async function saveGoogleTokensFromCode(code: string): Promise<void> {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  const tokenPath = getTokenPath();
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
}

export function getGoogleProviderStatus(): ProviderStatus {
  const missingConfig = [
    !process.env.GOOGLE_CLIENT_ID ? "GOOGLE_CLIENT_ID" : undefined,
    !process.env.GOOGLE_CLIENT_SECRET ? "GOOGLE_CLIENT_SECRET" : undefined,
    !process.env.GOOGLE_REDIRECT_URI ? "GOOGLE_REDIRECT_URI" : undefined
  ].filter((value): value is string => Boolean(value));
  const tokenExists = existsSync(getTokenPath());

  return {
    provider: "google",
    status: missingConfig.length > 0 ? "needs_setup" : tokenExists ? "ready" : "needs_setup",
    message:
      missingConfig.length > 0
        ? `Google OAuth config is missing: ${missingConfig.join(", ")}.`
        : tokenExists
          ? "Google OAuth token is available."
          : "Google OAuth token is missing. Visit /oauth/google/start.",
    requiredScopes: [...GOOGLE_SAFE_SCOPES],
    missingConfig: tokenExists ? missingConfig : [...missingConfig, "GOOGLE_TOKEN_PATH"],
    tools: []
  };
}

export function createSafeGoogleTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "google.calendar.read_schedule",
      provider: "google",
      operation: "read calendar schedule",
      description: "Read calendar schedule metadata for a requested date range.",
      requiredScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      riskLevel: "read",
      approvalMode: "auto",
      argsSchema: z.object({
        query: z.string().optional(),
        calendarId: z.string().default("primary"),
        timeMin: z.string().datetime({ offset: true }).optional(),
        timeMax: z.string().datetime({ offset: true }).optional(),
        maxResults: z.number().min(1).max(50).default(10)
      }),
      examples: [
        {
          user: "check my calendar for tomorrow",
          args: {
            calendarId: "primary",
            timeMin: "tomorrow at 00:00 in the user's timezone",
            timeMax: "the day after tomorrow at 00:00 in the user's timezone",
            maxResults: 10
          }
        }
      ],
      dryRun: (args) => `Read calendar schedule with args ${JSON.stringify(args)}.`,
      execute: async (args) => {
        const auth = getAuthorizedClientOrNull();
        if (!auth) {
          return notConfigured("calendar.read_schedule");
        }

        const calendar = google.calendar({ version: "v3", auth });
        const timeMin = new Date(asString(args.timeMin) ?? Date.now());
        const timeMax = new Date(asString(args.timeMax) ?? Date.now() + 24 * 60 * 60 * 1000);
        const response = await calendar.events.list({
          calendarId: asString(args.calendarId) ?? "primary",
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          maxResults: asNumber(args.maxResults) ?? 10,
          singleEvents: true,
          orderBy: "startTime"
        });

        return {
          provider: "google",
          tool: "calendar.read_schedule",
          events:
            response.data.items?.map((event) => ({
              id: event.id,
              summary: event.summary,
              start: event.start,
              end: event.end
            })) ?? []
        };
      }
    },
    {
      name: "google.calendar.create_event",
      provider: "google",
      operation: "create calendar event",
      description: "Create a Google Calendar event after manual approval.",
      requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
      riskLevel: "high",
      approvalMode: "manual",
      argsSchema: z.object({
        calendarId: z.string().default("primary"),
        summary: z.string(),
        description: z.string().optional(),
        location: z.string().optional(),
        startIso: z.string().datetime({ offset: true }),
        endIso: z.string().datetime({ offset: true }),
        timeZone: z.string().default("America/Los_Angeles")
      }),
      examples: [
        {
          user: "block out a time tmrw from 1230 to 130 for a lunch date with sam",
          args: {
            calendarId: "primary",
            summary: "lunch date with sam",
            startIso: "tomorrow at 12:30 PM in ISO-8601 with timezone offset",
            endIso: "tomorrow at 1:30 PM in ISO-8601 with timezone offset",
            timeZone: "America/Los_Angeles"
          },
          assumptions: ["Interpreted lunch as PM."]
        }
      ],
      clarificationPrompts: {
        summary: "What should I call the calendar event?",
        startIso: "What date and start time should I use?",
        endIso: "What end time should I use?"
      },
      dryRun: (args) => `Create calendar event "${args.summary}" from ${args.startIso} to ${args.endIso}.`,
      validate: (args) => validateCalendarRange(args.startIso, args.endIso),
      execute: async (args) => {
        const auth = getAuthorizedClientOrNull();
        if (!auth) {
          return notConfigured("calendar.create_event");
        }

        const calendar = google.calendar({ version: "v3", auth });
        const response = await calendar.events.insert({
          calendarId: asString(args.calendarId) ?? "primary",
          requestBody: {
            summary: asString(args.summary),
            description: asString(args.description),
            location: asString(args.location),
            start: {
              dateTime: asString(args.startIso),
              timeZone: asString(args.timeZone) ?? "America/Los_Angeles"
            },
            end: {
              dateTime: asString(args.endIso),
              timeZone: asString(args.timeZone) ?? "America/Los_Angeles"
            }
          }
        });

        return {
          provider: "google",
          tool: "calendar.create_event",
          eventId: response.data.id,
          htmlLink: response.data.htmlLink
        };
      },
      verify: verifyCalendarEvent
    },
    {
      name: "google.calendar.update_event",
      provider: "google",
      operation: "update calendar event",
      description: "Update an existing Google Calendar event after manual approval.",
      requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
      riskLevel: "high",
      approvalMode: "manual",
      argsSchema: z.object({
        calendarId: z.string().default("primary"),
        eventId: z.string().min(1),
        summary: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        startIso: z.string().datetime({ offset: true }).optional(),
        endIso: z.string().datetime({ offset: true }).optional(),
        timeZone: z.string().default("America/Los_Angeles")
      }),
      clarificationPrompts: {
        eventId: "Which calendar event should I update?"
      },
      dryRun: (args) => `Update calendar event ${args.eventId} with ${JSON.stringify(args)}.`,
      validate: (args) => validateCalendarRange(args.startIso, args.endIso),
      execute: async (args) => {
        const auth = getAuthorizedClientOrNull();
        if (!auth) {
          return notConfigured("calendar.update_event");
        }

        const calendar = google.calendar({ version: "v3", auth });
        const requestBody: Record<string, unknown> = {
          summary: asString(args.summary),
          description: asString(args.description),
          location: asString(args.location)
        };
        if (asString(args.startIso)) {
          requestBody.start = {
            dateTime: asString(args.startIso),
            timeZone: asString(args.timeZone) ?? "America/Los_Angeles"
          };
        }
        if (asString(args.endIso)) {
          requestBody.end = {
            dateTime: asString(args.endIso),
            timeZone: asString(args.timeZone) ?? "America/Los_Angeles"
          };
        }

        const response = await calendar.events.patch({
          calendarId: asString(args.calendarId) ?? "primary",
          eventId: asString(args.eventId) ?? "",
          requestBody
        });

        return {
          provider: "google",
          tool: "calendar.update_event",
          eventId: response.data.id,
          htmlLink: response.data.htmlLink
        };
      },
      verify: verifyCalendarEvent
    },
    {
      name: "google.calendar.delete_event",
      provider: "google",
      operation: "delete calendar event",
      description: "Delete an existing Google Calendar event after manual approval.",
      requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
      riskLevel: "high",
      approvalMode: "manual",
      argsSchema: z.object({
        calendarId: z.string().default("primary"),
        eventId: z.string().min(1),
        summary: z.string().optional()
      }),
      clarificationPrompts: {
        eventId: "Which calendar event should I delete?"
      },
      dryRun: (args) => `Delete calendar event ${args.eventId}${args.summary ? ` (${args.summary})` : ""}.`,
      execute: async (args) => {
        const auth = getAuthorizedClientOrNull();
        if (!auth) {
          return notConfigured("calendar.delete_event");
        }

        const calendar = google.calendar({ version: "v3", auth });
        await calendar.events.delete({
          calendarId: asString(args.calendarId) ?? "primary",
          eventId: asString(args.eventId) ?? ""
        });

        return {
          provider: "google",
          tool: "calendar.delete_event",
          eventId: asString(args.eventId),
          verified: true
        };
      }
    },
    {
      name: "google.gmail.create_draft",
      provider: "google",
      operation: "create draft email",
      description: "Create a Gmail draft without sending it.",
      requiredScopes: ["https://www.googleapis.com/auth/gmail.compose"],
      riskLevel: "low",
      approvalMode: "notify",
      argsSchema: z.object({
        query: z.string().optional(),
        to: z.string().email(),
        subject: z.string().min(1),
        body: z.string().min(1)
      }),
      examples: [
        {
          user: "draft me an email to samanthaychou@gmail.com asking about when and where we should do our dinner on friday",
          args: {
            to: "samanthaychou@gmail.com",
            subject: "Dinner on Friday",
            body: "Hi Samantha,\n\nI wanted to ask when and where we should do dinner on Friday. Let me know what works best for you.\n\nBest,\nNick"
          }
        }
      ],
      clarificationPrompts: {
        to: "Who should I address the email to?",
        subject: "What subject should I use?",
        body: "What should the email say?"
      },
      dryRun: (args) =>
        `Create a Gmail draft to ${args.to} with subject "${args.subject}" and body preview "${ensureEmailSignature(
          String(args.body),
          getEmailSignatureName()
        ).slice(
          0,
          120
        )}".`,
      execute: async (args) => {
        const auth = getAuthorizedClientOrNull();
        if (!auth) {
          return notConfigured("gmail.create_draft");
        }

        const to = asString(args.to) ?? "recipient@example.com";
        const subject = asString(args.subject) ?? "Draft from MYLA";
        const body = ensureEmailSignature(
          asString(args.body) ?? asString(args.query) ?? "Draft body goes here.",
          getEmailSignatureName()
        );
        const raw = encodeEmail({ to, subject, body });
        const gmail = google.gmail({ version: "v1", auth });
        const response = await gmail.users.drafts.create({
          userId: "me",
          requestBody: {
            message: { raw }
          }
        });

        return {
          provider: "google",
          tool: "gmail.create_draft",
          to,
          subject,
          bodyPreview: body.slice(0, 500),
          draftId: response.data.id,
          messageId: response.data.message?.id
        };
      }
    },
    {
      name: "google.gmail.search_messages",
      provider: "google",
      operation: "search gmail metadata",
      description: "Search Gmail message metadata and return sender, subject, and date without body content.",
      requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      riskLevel: "sensitive",
      approvalMode: "manual",
      argsSchema: z.object({
        query: z.string().min(1),
        maxResults: z.number().min(1).max(20).default(10)
      }),
      dryRun: (args) => `Search Gmail metadata for "${args.query}".`,
      execute: async (args) => {
        const auth = getAuthorizedClientOrNull();
        if (!auth) {
          return notConfigured("gmail.search_messages");
        }

        const gmail = google.gmail({ version: "v1", auth });
        const response = await gmail.users.messages.list({
          userId: "me",
          q: asString(args.query),
          maxResults: asNumber(args.maxResults) ?? 10
        });
        const messages = await Promise.all(
          (response.data.messages ?? []).map(async (message) => {
            const detail = await gmail.users.messages.get({
              userId: "me",
              id: message.id ?? "",
              format: "metadata",
              metadataHeaders: ["From", "Subject", "Date"]
            });
            const headers = Object.fromEntries(
              (detail.data.payload?.headers ?? []).map((header) => [header.name?.toLowerCase() ?? "", header.value])
            );
            return {
              id: detail.data.id,
              threadId: detail.data.threadId,
              from: headers.from,
              subject: headers.subject,
              date: headers.date,
              snippet: detail.data.snippet
            };
          })
        );

        return {
          provider: "google",
          tool: "gmail.search_messages",
          messages
        };
      }
    },
    {
      name: "google.gmail.send_draft",
      provider: "google",
      operation: "send gmail draft",
      description: "Send an existing Gmail draft after human review and approval.",
      requiredScopes: ["https://www.googleapis.com/auth/gmail.compose"],
      riskLevel: "high",
      approvalMode: "manual",
      argsSchema: z.object({
        draftId: z.string().min(1),
        to: z.string().email().optional(),
        subject: z.string().optional(),
        bodyPreview: z.string().optional()
      }),
      examples: [
        {
          user: "send the reviewed draft",
          args: {
            draftId: "r123456789",
            to: "samanthaychou@gmail.com",
            subject: "Dinner on Friday",
            bodyPreview:
              "Hi Samantha,\n\nI wanted to ask when and where we should do dinner on Friday. Let me know what works best for you.\n\nBest,\nNick"
          }
        }
      ],
      clarificationPrompts: {
        draftId: "Which Gmail draft should I send?"
      },
      dryRun: (args) =>
        `Send Gmail draft ${args.draftId}${args.to ? ` to ${args.to}` : ""}${
          args.subject ? ` with subject "${args.subject}"` : ""
        }${args.bodyPreview ? ` Body preview: "${String(args.bodyPreview).slice(0, 120)}".` : "."}`,
      execute: async (args) => {
        const auth = getAuthorizedClientOrNull();
        if (!auth) {
          return notConfigured("gmail.send_draft");
        }

        const draftId = asString(args.draftId);
        if (!draftId) {
          throw new Error("draftId is required to send a Gmail draft.");
        }

        const gmail = google.gmail({ version: "v1", auth });
        const response = await gmail.users.drafts.send({
          userId: "me",
          requestBody: {
            id: draftId
          }
        });

        return {
          provider: "google",
          tool: "gmail.send_draft",
          draftId,
          to: asString(args.to),
          subject: asString(args.subject),
          bodyPreview: asString(args.bodyPreview),
          messageId: response.data.id
        };
      }
    },
    {
      name: "google.drive.list_files",
      provider: "google",
      operation: "list drive file metadata",
      description: "Search Google Drive file metadata without reading file contents.",
      requiredScopes: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
      riskLevel: "read",
      approvalMode: "auto",
      argsSchema: z.object({
        query: z.string().optional(),
        pageSize: z.number().min(1).max(100).default(10),
        mimeType: z.string().optional()
      }),
      dryRun: (args) => `List Drive file metadata with args ${JSON.stringify(args)}.`,
      execute: async (args) => {
        const auth = getAuthorizedClientOrNull();
        if (!auth) {
          return notConfigured("drive.list_files");
        }

        const drive = google.drive({ version: "v3", auth });
        const query = buildDriveQuery(args);
        const response = await drive.files.list({
          pageSize: asNumber(args.pageSize) ?? 10,
          q: query,
          fields: "files(id,name,mimeType,modifiedTime,webViewLink)"
        });

        return {
          provider: "google",
          tool: "drive.list_files",
          files: response.data.files ?? []
        };
      }
    },
    {
      name: "google.drive.read_file",
      provider: "google",
      operation: "read drive file text",
      description: "Read text content from a specific Google Drive file after manual approval.",
      requiredScopes: ["https://www.googleapis.com/auth/drive.readonly"],
      riskLevel: "sensitive",
      approvalMode: "manual",
      argsSchema: z.object({
        fileId: z.string().min(1),
        mimeType: z.string().optional(),
        name: z.string().optional()
      }),
      clarificationPrompts: {
        fileId: "Which Drive file should I read?"
      },
      dryRun: (args) => `Read text content from Drive file ${args.name ?? args.fileId}.`,
      execute: async (args) => {
        const auth = getAuthorizedClientOrNull();
        if (!auth) {
          return notConfigured("drive.read_file");
        }

        const drive = google.drive({ version: "v3", auth });
        const metadata = await drive.files.get({
          fileId: asString(args.fileId) ?? "",
          fields: "id,name,mimeType,webViewLink,modifiedTime"
        });
        const mimeType = metadata.data.mimeType ?? asString(args.mimeType);
        const text =
          mimeType === "application/vnd.google-apps.document"
            ? await exportDriveText(drive, asString(args.fileId) ?? "")
            : await downloadDriveText(drive, asString(args.fileId) ?? "");

        return {
          provider: "google",
          tool: "drive.read_file",
          file: metadata.data,
          textPreview: text.slice(0, 4000),
          truncated: text.length > 4000
        };
      }
    }
  ];

  return tools.map((tool) => ({ ...tool, getProviderStatus: getGoogleProviderStatus }));
}

function getOAuthClient() {
  if (!hasGoogleOAuthConfig()) {
    throw new Error("Google OAuth config is missing.");
  }

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthorizedClientOrNull() {
  if (!hasGoogleOAuthConfig()) {
    return null;
  }

  try {
    const tokenPath = getTokenPath();
    const tokens = JSON.parse(readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(tokens);
    return oauth2Client;
  } catch {
    return null;
  }
}

function getTokenPath(): string {
  return process.env.GOOGLE_TOKEN_PATH ?? "./data/google-token.json";
}

function notConfigured(tool: string) {
  return {
    kind: "scaffold",
    provider: "google",
    tool,
    message: "Google OAuth is not configured yet. Visit /oauth/google/start after setting credentials."
  };
}

function validateCalendarRange(startIso: unknown, endIso: unknown): string[] {
  if (!startIso || !endIso) {
    return [];
  }

  const start = new Date(String(startIso));
  const end = new Date(String(endIso));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return ["Calendar start and end times must be valid datetimes."];
  }

  if (end <= start) {
    return ["Calendar end time must be after the start time."];
  }

  return [];
}

async function verifyCalendarEvent(args: Record<string, unknown>, data: unknown): Promise<unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }

  const auth = getAuthorizedClientOrNull();
  const eventId = asString((data as Record<string, unknown>).eventId);
  if (!auth || !eventId) {
    return data;
  }

  const calendar = google.calendar({ version: "v3", auth });
  const verified = await calendar.events.get({
    calendarId: asString(args.calendarId) ?? "primary",
    eventId
  });

  return {
    ...(data as Record<string, unknown>),
    verified: true,
    event: {
      id: verified.data.id,
      summary: verified.data.summary,
      htmlLink: verified.data.htmlLink,
      start: verified.data.start,
      end: verified.data.end,
      location: verified.data.location
    }
  };
}

async function exportDriveText(drive: ReturnType<typeof google.drive>, fileId: string): Promise<string> {
  const response = await drive.files.export(
    {
      fileId,
      mimeType: "text/plain"
    },
    { responseType: "text" }
  );
  return typeof response.data === "string" ? response.data : String(response.data ?? "");
}

async function downloadDriveText(drive: ReturnType<typeof google.drive>, fileId: string): Promise<string> {
  const response = await drive.files.get(
    {
      fileId,
      alt: "media"
    },
    { responseType: "text" }
  );
  return typeof response.data === "string" ? response.data : String(response.data ?? "");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getEmailSignatureName(): string {
  return process.env.USER_DISPLAY_NAME ?? process.env.ASSISTANT_USER_NAME ?? "Nick";
}

export function ensureEmailSignature(body: string, name: string): string {
  const trimmed = body.trimEnd();
  if (new RegExp(`\\b${escapeRegExp(name)}\\s*$`, "i").test(trimmed)) {
    return trimmed;
  }

  const danglingSignoff = trimmed.match(/([\s\S]*?)(\n\s*(?:best|thanks|thank you|regards|sincerely),?\s*)$/i);
  if (danglingSignoff?.[1] !== undefined && danglingSignoff[2]) {
    return `${danglingSignoff[1]}${danglingSignoff[2].trimEnd()}\n${name}`;
  }

  return `${trimmed}\n\nBest,\n${name}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDriveQuery(args: Record<string, unknown>): string {
  const clauses = ["trashed = false"];
  const query = asString(args.query);
  const mimeType = asString(args.mimeType);

  if (query) {
    clauses.push(`name contains '${escapeDriveQuery(query)}'`);
  }

  if (mimeType) {
    clauses.push(`mimeType = '${escapeDriveQuery(mimeType)}'`);
  }

  return clauses.join(" and ");
}

function escapeDriveQuery(value: string): string {
  return value.replace(/['\\]/g, "\\$&");
}

function encodeEmail(input: { to: string; subject: string; body: string }): string {
  const message = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body
  ].join("\r\n");

  return Buffer.from(message).toString("base64url");
}
