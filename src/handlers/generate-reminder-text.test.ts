import { describe, expect, mock, test } from "bun:test";
import { ECronEngineJobType, type TCronEngineJobContext } from "../lib/cron-engine";
import type { TToolTaskArgs, TToolTaskResult } from "../services/ai/api";
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
    ...overrides,
  };
}

describe("generateReminderText", () => {
  test("passes fire timestamp and timezone to generated reminder prompt", async () => {
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

    const result = await generateReminderText(createCronContext(), ai);
    const promptText = capturedArgs[0]?.prompt.content[0]?.text;

    expect(result).toBe("Generated reminder.");
    expect(promptText).toContain('"topic":"study"');
    expect(promptText).toContain('"fireTimestamp":"2026-01-05T08:00:00.000Z"');
    expect(promptText).toContain('"timezone":"Europe/Warsaw"');
    expect(promptText).toContain('"localDateTime":"2026-01-05 09:00:00"');
    expect(promptText).toContain('"localWeekday":"Monday"');
  });
});
