import { describe, expect, it } from "vitest";
import { registerDefaultTools } from "@myla/tools";
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

  it("parses common AM/PM calendar event wording", () => {
    const intent = inferToolIntent("add an event to my calendar to visit baby Leo from 12pm to 6pm tmrw in san mateo");

    expect(intent?.toolName).toBe("google.calendar.create_event");
    expect(intent?.args.summary).toBe("Visit baby Leo");
    expect(intent?.args.location).toBe("san mateo");
    expect(String(intent?.args.startIso)).toContain("T12:00:00");
    expect(String(intent?.args.endIso)).toContain("T18:00:00");
  });

  it("routes configured text requests to Pushcut shortcuts", () => {
    process.env.PUSHCUT_API_KEY = "test-token";
    process.env.PUSHCUT_SHORTCUTS_JSON = JSON.stringify([
      {
        name: "send text message",
        notification: "send msg test",
        parameters: [
          { name: "recipient", required: true },
          { name: "message", required: true }
        ]
      }
    ]);
    registerDefaultTools();

    const intent = inferToolIntent("send a text message to nick just saying hello");

    expect(intent?.toolName).toBe("pushcut.send_text_message");
    expect(intent?.args.recipient).toBe("nick");
    expect(intent?.args.message).toBe("hello");

    delete process.env.PUSHCUT_API_KEY;
    delete process.env.PUSHCUT_SHORTCUTS_JSON;
  });

  it("routes configured Tesla lock requests to parameterless Pushcut shortcuts", () => {
    process.env.PUSHCUT_API_KEY = "test-token";
    process.env.PUSHCUT_SHORTCUTS_JSON = JSON.stringify([
      {
        name: "lock tesla car",
        notification: "lock tesla car",
        description: "Lock my Tesla car through a Pushcut-triggered iPhone Shortcut.",
        parameters: [],
        bodyMode: "none"
      }
    ]);
    registerDefaultTools();

    const intent = inferToolIntent("lock my tesla car");

    expect(intent?.toolName).toBe("pushcut.lock_tesla_car");

    delete process.env.PUSHCUT_API_KEY;
    delete process.env.PUSHCUT_SHORTCUTS_JSON;
  });
});
