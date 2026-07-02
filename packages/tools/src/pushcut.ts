import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ProviderStatus } from "@myla/shared";
import { z } from "zod";
import type { ToolDefinition } from "./index.js";

const PushcutParameterSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().default(true)
});

const PushcutShortcutConfigSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  notification: z.string().min(1).optional(),
  url: z.string().url().optional(),
  description: z.string().optional(),
  parameters: z.array(PushcutParameterSchema).optional(),
  requiredPayloadFields: z.array(z.string().min(1)).optional(),
  examples: z
    .array(
      z.object({
        user: z.string().min(1),
        args: z.record(z.unknown()),
        assumptions: z.array(z.string()).optional()
      })
    )
    .optional(),
  bodyMode: z.enum(["json", "none"]).default("json")
});

type PushcutShortcutConfig = z.infer<typeof PushcutShortcutConfigSchema>;
type PushcutParameter = z.infer<typeof PushcutParameterSchema>;

export function createPushcutTools(): ToolDefinition[] {
  return getPushcutShortcuts().map((shortcut) => {
    const toolName = `pushcut.${toolNameSuffix(shortcut.name)}`;

    return {
      name: toolName,
      provider: "pushcut",
      operation: `trigger ${displayName(shortcut)} shortcut`,
      description: [
        shortcut.description ?? `Trigger the Pushcut shortcut "${displayName(shortcut)}" on the user's iPhone.`,
        parameterDescription(shortcut),
        "Use this for iOS Shortcuts and Pushcut-backed actions such as iMessage or phone automations."
      ]
        .filter(Boolean)
        .join(" "),
      requiredScopes: requiredScopes(shortcut),
      riskLevel: "high",
      approvalMode: "manual",
      argsSchema: argsSchemaForShortcut(shortcut),
      examples: shortcut.examples ?? defaultExamples(shortcut),
      clarificationPrompts: clarificationPrompts(shortcut),
      getProviderStatus: getPushcutProviderStatus,
      dryRun: (args) => `Trigger Pushcut shortcut "${displayName(shortcut)}" with ${summarizeArgs(args)}.`,
      execute: async (args) => triggerPushcutShortcut(shortcut, args)
    };
  });
}

function getPushcutProviderStatus(): ProviderStatus {
  const parseResult = parsePushcutShortcuts();
  if (!parseResult.ok) {
    return {
      provider: "pushcut",
      status: "needs_setup",
      message: parseResult.message,
      requiredScopes: ["PUSHCUT_SHORTCUTS_JSON or PUSHCUT_SHORTCUTS_FILE", "PUSHCUT_SECRET"],
      missingConfig: ["PUSHCUT_SHORTCUTS_JSON or PUSHCUT_SHORTCUTS_FILE"],
      tools: []
    };
  }

  const shortcuts = parseResult.shortcuts;
  const missingSecret = shortcuts.some((shortcut) => !shortcut.url && !pushcutSecret());
  const missingEndpoint = shortcuts.some((shortcut) => !shortcut.url && !shortcut.notification);
  const missingConfig = [
    shortcuts.length === 0 ? "PUSHCUT_SHORTCUTS_JSON or PUSHCUT_SHORTCUTS_FILE" : undefined,
    missingSecret ? "PUSHCUT_SECRET" : undefined,
    missingEndpoint ? "notification or url" : undefined
  ].filter((value): value is string => Boolean(value));

  return {
    provider: "pushcut",
    status: missingConfig.length > 0 ? "needs_setup" : "ready",
    message:
      missingConfig.length > 0
        ? `Pushcut shortcut config is missing: ${missingConfig.join(", ")}.`
        : `Pushcut is configured with ${shortcuts.length} shortcut tool${shortcuts.length === 1 ? "" : "s"}.`,
    requiredScopes: ["PUSHCUT_SHORTCUTS_JSON or PUSHCUT_SHORTCUTS_FILE", "PUSHCUT_SECRET"],
    missingConfig,
    tools: []
  };
}

function getPushcutShortcuts(): PushcutShortcutConfig[] {
  const parsed = parsePushcutShortcuts();
  return parsed.ok ? parsed.shortcuts : [];
}

function parsePushcutShortcuts():
  | { ok: true; shortcuts: PushcutShortcutConfig[] }
  | { ok: false; message: string } {
  const config = readPushcutShortcutsConfig();
  if (!config.ok) {
    return config;
  }

  const raw = config.raw;
  if (!raw?.trim()) {
    return { ok: true, shortcuts: [] };
  }

  try {
    const decoded = JSON.parse(raw) as unknown;
    const parsed = z.array(PushcutShortcutConfigSchema).safeParse(decoded);
    if (!parsed.success) {
      return { ok: false, message: "PUSHCUT_SHORTCUTS_JSON must be an array of Pushcut shortcut configs." };
    }

    return {
      ok: true,
      shortcuts: parsed.data.filter((shortcut) => toolNameSuffix(shortcut.name))
    };
  } catch {
    return { ok: false, message: `${config.source} is not valid JSON.` };
  }
}

function readPushcutShortcutsConfig():
  | { ok: true; raw: string | undefined; source: string }
  | { ok: false; message: string } {
  const inline = process.env.PUSHCUT_SHORTCUTS_JSON;
  if (inline?.trim()) {
    return { ok: true, raw: inline, source: "PUSHCUT_SHORTCUTS_JSON" };
  }

  const filePath = process.env.PUSHCUT_SHORTCUTS_FILE;
  if (!filePath?.trim()) {
    return { ok: true, raw: undefined, source: "PUSHCUT_SHORTCUTS_JSON" };
  }

  const resolved = resolveConfigPath(filePath);
  if (!resolved) {
    return {
      ok: false,
      message: `PUSHCUT_SHORTCUTS_FILE does not exist: ${filePath}`
    };
  }

  return {
    ok: true,
    raw: readFileSync(resolved, "utf8"),
    source: "PUSHCUT_SHORTCUTS_FILE"
  };
}

function resolveConfigPath(filePath: string): string | undefined {
  if (isAbsolute(filePath)) {
    return existsSync(filePath) ? filePath : undefined;
  }

  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, filePath);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }

  return undefined;
}

function argsSchemaForShortcut(shortcut: PushcutShortcutConfig): z.ZodType<Record<string, unknown>> {
  const parameters = parametersForShortcut(shortcut);
  const shape: z.ZodRawShape = {
    input: z.string().min(1).optional(),
    payload: z.record(z.unknown()).default({})
  };

  for (const parameter of parameters) {
    if (!isSchemaFieldName(parameter.name) || parameter.name === "input" || parameter.name === "payload") {
      continue;
    }

    const field = z.string().min(1);
    shape[parameter.name] = parameter.required ? field : field.optional();
  }

  return z.object(shape).catchall(z.unknown()) as z.ZodType<Record<string, unknown>>;
}

function parametersForShortcut(shortcut: PushcutShortcutConfig): PushcutParameter[] {
  if (shortcut.parameters?.length) {
    return shortcut.parameters;
  }

  return (
    shortcut.requiredPayloadFields?.map((field) => ({
      name: field,
      required: true
    })) ?? []
  );
}

function clarificationPrompts(shortcut: PushcutShortcutConfig): Record<string, string> {
  return Object.fromEntries(
    parametersForShortcut(shortcut)
      .filter((parameter) => parameter.required)
      .map((parameter) => [parameter.name, promptForParameter(shortcut, parameter)])
  );
}

function promptForParameter(shortcut: PushcutShortcutConfig, parameter: PushcutParameter): string {
  const field = humanizeFieldName(parameter.name);
  if (/^(recipient|to|contact|phoneNumber)$/i.test(parameter.name)) {
    return `Who should I use as the ${field} for ${displayName(shortcut)}?`;
  }
  if (/^(message|text|body)$/i.test(parameter.name)) {
    return `What ${field} should I send with ${displayName(shortcut)}?`;
  }

  return `What ${field} should I use for ${displayName(shortcut)}?`;
}

async function triggerPushcutShortcut(shortcut: PushcutShortcutConfig, args: Record<string, unknown>): Promise<unknown> {
  const setup = pushcutSetupProblem(shortcut);
  if (setup) {
    return setup;
  }

  const endpoint = endpointForShortcut(shortcut);
  const body = requestBody(args);
  const headers: Record<string, string> = {};
  const init: RequestInit = { method: "POST", headers };
  if (shortcut.bodyMode !== "none" && Object.keys(body).length > 0) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(endpoint, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Pushcut returned ${response.status}${text ? `: ${truncate(text, 240)}` : ""}`);
  }

  return {
    provider: "pushcut",
    shortcut: shortcut.name,
    notification: shortcut.notification,
    status: response.status,
    message: `Triggered Pushcut shortcut "${displayName(shortcut)}".`,
    response: parseResponseBody(text)
  };
}

function pushcutSetupProblem(shortcut: PushcutShortcutConfig) {
  if (shortcut.url) {
    if (!isAllowedPushcutUrl(shortcut.url)) {
      return {
        kind: "blocked",
        provider: "pushcut",
        message: "Pushcut shortcut URLs must use https://api.pushcut.io."
      };
    }

    return null;
  }

  if (!pushcutSecret() || !shortcut.notification) {
    return {
      kind: "scaffold",
      provider: "pushcut",
      message: "Configure PUSHCUT_SECRET and PUSHCUT_SHORTCUTS_FILE before triggering Pushcut shortcuts."
    };
  }

  return null;
}

function endpointForShortcut(shortcut: PushcutShortcutConfig): string {
  if (shortcut.url) {
    return shortcut.url;
  }

  return `https://api.pushcut.io/${encodeURIComponent(pushcutSecret() ?? "")}/notifications/${encodeURIComponent(shortcut.notification ?? "")}`;
}

function pushcutSecret(): string | undefined {
  return process.env.PUSHCUT_SECRET?.trim() || process.env.PUSHCUT_API_KEY?.trim() || undefined;
}

function isAllowedPushcutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.pushcut.io";
  } catch {
    return false;
  }
}

function requestBody(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function parseResponseBody(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function requiredScopes(shortcut: PushcutShortcutConfig): string[] {
  return shortcut.url
    ? ["PUSHCUT_SHORTCUTS_JSON or PUSHCUT_SHORTCUTS_FILE"]
    : ["PUSHCUT_SECRET", "PUSHCUT_SHORTCUTS_JSON or PUSHCUT_SHORTCUTS_FILE"];
}

function parameterDescription(shortcut: PushcutShortcutConfig): string | undefined {
  const parameters = parametersForShortcut(shortcut);
  if (parameters.length === 0) {
    return "Pass optional input text or a payload object if the Shortcut expects data.";
  }

  return `Expected fields: ${parameters
    .map((parameter) => `${parameter.name}${parameter.required ? "" : " (optional)"}${parameter.description ? ` - ${parameter.description}` : ""}`)
    .join("; ")}.`;
}

function defaultExamples(shortcut: PushcutShortcutConfig): NonNullable<ToolDefinition["examples"]> {
  const fields = new Set(parametersForShortcut(shortcut).map((parameter) => parameter.name.toLowerCase()));
  if (fields.has("recipient") && fields.has("message")) {
    return [
      {
        user: "text Sam that I am on my way",
        args: { recipient: "Sam", message: "I am on my way" }
      }
    ];
  }

  return [
    {
      user: `run ${displayName(shortcut)}`,
      args: { input: `Run ${displayName(shortcut)}` }
    }
  ];
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(requestBody(args));
  if (entries.length === 0) {
    return "no input";
  }

  return JSON.stringify(Object.fromEntries(entries.slice(0, 12)));
}

function displayName(shortcut: PushcutShortcutConfig): string {
  return shortcut.title ?? shortcut.name;
}

function toolNameSuffix(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isSchemaFieldName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
}

function humanizeFieldName(value: string): string {
  return value
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
