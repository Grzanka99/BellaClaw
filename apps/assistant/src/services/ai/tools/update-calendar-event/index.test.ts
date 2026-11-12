import { afterEach, describe, expect, mock, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { CalendarService } from "../../../calendar";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { SUpdateCalendarEventArgs, updateCalendarEvent, validateUpdateCalendarEventArgs } from ".";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  events: testEventRequester,
  verifySettings: mock(async () => undefined),
  runScheduledTask: mock(async () => {
    throw new Error("not used");
  }),
};

afterEach(() => {
  (CalendarService as unknown as { _instance: unknown })._instance = undefined;
});

describe("update-calendar-event", () => {
  test("accepts valid args and validates field combinations", () => {
    expect(
      compile(SUpdateCalendarEventArgs, { formats }).check({
        eventId: "event",
        scope: "occurrence",
        summary: "Event",
      }),
    ).toBe(true);
    expect(() =>
      validateUpdateCalendarEventArgs({
        eventId: "event",
        scope: "occurrence",
      }),
    ).toThrow("Provide at least one event field");
    expect(() =>
      validateUpdateCalendarEventArgs({
        eventId: "event",
        scope: "occurrence",
        timezone: "Europe/Warsaw",
      }),
    ).toThrow("requires start");
  });

  test("preserves the existing timezone for start-only calendar updates", async () => {
    const updateEvent = mock(async (args) => args);
    (CalendarService as unknown as { _instance: unknown })._instance = { updateEvent };
    const tool = updateCalendarEvent.createAgentTool(context);

    await tool.execute("call", {
      eventId: "event",
      scope: "occurrence",
      start: "2026-08-01T10:00:00+02:00",
    });

    expect(updateEvent).toHaveBeenCalledWith({
      userId: "discord:1",
      eventId: "event",
      scope: "occurrence",
      patch: {
        summary: undefined,
        description: undefined,
        location: undefined,
        start: "2026-08-01T10:00:00+02:00",
        end: undefined,
        timezone: undefined,
        transparency: undefined,
        recurrence: undefined,
      },
      signal: undefined,
    });
  });
});
