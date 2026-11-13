import { describe, expect, mock, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { TEventRequester } from "../../../events";
import { EEventType } from "../../../events/catalog";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { SUpdateCalendarEventArgs, updateCalendarEvent, validateUpdateCalendarEventArgs } from ".";

function contextWith(request: ReturnType<typeof mock>) {
  return {
    chatId: "discord:1",
    settings: DefaultConfigRecord,
    trace: { turnId: "test", chatId: undefined, platform: undefined },
    events: { ...testEventRequester, request: request as unknown as TEventRequester["request"] },
    verifySettings: mock(async () => undefined),
    runScheduledTask: mock(async () => {
      throw new Error("not used");
    }),
  };
}

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
    const request = mock(async () => ({
      payload: { chatId: "discord:1", event: { id: "event" } },
    }));
    const tool = updateCalendarEvent.createAgentTool(contextWith(request));

    const result = await tool.execute("call", {
      eventId: "event",
      scope: "occurrence",
      start: "2026-08-01T10:00:00+02:00",
    });

    expect(request).toHaveBeenCalledWith(
      EEventType.CalendarEventUpdateRequested,
      {
        chatId: "discord:1",
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
      },
      expect.objectContaining({ outcome: EEventType.CalendarEventUpdated, key: "discord:1" }),
    );
    expect(result.details).toEqual({ id: "event" });
  });
});
