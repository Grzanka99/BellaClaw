import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ECronJobType, type TCronJobContext } from "../lib/cron-engine";
import {
  EAssistantLoopStopReason,
  type TAssistantToolLoopArgs,
  type TAssistantToolLoopResult,
  type TToolTaskArgs,
  type TToolTaskResult,
} from "../services/ai/api";
import { EMessagePlatform } from "../services/messaging/types";
import { SettingsService } from "../services/settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../services/settings/schema";
import { generateReminderText, generateScheduledTaskText } from "./generate-reminder-text";

function createCronContext(overrides: Partial<TCronJobContext> = {}): TCronJobContext {
  return {
    name: "study-checkin",
    scope: "user-1",
    group: undefined,
    type: ECronJobType.Recurring,
    pattern: "0 9 * * *",
    reminderText: undefined,
    reminderPromptData: '{"topic":"study","tone":"encouraging"}',
    reminderFallbackText: "Fallback reminder.",
    taskPrompt: undefined,
    taskFallbackText: undefined,
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

  test("uses the reminder scope platform for generated text", async () => {
    mockSettingsAll(DefaultConfigRecord);
    const { ai, capturedArgs } = createAi();

    await generateReminderText(createCronContext({ scope: "signal:+100" }), ai);

    expect(capturedArgs[0]?.platform).toBe(EMessagePlatform.Signal);
  });
});

describe("generateScheduledTaskText", () => {
  beforeEach(() => {
    resetSettingsInstance();
  });

  afterEach(() => {
    resetSettingsInstance();
  });

  test("runs a bounded web-only loop without a user or conversation history", async () => {
    mockSettingsAll(DefaultConfigRecord);
    const capturedArgs: TAssistantToolLoopArgs[] = [];
    const ai = {
      runAssistantToolLoop: mock(
        async (args: TAssistantToolLoopArgs): Promise<TAssistantToolLoopResult> => {
          capturedArgs.push(args);
          return {
            conversation: [],
            toolActivity: [],
            finalResponse: "Fresh briefing with sources.",
            stopReason: EAssistantLoopStopReason.FinalResponse,
            iterations: 2,
          };
        },
      ),
    };

    const result = await generateScheduledTaskText(
      createCronContext({
        scope: "discord:user-1",
        reminderPromptData: undefined,
        reminderFallbackText: undefined,
        taskPrompt: "Prepare a daily briefing.",
        taskFallbackText: "Briefing unavailable.",
      }),
      ai,
    );
    const args = capturedArgs[0];

    expect(result.text).toBe("Fresh briefing with sources.");
    expect(args?.user).toBeUndefined();
    expect(args?.history).toHaveLength(1);
    expect(args?.chatId).toBe("discord:user-1");
    expect(args?.maxIterations).toBe(4);
    expect(args?.tools.map((tool) => tool.definition.name)).toEqual(["web-search", "web-fetch"]);
  });

  test("uses the fallback for output-limited task output", async () => {
    const ai = {
      runAssistantToolLoop: mock(async (): Promise<TAssistantToolLoopResult> => {
        return {
          conversation: [],
          toolActivity: [],
          finalResponse: "Truncated response",
          stopReason: EAssistantLoopStopReason.OutputLimit,
          iterations: 1,
        };
      }),
    };

    const result = await generateScheduledTaskText(
      createCronContext({
        reminderPromptData: undefined,
        reminderFallbackText: undefined,
        taskPrompt: "Prepare a daily briefing.",
        taskFallbackText: "Briefing unavailable.",
      }),
      ai,
    );

    expect(result.text).toBe("Briefing unavailable.");
    expect(result.stopReason).toBe(EAssistantLoopStopReason.OutputLimit);
  });

  test("uses fallback for all other unusable loop outcomes", async () => {
    const cases: Array<{
      stopReason: EAssistantLoopStopReason;
      finalResponse: string | undefined;
    }> = [
      { stopReason: EAssistantLoopStopReason.EmptyAssistantResponse, finalResponse: undefined },
      { stopReason: EAssistantLoopStopReason.Aborted, finalResponse: undefined },
      { stopReason: EAssistantLoopStopReason.MalformedProviderResponse, finalResponse: undefined },
      { stopReason: EAssistantLoopStopReason.RepeatedToolCall, finalResponse: undefined },
      { stopReason: EAssistantLoopStopReason.MaxIterations, finalResponse: undefined },
      { stopReason: EAssistantLoopStopReason.FinalResponse, finalResponse: "   " },
    ];

    for (const testCase of cases) {
      const ai = {
        runAssistantToolLoop: mock(async (): Promise<TAssistantToolLoopResult> => {
          return {
            conversation: [],
            toolActivity: [],
            finalResponse: testCase.finalResponse,
            stopReason: testCase.stopReason,
            iterations: 1,
          };
        }),
      };
      const result = await generateScheduledTaskText(
        createCronContext({
          reminderPromptData: undefined,
          reminderFallbackText: undefined,
          taskPrompt: "Prepare a daily briefing.",
          taskFallbackText: "Briefing unavailable.",
        }),
        ai,
      );

      expect(result.text).toBe("Briefing unavailable.");
    }
  });

  test("uses fallback when the task loop throws", async () => {
    const ai = {
      runAssistantToolLoop: mock(async () => {
        throw new Error("provider failed");
      }),
    };
    const result = await generateScheduledTaskText(
      createCronContext({
        reminderPromptData: undefined,
        reminderFallbackText: undefined,
        taskPrompt: "Prepare a daily briefing.",
        taskFallbackText: "Briefing unavailable.",
      }),
      ai,
    );

    expect(result.text).toBe("Briefing unavailable.");
    expect(result.stopReason).toBeUndefined();
  });

  test("accepts a nonblank forced-final response", async () => {
    const ai = {
      runAssistantToolLoop: mock(async (): Promise<TAssistantToolLoopResult> => {
        return {
          conversation: [],
          toolActivity: [],
          finalResponse: "Forced final briefing.",
          stopReason: EAssistantLoopStopReason.MaxIterations,
          iterations: 4,
        };
      }),
    };
    const result = await generateScheduledTaskText(
      createCronContext({
        reminderPromptData: undefined,
        reminderFallbackText: undefined,
        taskPrompt: "Prepare a daily briefing.",
        taskFallbackText: "Briefing unavailable.",
      }),
      ai,
    );

    expect(result.text).toBe("Forced final briefing.");
  });
});
