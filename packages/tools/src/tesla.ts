import { z } from "zod";
import type { ToolDefinition } from "./index.js";
import type { ProviderStatus } from "@myla/shared";

const VehicleStatusArgsSchema = z.object({
  vehicleId: z.string().optional()
});

const VehicleCommandArgsSchema = z.object({
  vehicleId: z.string().optional(),
  command: z.enum(["wake_up", "auto_conditioning_start", "auto_conditioning_stop", "charge_start", "charge_stop"]),
  parameters: z.record(z.unknown()).default({})
});

export function createTeslaTools(): ToolDefinition[] {
  return [
    {
      name: "tesla.vehicle.status",
      provider: "tesla",
      operation: "read tesla vehicle status",
      description: "Read Tesla vehicle state through the Fleet API.",
      requiredScopes: ["TESLA_ACCESS_TOKEN", "TESLA_VEHICLE_ID"],
      riskLevel: "sensitive",
      approvalMode: "manual",
      argsSchema: VehicleStatusArgsSchema,
      getProviderStatus: getTeslaProviderStatus,
      dryRun: (args) => `Read Tesla vehicle status for ${args.vehicleId ?? "configured vehicle"}.`,
      execute: async (args) => teslaGet(`/api/1/vehicles/${vehicleId(args.vehicleId)}/vehicle_data`)
    },
    {
      name: "tesla.vehicle.command",
      provider: "tesla",
      operation: "tesla vehicle command",
      description: "Execute a small allowlist of Tesla commands. Disabled unless TESLA_COMMANDS_ENABLED=true.",
      requiredScopes: ["TESLA_ACCESS_TOKEN", "TESLA_VEHICLE_ID", "TESLA_COMMANDS_ENABLED"],
      riskLevel: "high",
      approvalMode: "manual",
      argsSchema: VehicleCommandArgsSchema,
      getProviderStatus: getTeslaProviderStatus,
      dryRun: (args) => `Would run Tesla command "${args.command}" on ${args.vehicleId ?? "configured vehicle"}.`,
      execute: async (args) => {
        if (process.env.TESLA_COMMANDS_ENABLED !== "true") {
          return {
            kind: "blocked",
            provider: "tesla",
            message: "Tesla commands are disabled. Set TESLA_COMMANDS_ENABLED=true after Fleet API setup."
          };
        }

        return teslaPost(
          `/api/1/vehicles/${vehicleId(args.vehicleId)}/command/${args.command}`,
          (args.parameters ?? {}) as Record<string, unknown>
        );
      }
    }
  ];
}

function getTeslaProviderStatus(): ProviderStatus {
  const missingConfig = [
    !process.env.TESLA_ACCESS_TOKEN ? "TESLA_ACCESS_TOKEN" : undefined,
    !process.env.TESLA_VEHICLE_ID ? "TESLA_VEHICLE_ID" : undefined
  ].filter((value): value is string => Boolean(value));
  const commandsDisabled = process.env.TESLA_COMMANDS_ENABLED !== "true";

  return {
    provider: "tesla",
    status: missingConfig.length > 0 ? "needs_setup" : commandsDisabled ? "disabled" : "ready",
    message:
      missingConfig.length > 0
        ? `Tesla Fleet API config is missing: ${missingConfig.join(", ")}.`
        : commandsDisabled
          ? "Tesla status reads are configured, but commands are disabled."
          : "Tesla Fleet API is configured and commands are enabled.",
    requiredScopes: ["TESLA_ACCESS_TOKEN", "TESLA_VEHICLE_ID", "TESLA_COMMANDS_ENABLED"],
    missingConfig: commandsDisabled ? [...missingConfig, "TESLA_COMMANDS_ENABLED"] : missingConfig,
    tools: []
  };
}

async function teslaGet(path: string): Promise<unknown> {
  const setup = teslaSetupProblem();
  if (setup) {
    return setup;
  }

  const response = await fetch(`${teslaBaseUrl()}${path}`, {
    headers: { authorization: `Bearer ${process.env.TESLA_ACCESS_TOKEN}` }
  });

  if (!response.ok) {
    throw new Error(`Tesla Fleet API returned ${response.status}`);
  }

  return response.json();
}

async function teslaPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const setup = teslaSetupProblem();
  if (setup) {
    return setup;
  }

  const response = await fetch(`${teslaBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.TESLA_ACCESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Tesla Fleet API returned ${response.status}`);
  }

  return response.json();
}

function vehicleId(value: unknown): string {
  const explicit = typeof value === "string" && value.trim() ? value : undefined;
  const configured = process.env.TESLA_VEHICLE_ID;
  if (!explicit && !configured) {
    throw new Error("TESLA_VEHICLE_ID is required.");
  }

  return explicit ?? configured ?? "";
}

function teslaSetupProblem() {
  if (!process.env.TESLA_ACCESS_TOKEN || !process.env.TESLA_VEHICLE_ID) {
    return {
      kind: "scaffold",
      provider: "tesla",
      message: "Configure TESLA_ACCESS_TOKEN and TESLA_VEHICLE_ID after completing Tesla Fleet API OAuth."
    };
  }

  return null;
}

function teslaBaseUrl(): string {
  return process.env.TESLA_API_BASE_URL ?? "https://fleet-api.prd.na.vn.cloud.tesla.com";
}
