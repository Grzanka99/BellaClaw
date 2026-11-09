import { describe, expect, test } from "bun:test";
import { compile, type Schema } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import {
  SCreateCalendarEventArgs,
  validateCreateCalendarEventArgs,
} from "./create-calendar-event/handler";
import { validateToolArguments } from "./definition";
import { SDeleteCalendarEventArgs } from "./delete-calendar-event/handler";
import { SForgetMemoryArgs } from "./forget-memory/definition";
import { SRememberMemoryArgs } from "./remember-memory/definition";
import { SScheduleOnceArgs, validateScheduleOnceArgs } from "./schedule-once/handler";
import {
  SScheduleRecurringArgs,
  validateScheduleRecurringArgs,
} from "./schedule-recurring/handler";
import { SSearchMemoryArgs } from "./search-memory/definition";
import {
  SUpdateCalendarEventArgs,
  validateUpdateCalendarEventArgs,
} from "./update-calendar-event/handler";
import { SUpdateCronJobArgs, validateUpdateCronJobArgs } from "./update-cron-job/handler";

describe("AI tool arguments", () => {
  test("enforce structural constraints", () => {
    expect(compile(SScheduleOnceArgs, { formats }).check({ name: "x", fireAt: "invalid" })).toBe(
      false,
    );
    expect(
      compile(SScheduleRecurringArgs, { formats }).check({ name: "x", pattern: "0 8 * * *" }),
    ).toBe(true);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "facts", limit: 0 })).toBe(false);
    expect(
      compile(SRememberMemoryArgs, { formats }).check({
        fact: "The user likes tea.",
        sourceMessage: "I like tea.",
        supersedesFactIds: [],
      }),
    ).toBe(true);
    expect(compile(SForgetMemoryArgs, { formats }).check({ factIds: [1, 2] })).toBe(true);
    for (const factIds of [[], [1, 1], [0], [1.5]]) {
      expect(compile(SForgetMemoryArgs, { formats }).check({ factIds })).toBe(false);
    }
    expect(compile(SUpdateCronJobArgs, { formats }).check({ name: "x", unknown: true })).toBe(
      false,
    );
  });

  test("uses the semantic memory search schema", () => {
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "facts" })).toBe(true);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "" })).toBe(false);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "   " })).toBe(false);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "a".repeat(120) })).toBe(true);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "a".repeat(121) })).toBe(false);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "facts", limit: 25 })).toBe(true);
    expect(compile(SSearchMemoryArgs, { formats }).check({ query: "facts", limit: 26 })).toBe(
      false,
    );
  });

  test("resolves local schedule dates with the offset valid at fire time", () => {
    const summer = validateScheduleOnceArgs(
      { name: "summer-reminder", fireAt: "2026-07-13T12:00:00", reminderText: "Reminder" },
      "Europe/Warsaw",
    );
    expect(summer.fireAt).toEqual(new Date("2026-07-13T10:00:00.000Z"));

    const winter = validateScheduleOnceArgs(
      { name: "winter-reminder", fireAt: "2026-10-27T08:00", reminderText: "Reminder" },
      "Europe/Warsaw",
    );
    expect(winter.fireAt).toEqual(new Date("2026-10-27T07:00:00.000Z"));
  });

  test("rejects local schedule dates that do not exist", () => {
    for (const fireAt of ["2027-04-31T10:00:00", "2027-02-29T10:00", "2027-03-28T02:30:00"]) {
      expect(() =>
        validateScheduleOnceArgs({ name: "x", fireAt, reminderText: "Reminder" }, "Europe/Warsaw"),
      ).toThrow("does not exist in Europe/Warsaw");
    }
  });

  test("rejects schedule dates with an offset", () => {
    expect(
      compile(SScheduleOnceArgs, { formats }).check({ name: "x", fireAt: "2026-07-13T12:00:00Z" }),
    ).toBe(false);
  });

  test("does not count blank schedule content as a second content mode", () => {
    const blanks = {
      reminderPromptData: "",
      reminderFallbackText: "   ",
      taskPrompt: "",
      taskFallbackText: "   ",
    };

    const once = validateScheduleOnceArgs(
      {
        name: "blank-fields-reminder",
        fireAt: "2026-07-13T12:00:00",
        reminderText: "Reminder",
        ...blanks,
      },
      "Europe/Warsaw",
    );
    expect(once.reminderText).toBe("Reminder");
    expect(once.taskPrompt).toBeUndefined();

    const recurring = validateScheduleRecurringArgs({
      name: "blank-fields-recurring",
      pattern: "0 8 * * *",
      reminderText: "Reminder",
      ...blanks,
    });
    expect(recurring.reminderText).toBe("Reminder");
    expect(recurring.taskPrompt).toBeUndefined();
  });

  test("treats blank cron job updates as absent instead of content edits", () => {
    const update = validateUpdateCronJobArgs({
      name: "daily-news",
      pattern: "",
      fireAt: "  ",
      group: "",
      reminderText: "   ",
      reminderPromptData: "",
      reminderFallbackText: "",
      taskPrompt: "",
      taskFallbackText: "",
    });

    expect(update.pattern).toBeUndefined();
    expect(update.fireAt).toBeUndefined();
    expect(update.group).toBeUndefined();
    expect(update.reminderText).toBeUndefined();
    expect(update.taskPrompt).toBeUndefined();
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
        fireAt: "2026-07-13T10:00:00",
      }),
    ).toThrow("Provide either pattern or fireAt");
  });

  test("accepts valid mutation args and validates event combinations", () => {
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
      expect(compile(schema, { formats }).check(args)).toBe(true);
    }
    expect(
      compile(SCreateCalendarEventArgs, { formats }).check({
        summary: "Event",
        start: "2026-08-01T10:00:00+02:00",
        durationMinutes: 30,
      }),
    ).toBe(false);

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

describe("validateToolArguments", () => {
  test("names the offending path instead of throwing a bare Decode error", () => {
    const cases: Array<{ schema: Schema; args: unknown; path: string; reason: string }> = [
      {
        schema: SScheduleOnceArgs,
        args: { name: "x", fireAt: "tomorrow at 5pm", reminderText: "Reminder" },
        path: "/fireAt",
        reason: "expected to match",
      },
      {
        schema: SScheduleOnceArgs,
        args: {
          name: "x",
          fireAt: "2026-09-01T10:00:00",
          reminderText: "Reminder",
          group: null,
        },
        path: "/group",
        reason: "expected string, got null",
      },
      {
        schema: SSearchMemoryArgs,
        args: { query: "facts", limit: 99 },
        path: "/limit",
        reason: "expected <= 25",
      },
      {
        schema: SSearchMemoryArgs,
        args: {},
        path: "/query",
        reason: "missing",
      },
    ];

    for (const { schema, args, path, reason } of cases) {
      expect(() => validateToolArguments(schema, args)).toThrow(
        `Invalid tool arguments: ${path}: ${reason}`,
      );
    }
  });

  test("returns the decoded arguments for a valid payload", () => {
    expect(validateToolArguments(SSearchMemoryArgs, { query: "tea", limit: 3 })).toEqual({
      query: "tea",
      limit: 3,
    });
  });
});
