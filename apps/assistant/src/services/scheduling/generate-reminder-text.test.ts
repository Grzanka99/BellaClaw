import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { AgentHarness } from "../ai/agent-harness";
import type { LlmClient } from "../ai/llm";
import { EModelPurpose } from "../ai/types";
import { ECronJobType, type TCronJobContext } from "../cron/types";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { generateReminderText, generateScheduledTaskText } from "./generate-reminder-text";

const TEST_TRACE: TBehaviorTraceContext = {
  turnId: "test",
  chatId: undefined,
  platform: undefined,
};

function context(overrides: Partial<TCronJobContext> = {}): TCronJobContext {
  return {
    name: "briefing",
    scope: "signal:+100",
    type: ECronJobType.Recurring,
    pattern: "0 9 * * *",
    content: {
      kind: "generated",
      promptData: '{"topic":"study"}',
      fallback: "Reminder unavailable.",
    },
    lastRunAt: undefined,
    nextRunAt: new Date("2026-01-05T08:00:00.000Z"),
    createdAt: new Date("2026-01-01T08:00:00.000Z"),
    timezone: undefined,
    ...overrides,
  };
}

function settings(record = DefaultConfigRecord) {
  (SettingsService as unknown as { _instance: unknown })._instance = {
    getAll: mock(async () => record),
  };
}

afterEach(() => {
  (SettingsService as unknown as { _instance: unknown })._instance = undefined;
});

describe("generateReminderText", () => {
  test("returns direct reminder text without invoking AI", async () => {
    const ai = { completeText: mock(async () => "unused") };
    expect(
      await generateReminderText(
        context({ content: { kind: "text", text: "  Call Mum.  " } }),
        EMessagePlatform.Signal,
        ai,
        TEST_TRACE,
      ),
    ).toBe("Call Mum.");
    expect(ai.completeText).not.toHaveBeenCalled();
  });

  test("passes the immutable owner settings and firing context to direct completion", async () => {
    const ownerSettings = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsTimezone]: "America/New_York",
      [EConfigKey.AiInstructionsLanguage]: "Polish",
      [EConfigKey.AiInstructionsAddressStyle]: "Address the owner as Captain",
    };
    settings(ownerSettings);
    const captured: Array<Parameters<LlmClient["completeText"]>[0]> = [];
    const completeText = mock(async (args: Parameters<LlmClient["completeText"]>[0]) => {
      captured.push(args);
      return "Generated reminder.";
    });

    const result = await generateReminderText(
      context(),
      EMessagePlatform.Signal,
      { completeText },
      TEST_TRACE,
    );
    const args = captured[0];

    expect(result).toBe("Generated reminder.");
    expect(args?.purpose).toBe(EModelPurpose.Main);
    expect(args?.settings).toBe(ownerSettings);
    expect(args?.prompt).toContain('"fireTimestamp":"2026-01-05T08:00:00.000Z"');
    expect(args?.prompt).toContain('"timezone":"America/New_York"');
    expect(args?.prompt).toContain('"localDateTime":"2026-01-05 03:00:00"');
    expect(args?.prompt).toContain('"localWeekday":"Monday"');
    expect(args?.instructions).toContain("Always reply in Polish");
    expect(args?.instructions).toContain("Address the owner as Captain");
    expect(args?.instructions).toContain("You are replying through Signal");
    expect(args?.instructions).toContain("Never use headings, tables, blockquotes");
  });

  test("uses fallback for blank output and failures", async () => {
    settings();
    expect(
      await generateReminderText(
        context(),
        EMessagePlatform.Signal,
        {
          completeText: mock(async () => "   "),
        },
        TEST_TRACE,
      ),
    ).toBe("Reminder unavailable.");
    expect(
      await generateReminderText(
        context(),
        EMessagePlatform.Signal,
        {
          completeText: mock(async () => {
            throw new Error("provider failed");
          }),
        },
        TEST_TRACE,
      ),
    ).toBe("Reminder unavailable.");
  });
});

describe("generateScheduledTaskText", () => {
  test("runs the Scheduled Task Agent with firing, scope, platform, and owner settings", async () => {
    const ownerSettings = structuredClone(DefaultConfigRecord);
    settings(ownerSettings);
    const captured: Array<Parameters<AgentHarness["runScheduledTask"]>[0]> = [];
    const runScheduledTask = mock(async (args: Parameters<AgentHarness["runScheduledTask"]>[0]) => {
      captured.push(args);
      return {
        text: "Fresh briefing.",
        stopReason: "completed",
        iterations: 2,
        toolCallCount: 2,
      };
    });

    const result = await generateScheduledTaskText(
      context({
        content: { kind: "task", prompt: "Prepare a briefing.", fallback: "Briefing unavailable." },
      }),
      EMessagePlatform.Signal,
      { runScheduledTask },
      TEST_TRACE,
    );
    const args = captured[0];

    expect(result).toEqual(
      expect.objectContaining({
        text: "Fresh briefing.",
        stopReason: "completed",
        iterations: 2,
        toolCallCount: 2,
      }),
    );
    expect(args?.chatId).toBe("signal:+100");
    expect(args?.platform).toBe(EMessagePlatform.Signal);
    expect(args?.settings).toBe(ownerSettings);
    expect(args?.currentTimeContext).toContain('"fireTimestamp":"2026-01-05T08:00:00.000Z"');
  });

  test("uses fallback for blank output and thrown failures", async () => {
    settings();
    const task = context({
      content: { kind: "task", prompt: "Prepare a briefing.", fallback: "Briefing unavailable." },
    });

    expect(
      (
        await generateScheduledTaskText(
          task,
          EMessagePlatform.Signal,
          {
            runScheduledTask: mock(async () => ({
              text: " ",
              stopReason: "iteration-limit",
              iterations: 30,
              toolCallCount: 29,
            })),
          },
          TEST_TRACE,
        )
      ).text,
    ).toBe("Briefing unavailable.");
    expect(
      (
        await generateScheduledTaskText(
          task,
          EMessagePlatform.Signal,
          {
            runScheduledTask: mock(async () => {
              throw new Error("provider failed");
            }),
          },
          TEST_TRACE,
        )
      ).text,
    ).toBe("Briefing unavailable.");
  });
});
