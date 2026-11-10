import { afterEach, describe, expect, mock, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { CalendarService } from "../../calendar";
import { DefaultConfigRecord } from "../../settings/schema";
import {
  createCalendarEvent,
  SCreateCalendarEventArgs,
  validateCreateCalendarEventArgs,
} from "./create-calendar-event";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  verifySettings: mock(async () => undefined),
};

afterEach(() => {
  (CalendarService as unknown as { _instance: unknown })._instance = undefined;
});

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

  test("uses the configured timezone and trusted service for calendar creation", async () => {
    const createEvent = mock(async (args) => args);
    (CalendarService as unknown as { _instance: unknown })._instance = { createEvent };
    const tool = createCalendarEvent.createAgentTool(context);

    await tool.execute("call", {
      summary: "Meeting",
      start: "2026-08-01T10:00:00+02:00",
    });

    expect(createEvent).toHaveBeenCalledWith({
      userId: "discord:1",
      summary: "Meeting",
      start: "2026-08-01T10:00:00+02:00",
      timezone: "Europe/Warsaw",
      signal: undefined,
    });
  });
});
