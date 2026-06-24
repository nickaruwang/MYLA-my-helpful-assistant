import { describe, expect, it } from "vitest";
import { registerDefaultTools } from "@jarvis/tools";
import { inferToolIntent } from "./toolIntent.js";

registerDefaultTools();

describe("deterministic tool fallback", () => {
  it("parses lunch shorthand into calendar event args", () => {
    const intent = inferToolIntent("block out a time tmrw from 1230 to 130 for a lunch date with sam");

    expect(intent?.toolName).toBe("google.calendar.create_event");
    expect(intent?.args.summary).toBe("lunch date with sam");
    expect(String(intent?.args.startIso)).toContain("T12:30:00");
    expect(String(intent?.args.endIso)).toContain("T13:30:00");
  });

  it("extracts quoted calendar event names", () => {
    const intent = inferToolIntent("add an event onto my calendar for tmrw from 12:30 to 1:30 for 'lunchtime with sam'");

    expect(intent?.toolName).toBe("google.calendar.create_event");
    expect(intent?.args.summary).toBe("lunchtime with sam");
  });
});
