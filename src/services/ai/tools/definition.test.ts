import { describe, expect, test } from "bun:test";
import { defineMessageImportanceTool } from "./define-message-importance/definition";
import { defineSettingsIntentTool } from "./define-settings-intent/definition";
import { getSettingsTool } from "./get-settings/definition";
import { listCronJobsTool } from "./list-cron-jobs/definition";
import { scheduleOnceTool } from "./schedule-once/definition";
import { SScheduleOnceArgs } from "./schedule-once/handler";
import { scheduleRecurringTool } from "./schedule-recurring/definition";
import { SScheduleRecurringArgs } from "./schedule-recurring/handler";
import { searchMemoryTool } from "./search-memory/definition";
import { SSearchMemoryArgs } from "./search-memory/handler";
import { unscheduleCronJobTool } from "./unschedule-cron-job/definition";
import { updateCronJobTool } from "./update-cron-job/definition";
import { SUpdateCronJobArgs } from "./update-cron-job/handler";
import { updateSettingsTool } from "./update-settings/definition";
import { webFetchTool } from "./web-fetch/definition";
import { webSearchTool } from "./web-search/definition";

const ALL_TOOLS = [
  defineMessageImportanceTool,
  defineSettingsIntentTool,
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

const REQUIRED_FIELDS: Record<string, string[]> = {
  "define-message-importance": ["reasoning", "importance"],
  "define-settings-intent": ["intent", "reason"],
  "get-settings": [],
  "list-cron-jobs": [],
  "schedule-once": ["name", "fireAt"],
  "schedule-recurring": ["name", "pattern"],
  "search-memory": [],
  "unschedule-cron-job": ["name"],
  "update-cron-job": ["name"],
  "update-settings": [],
  "web-fetch": ["url"],
  "web-search": ["query"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProperty(tool: (typeof ALL_TOOLS)[number], property: string) {
  const properties = tool.parameters.properties;

  if (!isRecord(properties)) {
    throw new Error(`Expected properties for ${tool.name}`);
  }

  const value = properties[property];

  if (!isRecord(value)) {
    throw new Error(`Expected property ${property} for ${tool.name}`);
  }

  return value;
}

function expectPropertyDescriptions(schema: Record<string, unknown>, path: string) {
  const properties = schema.properties;

  if (!isRecord(properties)) {
    return;
  }

  for (const [name, property] of Object.entries(properties)) {
    if (!isRecord(property)) {
      throw new Error(`Expected schema property ${path}.${name}`);
    }

    expect(typeof property.description).toBe("string");
    expectPropertyDescriptions(property, `${path}.${name}`);
  }
}

describe("AI tool definitions", () => {
  test("all tools expose direct Pi-shaped definitions generated from JSON Schema", () => {
    expect(ALL_TOOLS).toHaveLength(12);
    expect(new Set(ALL_TOOLS.map((tool) => tool.name)).size).toBe(12);

    for (const tool of ALL_TOOLS) {
      const requiredFields = REQUIRED_FIELDS[tool.name];

      if (requiredFields === undefined) {
        throw new Error(`Missing required-field contract for ${tool.name}`);
      }

      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.$schema).toBeUndefined();
      expect("function" in tool).toBe(false);
      expect("type" in tool).toBe(false);
      expect(() => JSON.stringify(tool.parameters)).not.toThrow();
      expect(tool.parameters.required ?? []).toEqual(requiredFields);
      expectPropertyDescriptions(tool.parameters, tool.name);
    }
  });

  test("keeps field descriptions, enums, and numeric bounds", () => {
    expect(readProperty(defineMessageImportanceTool, "importance").enum).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(readProperty(defineSettingsIntentTool, "intent").enum).toEqual(["settings", "normal"]);
    expect(readProperty(webSearchTool, "maxResults")).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 10,
    });
    expect(readProperty(webFetchTool, "timeout")).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 45,
    });
    expect(updateSettingsTool.parameters).toMatchObject({
      minProperties: 1,
      additionalProperties: false,
    });
    expect(readProperty(searchMemoryTool, "limit")).toMatchObject({
      type: "integer",
      exclusiveMinimum: 0,
    });
    expect(readProperty(searchMemoryTool, "importance").items).toMatchObject({
      enum: ["low", "medium", "high"],
    });
    expect(readProperty(webSearchTool, "topic").enum).toEqual(["general", "news", "finance"]);
    expect(readProperty(webSearchTool, "timeRange").enum).toEqual(["day", "week", "month", "year"]);
    expect(readProperty(webFetchTool, "format").enum).toEqual(["markdown", "text", "html"]);
    expect(readProperty(updateSettingsTool, "aiProvider").enum).toEqual([
      "openai-codex",
      "openrouter",
      "ollama",
      "opencode-go",
    ]);
  });

  test("emits offset-aware date-time input schemas without conditional keywords", () => {
    for (const property of [
      readProperty(scheduleOnceTool, "fireAt"),
      readProperty(updateCronJobTool, "fireAt"),
    ]) {
      expect(property.type).toBe("string");
      expect(property.format).toBe("date-time");
      expect(String(property.pattern)).toContain("Z|");
    }

    const timeRange = readProperty(searchMemoryTool, "timeRange");
    expect(JSON.stringify(timeRange)).toContain('"format":"date-time"');

    for (const tool of ALL_TOOLS) {
      const serialized = JSON.stringify(tool.parameters);
      expect(serialized).not.toContain('"oneOf"');
      expect(serialized).not.toContain('"anyOf"');
      expect(serialized).not.toContain('"not"');
    }
  });

  test("accepts explicit offsets, transforms dates, and rejects ambiguous local times", () => {
    const once = SScheduleOnceArgs.safeParse({
      name: "offset-reminder",
      fireAt: "2026-07-13T12:00:00+02:00",
      reminderText: "Reminder",
    });
    expect(once.success).toBe(true);

    if (once.success) {
      expect(once.data.fireAt).toEqual(new Date("2026-07-13T10:00:00.000Z"));
    }

    expect(
      SScheduleOnceArgs.safeParse({
        name: "z-reminder",
        fireAt: "2026-07-13T10:00:00Z",
        reminderText: "Reminder",
      }).success,
    ).toBe(true);
    expect(
      SScheduleOnceArgs.safeParse({
        name: "ambiguous-reminder",
        fireAt: "2026-07-13T10:00:00",
        reminderText: "Reminder",
      }).success,
    ).toBe(false);
    expect(
      SUpdateCronJobArgs.safeParse({
        name: "existing-reminder",
        fireAt: "2026-07-13T10:00:00",
      }).success,
    ).toBe(false);
    expect(
      SSearchMemoryArgs.safeParse({
        timeRange: {
          start: "2026-07-13T10:00:00Z",
          end: "2026-07-13T12:00:00+02:00",
        },
      }).success,
    ).toBe(true);
    expect(
      SSearchMemoryArgs.safeParse({
        timeRange: {
          start: "2026-07-13T10:00:00",
          end: "2026-07-13T12:00:00+02:00",
        },
      }).success,
    ).toBe(false);
  });

  test("keeps reminder conditional rules in local Zod validation", () => {
    expect(
      SScheduleOnceArgs.safeParse({
        name: "missing-content",
        fireAt: "2026-07-13T10:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      SScheduleRecurringArgs.safeParse({
        name: "missing-fallback",
        pattern: "0 9 * * *",
        reminderPromptData: "{}",
      }).success,
    ).toBe(false);
  });
});
