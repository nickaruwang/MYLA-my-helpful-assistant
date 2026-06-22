import { describe, expect, it } from "vitest";
import { listPublicTools, proposeAndMaybeExecuteTool, registerDefaultTools } from "./index.js";

describe("tool gateway", () => {
  it("exposes schema-backed provider metadata", () => {
    registerDefaultTools();

    const tools = listPublicTools();
    expect(tools.some((tool) => tool.name === "google.calendar.read_schedule")).toBe(true);
    expect(tools.some((tool) => tool.name === "search.web")).toBe(true);
    expect(tools.find((tool) => tool.name === "tesla.vehicle.command")?.approvalMode).toBe("manual");
  });

  it("executes read-only search scaffold automatically when no provider is configured", async () => {
    registerDefaultTools();

    const decision = await proposeAndMaybeExecuteTool({
      sessionId: "session",
      correlationId: "correlation",
      toolName: "search.web",
      args: { query: "local llm news", count: 3 }
    });

    expect(decision.proposal.provider).toBe("search");
    expect(decision.proposal.status).toBe("proposed");
    expect(decision.result.status).toBe("executed");
  });

  it("queues sensitive Tesla reads for manual approval", async () => {
    registerDefaultTools();

    const decision = await proposeAndMaybeExecuteTool({
      sessionId: "session",
      correlationId: "correlation",
      toolName: "tesla.vehicle.status",
      args: {}
    });

    expect(decision.proposal.riskLevel).toBe("sensitive");
    expect(decision.proposal.status).toBe("queued_for_approval");
    expect(decision.approval?.status).toBe("pending");
    expect(decision.result.status).toBe("queued_for_approval");
  });

  it("queues Plaid finance reads for manual approval", async () => {
    registerDefaultTools();

    const decision = await proposeAndMaybeExecuteTool({
      sessionId: "session",
      correlationId: "correlation",
      toolName: "finance.plaid.transactions",
      args: { count: 10 }
    });

    expect(decision.proposal.provider).toBe("plaid");
    expect(decision.proposal.riskLevel).toBe("sensitive");
    expect(decision.proposal.status).toBe("queued_for_approval");
    expect(decision.result.status).toBe("queued_for_approval");
  });
});
