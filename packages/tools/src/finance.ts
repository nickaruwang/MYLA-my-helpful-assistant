import { z } from "zod";
import type { ToolDefinition } from "./index.js";

const PlaidWindowArgsSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  count: z.number().min(1).max(100).default(25)
});

const EmptyArgsSchema = z.object({});

export function createFinanceTools(): ToolDefinition[] {
  return [
    {
      name: "finance.plaid.balances",
      provider: "plaid",
      operation: "read account balances",
      description: "Read linked bank and credit account balances through Plaid.",
      requiredScopes: ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ACCESS_TOKEN"],
      riskLevel: "sensitive",
      approvalMode: "manual",
      argsSchema: EmptyArgsSchema,
      dryRun: () => "Read Plaid account balances.",
      execute: async () => plaidPost("/accounts/balance/get", {})
    },
    {
      name: "finance.plaid.transactions",
      provider: "plaid",
      operation: "read transaction history",
      description: "Read recent Plaid transactions for spending summaries.",
      requiredScopes: ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ACCESS_TOKEN"],
      riskLevel: "sensitive",
      approvalMode: "manual",
      argsSchema: PlaidWindowArgsSchema,
      dryRun: (args) => `Read Plaid transactions from ${args.startDate ?? "30 days ago"} to ${args.endDate ?? "today"}.`,
      execute: async (args) => {
        const endDate = asDate(args.endDate) ?? new Date();
        const startDate = asDate(args.startDate) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        return plaidPost("/transactions/get", {
          start_date: formatDate(startDate),
          end_date: formatDate(endDate),
          options: { count: args.count ?? 25, offset: 0 }
        });
      }
    },
    {
      name: "finance.plaid.investments",
      provider: "plaid",
      operation: "read investment holdings",
      description: "Read investment holdings through Plaid Investments when available.",
      requiredScopes: ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ACCESS_TOKEN"],
      riskLevel: "sensitive",
      approvalMode: "manual",
      argsSchema: EmptyArgsSchema,
      dryRun: () => "Read Plaid investment holdings.",
      execute: async () => plaidPost("/investments/holdings/get", {})
    }
  ];
}

async function plaidPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const setup = plaidSetupProblem();
  if (setup) {
    return setup;
  }

  const response = await fetch(`${plaidBaseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      access_token: process.env.PLAID_ACCESS_TOKEN,
      ...body
    })
  });

  if (!response.ok) {
    throw new Error(`Plaid returned ${response.status}`);
  }

  return response.json();
}

function plaidSetupProblem() {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET || !process.env.PLAID_ACCESS_TOKEN) {
    return {
      kind: "scaffold",
      provider: "plaid",
      message: "Configure PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ACCESS_TOKEN after Plaid Link setup."
    };
  }

  return null;
}

function plaidBaseUrl(): string {
  const env = process.env.PLAID_ENV ?? "sandbox";
  if (env === "production") {
    return "https://production.plaid.com";
  }
  if (env === "development") {
    return "https://development.plaid.com";
  }
  return "https://sandbox.plaid.com";
}

function asDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
