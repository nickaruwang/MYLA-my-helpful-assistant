import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDefaultTools } from "@myla/tools";
import {
  parseAgentPlannerResponse,
  parseToolPlannerResponse,
  selectRelevantToolCards,
  validateAgentNextStep,
  validatePlannedToolCall
} from "./toolPlanner.js";

registerDefaultTools();

describe("tool planner", () => {
  it("selects Gmail tools for draft requests", () => {
    const cards = selectRelevantToolCards(
      "draft me an email to samanthaychou@gmail.com asking about when and where we should do our dinner on friday"
    );

    expect(cards.map((card) => card.name)).toContain("google.gmail.create_draft");
  });

  it("selects Gmail metadata and Drive read tools for service requests", () => {
    const gmailCards = selectRelevantToolCards("search gmail for messages from Sam about dinner");
    const driveCards = selectRelevantToolCards("read the Drive document about the launch plan");

    expect(gmailCards.map((card) => card.name)).toContain("google.gmail.search_messages");
    expect(driveCards.map((card) => card.name)).toContain("google.drive.read_file");
  });

  it("uses recent conversation context to select calendar tools for clarification answers", () => {
    const cards = selectRelevantToolCards("tomorrow june 27 saturday from 12pm to 6pm in san mateo", [
      {
        actor: "user",
        content: "add an event to my calendar to visit baby Leo from 12pm to 6pm tmrw"
      },
      {
        actor: "assistant",
        content: "What date and start time should I use?"
      }
    ]);

    expect(cards.map((card) => card.name)).toContain("google.calendar.create_event");
  });

  it("selects Pushcut tools for configured car lock requests", () => {
    process.env.PUSHCUT_API_KEY = "test-token";
    process.env.PUSHCUT_SHORTCUTS_JSON = JSON.stringify([
      {
        name: "lock car",
        notification: "Lock Car",
        parameters: [],
        bodyMode: "none"
      }
    ]);
    registerDefaultTools();

    const cards = selectRelevantToolCards("lock the car");

    expect(cards.map((card) => card.name)).toContain("pushcut.lock_car");

    delete process.env.PUSHCUT_API_KEY;
    delete process.env.PUSHCUT_SHORTCUTS_JSON;
  });

  it("validates a dinner email draft plan", () => {
    const plan = parseToolPlannerResponse(
      JSON.stringify({
        intent: "create_email_draft",
        toolName: "google.gmail.create_draft",
        args: {
          to: "samanthaychou@gmail.com",
          subject: "Dinner on Friday",
          body: "Hi Samantha,\n\nI wanted to ask when and where we should do dinner on Friday. Let me know what works best for you.\n\nBest,\nNick"
        },
        confidence: 0.95,
        assumptions: [],
        missingFields: [],
        needsClarification: false
      })
    );

    expect(plan).toBeDefined();
    const result = validatePlannedToolCall(plan!);
    expect(result.kind).toBe("tool");
    if (result.kind === "tool") {
      expect(result.plan.args.to).toBe("samanthaychou@gmail.com");
      expect(result.plan.args.subject).toBe("Dinner on Friday");
      expect(String(result.plan.args.body)).toContain("when and where");
    }
  });

  it("validates a lunch calendar event plan with PM assumption", () => {
    const plan = parseToolPlannerResponse(
      JSON.stringify({
        intent: "create_calendar_event",
        toolName: "google.calendar.create_event",
        args: {
          calendarId: "primary",
          summary: "lunch date with sam",
          startIso: "2026-06-24T12:30:00-07:00",
          endIso: "2026-06-24T13:30:00-07:00",
          timeZone: "America/Los_Angeles"
        },
        confidence: 0.93,
        assumptions: ["Interpreted 1230 to 130 as 12:30 PM to 1:30 PM because this is lunch."],
        missingFields: [],
        needsClarification: false
      })
    );

    expect(plan).toBeDefined();
    const result = validatePlannedToolCall(plan!);
    expect(result.kind).toBe("tool");
    if (result.kind === "tool") {
      expect(result.plan.args.summary).toBe("lunch date with sam");
      expect(result.plan.args.startIso).toBe("2026-06-24T12:30:00-07:00");
      expect(result.plan.assumptions[0]).toContain("12:30 PM");
    }
  });

  it("asks for clarification when required draft fields are missing", () => {
    const result = validatePlannedToolCall({
      toolName: "google.gmail.create_draft",
      args: {
        subject: "Hello"
      },
      confidence: 0.5,
      assumptions: [],
      missingFields: [],
      needsClarification: false
    });

    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.message).toContain("Who should I address");
    }
  });

  it("parses and validates agent final and clarification next steps", () => {
    const finalStep = parseAgentPlannerResponse(JSON.stringify({ kind: "final", message: "Done." }));
    const clarificationStep = parseAgentPlannerResponse(
      JSON.stringify({ kind: "clarification", message: "Who should I text?", missingFields: ["recipient"] })
    );

    expect(finalStep).toBeDefined();
    expect(clarificationStep).toBeDefined();
    expect(validateAgentNextStep(finalStep!).kind).toBe("final");
    const validatedClarification = validateAgentNextStep(clarificationStep!);
    expect(validatedClarification.kind).toBe("clarification");
    if (validatedClarification.kind === "clarification") {
      expect(validatedClarification.missingFields).toContain("recipient");
    }
  });

  it("parses an agent tool next step through existing tool validation", () => {
    const step = parseAgentPlannerResponse(
      JSON.stringify({
        kind: "tool",
        toolName: "search.web",
        args: { query: "latest local llm news", count: 3 },
        confidence: 0.8,
        assumptions: [],
        missingFields: [],
        needsClarification: false
      })
    );

    expect(step).toBeDefined();
    const result = validateAgentNextStep(step!);
    expect(result.kind).toBe("tool");
    if (result.kind === "tool") {
      expect(result.plan.toolName).toBe("search.web");
      expect(result.plan.args.query).toBe("latest local llm news");
    }
  });

  it("rejects calendar plans that contradict server date facts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T17:00:00-07:00"));

    const result = validatePlannedToolCall(
      {
        toolName: "google.calendar.create_event",
        args: {
          calendarId: "primary",
          summary: "Visit baby Leo",
          startIso: "2026-06-28T12:00:00-07:00",
          endIso: "2026-06-28T18:00:00-07:00",
          timeZone: "America/Los_Angeles"
        },
        confidence: 0.9,
        assumptions: [],
        missingFields: [],
        needsClarification: false
      },
      {
        message: "tomorrow june 27 saturday from 12pm to 6pm in san mateo"
      }
    );

    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.message).toContain("planned tool call used");
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});
