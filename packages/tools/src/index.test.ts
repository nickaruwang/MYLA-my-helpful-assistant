import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { listProviderStatuses, listPublicTools, proposeAndMaybeExecuteTool, registerDefaultTools } from "./index.js";
import { ensureEmailSignature } from "./google.js";

describe("tool gateway", () => {
  it("exposes schema-backed provider metadata", () => {
    registerDefaultTools();

    const tools = listPublicTools();
    expect(tools.some((tool) => tool.name === "google.calendar.read_schedule")).toBe(true);
    expect(tools.some((tool) => tool.name === "search.web")).toBe(true);
    expect(tools.find((tool) => tool.name === "tesla.vehicle.command")?.approvalMode).toBe("manual");
  });

  it("blocks read-only search scaffold when no provider is configured", async () => {
    registerDefaultTools();

    const decision = await proposeAndMaybeExecuteTool({
      sessionId: "session",
      correlationId: "correlation",
      toolName: "search.web",
      args: { query: "local llm news", count: 3 }
    });

    expect(decision.proposal.provider).toBe("search");
    expect(decision.proposal.status).toBe("proposed");
    expect(decision.result.status).toBe("blocked");
  });

  it("reports provider readiness", () => {
    registerDefaultTools();

    const providers = listProviderStatuses();
    expect(providers.map((provider) => provider.provider)).toContain("google");
    expect(providers.map((provider) => provider.provider)).toContain("search");
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

  it("queues Gmail draft sending for manual approval", async () => {
    registerDefaultTools();

    const decision = await proposeAndMaybeExecuteTool({
      sessionId: "session",
      correlationId: "correlation",
      toolName: "google.gmail.send_draft",
      args: {
        draftId: "r123",
        to: "person@example.com",
        subject: "Review this"
      }
    });

    expect(decision.proposal.riskLevel).toBe("high");
    expect(decision.proposal.approvalMode).toBe("manual");
    expect(decision.approval?.status).toBe("pending");
    expect(decision.result.status).toBe("queued_for_approval");
  });

  it("registers configured Pushcut shortcuts as manual approval tools", async () => {
    process.env.PUSHCUT_SECRET = "test-secret";
    process.env.PUSHCUT_SHORTCUTS_JSON = JSON.stringify([
      {
        name: "send imessage",
        notification: "send msg test",
        description: "Send an iMessage through an iPhone Shortcut.",
        parameters: [
          { name: "recipient", required: true },
          { name: "message", required: true }
        ]
      }
    ]);
    try {
      registerDefaultTools();

      const tools = listPublicTools();
      const pushcutTool = tools.find((tool) => tool.name === "pushcut.send_imessage");
      expect(pushcutTool?.approvalMode).toBe("manual");
      expect(pushcutTool?.riskLevel).toBe("high");

      const providers = listProviderStatuses();
      expect(providers.find((provider) => provider.provider === "pushcut")?.status).toBe("ready");

      const decision = await proposeAndMaybeExecuteTool({
        sessionId: "session",
        correlationId: "correlation",
        toolName: "pushcut.send_imessage",
        args: { recipient: "Sam", message: "I am on my way" }
      });
      expect(decision.proposal.provider).toBe("pushcut");
      expect(decision.proposal.status).toBe("queued_for_approval");
      expect(decision.result.status).toBe("queued_for_approval");
      expect(decision.approval?.explanation).toContain("send imessage");
    } finally {
      delete process.env.PUSHCUT_SECRET;
      delete process.env.PUSHCUT_SHORTCUTS_JSON;
    }
  });

  it("registers Pushcut shortcuts from a readable JSON file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "myla-pushcut-"));
    const configPath = join(tempDir, "pushcut-shortcuts.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        [
          {
            name: "lock car",
            notification: "Lock Car",
            parameters: [],
            bodyMode: "none"
          }
        ],
        null,
        2
      )
    );
    process.env.PUSHCUT_SECRET = "test-secret";
    process.env.PUSHCUT_SHORTCUTS_FILE = configPath;
    try {
      registerDefaultTools();

      const tools = listPublicTools();
      const lockTool = tools.find((tool) => tool.name === "pushcut.lock_car");
      expect(lockTool?.approvalMode).toBe("manual");
      expect(lockTool?.argsSchema).toEqual({
        input: "string?",
        payload: "unknown?"
      });
    } finally {
      delete process.env.PUSHCUT_SECRET;
      delete process.env.PUSHCUT_SHORTCUTS_FILE;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fills missing Gmail draft signature names", () => {
    expect(ensureEmailSignature("Hi there,\n\nProject is moving.\n\nBest, ", "Nick")).toBe(
      "Hi there,\n\nProject is moving.\n\nBest,\nNick"
    );
    expect(ensureEmailSignature("Hi there,\n\nProject is moving.\n\nBest,\nNick", "Nick")).toBe(
      "Hi there,\n\nProject is moving.\n\nBest,\nNick"
    );
  });
});
