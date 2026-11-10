import { describe, expect, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { SScheduleRecurringArgs, validateScheduleRecurringArgs } from ".";

describe("schedule-recurring", () => {
  test("accepts a cron pattern", () => {
    expect(
      compile(SScheduleRecurringArgs, { formats }).check({ name: "x", pattern: "0 8 * * *" }),
    ).toBe(true);
  });

  test("does not count blank schedule content as a second content mode", () => {
    const recurring = validateScheduleRecurringArgs({
      name: "blank-fields-recurring",
      pattern: "0 8 * * *",
      reminderText: "Reminder",
      reminderPromptData: "",
      reminderFallbackText: "   ",
      taskPrompt: "",
      taskFallbackText: "   ",
    });
    expect(recurring.content).toEqual({ kind: "text", text: "Reminder" });
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
  });
});
