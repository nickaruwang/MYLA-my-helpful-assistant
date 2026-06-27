import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDefaultTools } from "@jarvis/tools";
import { parseToolPlannerResponse, selectRelevantToolCards, validatePlannedToolCall } from "./toolPlanner.js";

registerDefaultTools();

describe("tool planner", () => {
  it("selects Gmail tools for draft requests", () => {
    const cards = selectRelevantToolCards(
      "draft me an email to samanthaychou@gmail.com asking about when and where we should do our dinner on friday"
    );

    expect(cards.map((card) => card.name)).toContain("google.gmail.create_draft");
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
