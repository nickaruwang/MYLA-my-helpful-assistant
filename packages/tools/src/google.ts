import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { google } from "googleapis";
import { z } from "zod";
import type { ToolDefinition } from "./index.js";

export const GOOGLE_SAFE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
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

export function createSafeGoogleTools(): ToolDefinition[] {
  return [
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
        timeMin: z.string().optional(),
        timeMax: z.string().optional(),
        maxResults: z.number().min(1).max(50).default(10)
      }),
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
        startIso: z.string(),
        endIso: z.string(),
        timeZone: z.string().default("America/Los_Angeles")
      }),
      dryRun: (args) => `Create calendar event "${args.summary}" from ${args.startIso} to ${args.endIso}.`,
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
        to: z.string().email().optional(),
        subject: z.string().optional(),
        body: z.string().optional()
      }),
      dryRun: (args) => `Create a Gmail draft with args ${JSON.stringify(args)}.`,
      execute: async (args) => {
        const auth = getAuthorizedClientOrNull();
        if (!auth) {
          return notConfigured("gmail.create_draft");
        }

        const to = asString(args.to) ?? "recipient@example.com";
        const subject = asString(args.subject) ?? "Draft from JARVIS";
        const body = asString(args.body) ?? asString(args.query) ?? "Draft body goes here.";
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
          draftId: response.data.id,
          messageId: response.data.message?.id
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
    }
  ];
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
