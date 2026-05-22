import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { ECronEngineJobType } from "../../../lib/cron-engine";
import { CronSingleton } from "../../cron";
import { LIST_CRON_JOBS_TOOL } from "../tools/list-cron-jobs/definition";
import { SCHEDULE_ONCE_TOOL } from "../tools/schedule-once/definition";
import { executeToolCall } from "./tool-execution";

const tempDir = Bun.env.TMPDIR ?? "/var/folders/q5/24yvwq2937j076ff04yjn_dc0000gn/T/opencode";
const TEST_DB = join(tempDir, "test-ai-runtime-schedule-once-tool-execution.db");

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

function cleanupCronSingleton() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
  CronSingleton.resetDbFile();
}

function createToolCall(id: string, name: string, argumentsText: string): ChatMessageToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: argumentsText,
    },
  };
}

describe("schedule-once tool execution", () => {
  beforeEach(() => {
    cleanupCronSingleton();

    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }

    CronSingleton.setDbFile(TEST_DB);
  });

  afterEach(() => {
    cleanupCronSingleton();

    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
  });

  test("schedules one-time reminders and lists them", async () => {
    const chatId = "runtime-once-user";
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const scheduleResult = await executeToolCall({
      toolCall: createToolCall(
        "schedule-once",
        SCHEDULE_ONCE_TOOL,
        JSON.stringify({
          name: "stretch-once",
          fireAt,
          group: "health",
          reminderText: "Stretch now.",
        }),
      ),
      chatId,
      allowedToolNames: new Set([SCHEDULE_ONCE_TOOL, LIST_CRON_JOBS_TOOL]),
    });
    const listResult = await executeToolCall({
      toolCall: createToolCall("list-cron", LIST_CRON_JOBS_TOOL, "{}"),
      chatId,
      allowedToolNames: new Set([SCHEDULE_ONCE_TOOL, LIST_CRON_JOBS_TOOL]),
    });

    expect(scheduleResult.success).toBe(true);
    expect(scheduleResult.data).toMatchObject({
      name: "stretch-once",
      scope: chatId,
      group: "health",
      type: ECronEngineJobType.OneTime,
      pattern: undefined,
      reminderText: "Stretch now.",
      reminderPromptData: undefined,
      reminderFallbackText: "Stretch now.",
    });
    expect(listResult.success).toBe(true);
    expect(listResult.data).toMatchObject([
      {
        name: "stretch-once",
        scope: chatId,
        type: ECronEngineJobType.OneTime,
        pattern: undefined,
      },
    ]);
  });

  test("rejects past one-time reminders", async () => {
    const result = await executeToolCall({
      toolCall: createToolCall(
        "schedule-once-past",
        SCHEDULE_ONCE_TOOL,
        JSON.stringify({
          name: "past-once",
          fireAt: new Date(Date.now() - 60_000).toISOString(),
          reminderText: "Too late.",
        }),
      ),
      chatId: "runtime-once-user",
      allowedToolNames: new Set([SCHEDULE_ONCE_TOOL]),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("fireAt must be in the future");
  });
});
