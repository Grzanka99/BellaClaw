import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { defineMessageImportanceTool } from "./define-message-importance/definition";
import { getSettingsTool } from "./get-settings/definition";
import { listCronJobsTool } from "./list-cron-jobs/definition";
import { scheduleOnceTool } from "./schedule-once/definition";
import { SScheduleOnceArgs, validateScheduleOnceArgs } from "./schedule-once/handler";
import { scheduleRecurringTool } from "./schedule-recurring/definition";
import {
  SScheduleRecurringArgs,
  validateScheduleRecurringArgs,
} from "./schedule-recurring/handler";
import { searchMemoryTool } from "./search-memory/definition";
import { convertSearchMemoryArgs, SSearchMemoryArgs } from "./search-memory/handler";
import { unscheduleCronJobTool } from "./unschedule-cron-job/definition";
import { updateCronJobTool } from "./update-cron-job/definition";
import { SUpdateCronJobArgs, validateUpdateCronJobArgs } from "./update-cron-job/handler";
import { updateSettingsTool } from "./update-settings/definition";
import { webFetchTool } from "./web-fetch/definition";
import { webSearchTool } from "./web-search/definition";

const ALL_TOOLS = [
  defineMessageImportanceTool,
  getSettingsTool,
  listCronJobsTool,
  scheduleOnceTool,
  scheduleRecurringTool,
  searchMemoryTool,
  unscheduleCronJobTool,
  updateCronJobTool,
  updateSettingsTool,
  webFetchTool,
  webSearchTool,
];

describe("AI tool definitions", () => {
  test("expose Pi-native TypeBox parameter schemas", () => {
    expect(ALL_TOOLS).toHaveLength(11);
    expect(new Set(ALL_TOOLS.map((tool) => tool.name)).size).toBe(11);

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
    expect(Value.Check(SSearchMemoryArgs, { limit: 0 })).toBe(false);
    expect(Value.Check(SUpdateCronJobArgs, { name: "x", unknown: true })).toBe(false);
  });

  test("convert explicit-offset transport dates", () => {
    const once = validateScheduleOnceArgs({
      name: "offset-reminder",
      fireAt: "2026-07-13T12:00:00+02:00",
      reminderText: "Reminder",
    });
    expect(once.fireAt).toEqual(new Date("2026-07-13T10:00:00.000Z"));

    const memory = convertSearchMemoryArgs({
      timeRange: {
        start: "2026-07-13T10:00:00Z",
        end: "2026-07-13T12:00:00+02:00",
      },
    });
    expect(memory.timeRange?.start).toEqual(new Date("2026-07-13T10:00:00.000Z"));
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
});
