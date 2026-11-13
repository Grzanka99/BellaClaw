import { describe, expect, mock, test } from "bun:test";
import { EEventType } from "@bellaclaw/database";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { TEventRequester } from "../../../events";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { createCalendarEvent, SCreateCalendarEventArgs, validateCreateCalendarEventArgs } from ".";

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

describe("create-calendar-event", () => {
  test("accepts valid args and rejects unknown fields", () => {
    expect(
      compile(SCreateCalendarEventArgs, { formats }).check({
        summary: "Event",
        start: "2026-08-01",
      }),
    ).toBe(true);
    expect(
      compile(SCreateCalendarEventArgs, { formats }).check({
        summary: "Event",
        start: "2026-08-01T10:00:00+02:00",
        durationMinutes: 30,
      }),
    ).toBe(false);
  });

  test("validates event date combinations and recurrence lines", () => {
    expect(() =>
      validateCreateCalendarEventArgs({
        summary: "Invalid holiday",
        start: "2026-02-30",
      }),
    ).toThrow("start must be a valid calendar date");
    expect(() =>
      validateCreateCalendarEventArgs({
        summary: "Invalid holiday",
        start: "2026-02-27",
        end: "2026-02-30",
      }),
    ).toThrow("end must be a valid calendar date");
    expect(() =>
      validateCreateCalendarEventArgs({
        summary: "Meeting",
        start: "2026-08-01T10:00:00",
      }),
    ).toThrow("explicit timezone");
    expect(() =>
      validateCreateCalendarEventArgs({
        summary: "Meeting",
        start: "2026-08-01T10:00:00+02:00",
        recurrence: ["FREQ=DAILY"],
      }),
    ).toThrow("Recurrence lines");
    expect(
      validateCreateCalendarEventArgs({
        summary: "Parameterized recurrence",
        start: "2026-08-01",
        recurrence: [
          "RDATE;VALUE=DATE:20260802",
          "RDATE;TZID=Europe/Warsaw:20260803T100000",
          "EXDATE;TZID=Europe/Warsaw:20260804T100000",
        ],
      }).recurrence,
    ).toHaveLength(3);
  });

  test("requests the create with the configured timezone on the chat's lane", async () => {
    const request = mock(async () => ({
      payload: { chatId: "discord:1", event: { id: "created", summary: "Meeting" } },
    }));
    const tool = createCalendarEvent.createAgentTool(contextWith(request));

    const result = await tool.execute("call", {
      summary: "Meeting",
      start: "2026-08-01T10:00:00+02:00",
    });

    expect(request).toHaveBeenCalledWith(
      EEventType.CalendarEventCreateRequested,
      {
        chatId: "discord:1",
        summary: "Meeting",
        start: "2026-08-01T10:00:00+02:00",
        timezone: "Europe/Warsaw",
      },
      expect.objectContaining({ outcome: EEventType.CalendarEventCreated, key: "discord:1" }),
    );
    expect(result.details).toEqual({ id: "created", summary: "Meeting" });
  });
});
