import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { createCalendarEventTool } from "./create-calendar-event/definition";
import {
  SCreateCalendarEventArgs,
  validateCreateCalendarEventArgs,
} from "./create-calendar-event/handler";
import { deleteCalendarEventTool } from "./delete-calendar-event/definition";
import { SDeleteCalendarEventArgs } from "./delete-calendar-event/handler";
import { findCalendarAvailabilityTool } from "./find-calendar-availability/definition";
import { getSettingsTool } from "./get-settings/definition";
import { listCalendarEventsTool } from "./list-calendar-events/definition";
import { listCalendarsTool } from "./list-calendars/definition";
import { listCronJobsTool } from "./list-cron-jobs/definition";
import { removeReadonlyCalendarTool } from "./remove-readonly-calendar/definition";
import { scheduleOnceTool } from "./schedule-once/definition";
import { SScheduleOnceArgs, validateScheduleOnceArgs } from "./schedule-once/handler";
import { scheduleRecurringTool } from "./schedule-recurring/definition";
import {
  SScheduleRecurringArgs,
  validateScheduleRecurringArgs,
} from "./schedule-recurring/handler";
import { SSearchMemoryArgs, searchMemoryTool } from "./search-memory/definition";
import { unscheduleCronJobTool } from "./unschedule-cron-job/definition";
import { updateCalendarEventTool } from "./update-calendar-event/definition";
import {
  SUpdateCalendarEventArgs,
  validateUpdateCalendarEventArgs,
} from "./update-calendar-event/handler";
import { updateCronJobTool } from "./update-cron-job/definition";
import { SUpdateCronJobArgs, validateUpdateCronJobArgs } from "./update-cron-job/handler";
import { updateSettingsTool } from "./update-settings/definition";
import { webFetchTool } from "./web-fetch/definition";
import { webSearchTool } from "./web-search/definition";

const ALL_TOOLS = [
  createCalendarEventTool,
  deleteCalendarEventTool,
  findCalendarAvailabilityTool,
  getSettingsTool,
  listCalendarEventsTool,
  listCalendarsTool,
  listCronJobsTool,
  removeReadonlyCalendarTool,
  scheduleOnceTool,
  scheduleRecurringTool,
  searchMemoryTool,
  unscheduleCronJobTool,
  updateCronJobTool,
  updateCalendarEventTool,
  updateSettingsTool,
  webFetchTool,
  webSearchTool,
];

describe("AI tool definitions", () => {
  test("expose Pi-native TypeBox parameter schemas", () => {
    expect(ALL_TOOLS).toHaveLength(17);
    expect(new Set(ALL_TOOLS.map((tool) => tool.name)).size).toBe(17);

    for (const tool of ALL_TOOLS) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect("type" in tool.parameters && tool.parameters.type).toBe("object");
      expect(() => JSON.stringify(tool.parameters)).not.toThrow();
    }
  });

  test("enforce structural constraints", () => {
    expect(Value.Check(SScheduleOnceArgs, { name: "x", fireAt: "invalid" })).toBe(false);
    expect(Value.Check(SScheduleRecurringArgs, { name: "x", pattern: "0 8 * * *" })).toBe(true);
    expect(Value.Check(SSearchMemoryArgs, { query: "facts", limit: 0 })).toBe(false);
    expect(Value.Check(SUpdateCronJobArgs, { name: "x", unknown: true })).toBe(false);
  });

  test("uses the semantic memory search schema", () => {
    expect(Value.Check(SSearchMemoryArgs, { query: "facts" })).toBe(true);
    expect(Value.Check(SSearchMemoryArgs, { query: "" })).toBe(false);
    expect(Value.Check(SSearchMemoryArgs, { query: "   " })).toBe(false);
    expect(Value.Check(SSearchMemoryArgs, { query: "a".repeat(120) })).toBe(true);
    expect(Value.Check(SSearchMemoryArgs, { query: "a".repeat(121) })).toBe(false);
    expect(Value.Check(SSearchMemoryArgs, { query: "facts", limit: 25 })).toBe(true);
    expect(Value.Check(SSearchMemoryArgs, { query: "facts", limit: 26 })).toBe(false);
    expect(Value.Check(SSearchMemoryArgs, { query: "facts", searchString: "legacy" })).toBe(false);
    expect(Value.Check(SSearchMemoryArgs, { query: "facts", timeRange: {} })).toBe(false);
    expect(Value.Check(SSearchMemoryArgs, { query: "facts", importance: ["high"] })).toBe(false);
  });

  test("converts explicit-offset schedule dates", () => {
    const once = validateScheduleOnceArgs({
      name: "offset-reminder",
      fireAt: "2026-07-13T12:00:00+02:00",
      reminderText: "Reminder",
    });
    expect(once.fireAt).toEqual(new Date("2026-07-13T10:00:00.000Z"));
  });

  test("enforce cron domain constraints", () => {
    expect(() =>
      validateScheduleRecurringArgs({
        name: "daily-news",
        pattern: "0 8 * * *",
      }),
    ).toThrow("Provide reminderText, reminderPromptData, or taskPrompt");
    expect(() =>
      validateScheduleRecurringArgs({
        name: "daily-news",
        pattern: "0 8 * * *",
        taskPrompt: "Find news",
      }),
    ).toThrow("taskFallbackText is required");
    expect(() =>
      validateUpdateCronJobArgs({
        name: "daily-news",
        pattern: "0 8 * * *",
        fireAt: "2026-07-13T10:00:00Z",
      }),
    ).toThrow("Provide either pattern or fireAt");
  });

  test("keeps mutation targets structural and validates event combinations", () => {
    for (const { schema, args } of [
      {
        schema: SCreateCalendarEventArgs,
        args: { summary: "Event", start: "2026-08-01" },
      },
      {
        schema: SDeleteCalendarEventArgs,
        args: { eventId: "event", scope: "occurrence" },
      },
      {
        schema: SUpdateCalendarEventArgs,
        args: { eventId: "event", scope: "occurrence", summary: "Event" },
      },
    ]) {
      expect("calendarId" in schema.properties).toBe(false);
      expect(Value.Check(schema, args)).toBe(true);
      expect(Value.Check(schema, { ...args, calendarId: "other" })).toBe(false);
    }

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
        summary: "Holiday",
        start: "2026-08-01",
        durationMinutes: 30,
      }),
    ).toThrow("All-day events do not accept durationMinutes");
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
});
