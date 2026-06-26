import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ECronEngineJobType, type TCronEngineJobContext } from "../lib/cron-engine";
import type { TToolTaskArgs, TToolTaskResult } from "../services/ai/api";
import { SettingsService } from "../services/settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../services/settings/schema";
import { generateReminderText } from "./generate-reminder-text";

function createCronContext(overrides: Partial<TCronEngineJobContext> = {}): TCronEngineJobContext {
  return {
    name: "study-checkin",
    scope: "user-1",
    group: undefined,
    type: ECronEngineJobType.Recurring,
    pattern: "0 9 * * *",
    reminderText: undefined,
    reminderPromptData: '{"topic":"study","tone":"encouraging"}',
    reminderFallbackText: "Fallback reminder.",
    lastRunAt: undefined,
    nextRunAt: new Date("2026-01-05T08:00:00.000Z"),
    createdAt: new Date("2026-01-01T08:00:00.000Z"),
    timezone: undefined,
    ...overrides,
  };
}

function resetSettingsInstance() {
  const SettingsServiceStatic = SettingsService as unknown as { _instance: unknown };
  SettingsServiceStatic._instance = undefined;
}

function mockSettingsAll(record: TConfigRecord) {
  const SettingsServiceStatic = SettingsService as unknown as { _instance: unknown };
  SettingsServiceStatic._instance = {
    getAll: mock(async () => record),
  };
}

function createAi() {
  const capturedArgs: TToolTaskArgs[] = [];
  const ai = {
    runToolTask: mock(async (args: TToolTaskArgs): Promise<TToolTaskResult> => {
      capturedArgs.push(args);

      return {
        assistantResponse: "Generated reminder.",
        toolCalls: [],
        toolResults: [],
      };
    }),
  };

  return { ai, capturedArgs };
}

describe("generateReminderText", () => {
  beforeEach(() => {
    resetSettingsInstance();
  });

  afterEach(() => {
    resetSettingsInstance();
  });

  test("passes fire timestamp and timezone to generated reminder prompt", async () => {
    mockSettingsAll(DefaultConfigRecord);
    const { ai, capturedArgs } = createAi();

    const result = await generateReminderText(createCronContext(), ai);
    const promptText = capturedArgs[0]?.prompt.content[0]?.text;

    expect(result).toBe("Generated reminder.");
    expect(promptText).toContain('"topic":"study"');
    expect(promptText).toContain('"fireTimestamp":"2026-01-05T08:00:00.000Z"');
    expect(promptText).toContain('"timezone":"Europe/Warsaw"');
    expect(promptText).toContain('"localDateTime":"2026-01-05 09:00:00"');
    expect(promptText).toContain('"localWeekday":"Monday"');
  });

  test("uses ctx.timezone for reminder prompt when context provides one", async () => {
    const { ai, capturedArgs } = createAi();

    const result = await generateReminderText(
      createCronContext({ timezone: "America/New_York" }),
      ai,
    );
    const promptText = capturedArgs[0]?.prompt.content[0]?.text;

    expect(result).toBe("Generated reminder.");
    expect(promptText).toContain('"timezone":"America/New_York"');
    expect(promptText).toContain('"localDateTime":"2026-01-05 03:00:00"');
  });

  test("uses owner settings timezone when ctx.timezone is missing", async () => {
    mockSettingsAll({
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsTimezone]: "America/New_York",
    });
    const { ai, capturedArgs } = createAi();

    await generateReminderText(createCronContext({ scope: "user-1", timezone: undefined }), ai);
    const promptText = capturedArgs[0]?.prompt.content[0]?.text;

    expect(promptText).toContain('"timezone":"America/New_York"');
    expect(promptText).toContain('"localDateTime":"2026-01-05 03:00:00"');
  });

  test("ctx.timezone beats owner settings timezone", async () => {
    mockSettingsAll({
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsTimezone]: "America/New_York",
    });
    const { ai, capturedArgs } = createAi();

    await generateReminderText(createCronContext({ scope: "user-1", timezone: "Asia/Tokyo" }), ai);
    const promptText = capturedArgs[0]?.prompt.content[0]?.text;

    expect(promptText).toContain('"timezone":"Asia/Tokyo"');
    expect(promptText).not.toContain('"timezone":"America/New_York"');
  });

  test("loads owner settings for runToolTask even when ctx.timezone is present", async () => {
    const ownerSettings: TConfigRecord = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsTimezone]: "America/New_York",
      [EConfigKey.AiProvider]: "openrouter",
    };
    mockSettingsAll(ownerSettings);
    const { ai, capturedArgs } = createAi();

    await generateReminderText(createCronContext({ scope: "user-1", timezone: "Asia/Tokyo" }), ai);

    const promptText = capturedArgs[0]?.prompt.content[0]?.text;
    expect(promptText).toContain('"timezone":"Asia/Tokyo"');

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]?.settings).toBe(ownerSettings);
    expect(capturedArgs[0]?.settings[EConfigKey.AiProvider]).toBe("openrouter");
  });
});
