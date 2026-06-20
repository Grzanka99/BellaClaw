import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { ECronEngineJobStatus, ECronEngineJobType } from "../../../lib/cron-engine";
import { CronSingleton } from "../../cron";
import { DatabaseConnector } from "../../database";
import { cronEngineJobsTable } from "../../database/schema";
import { resetCronEngineJobsTable } from "../../database/test-utils";
import { DefaultConfigRecord, EConfigKey } from "../../settings/schema";
import { SCHEDULE_ONCE_TOOL } from "../tools/schedule-once/definition";
import { SCHEDULE_RECURRING_TOOL } from "../tools/schedule-recurring/definition";
import { UPDATE_CRON_JOB_TOOL } from "../tools/update-cron-job/definition";
import { executeToolCall } from "./tool-execution";

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

function cleanupCronSingleton() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
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

async function insertLegacyRecurringJob(name: string, scope: string) {
  const db = DatabaseConnector.instance.database;
  const now = Date.now();

  await db.insert(cronEngineJobsTable).values({
    name,
    scope,
    group: null,
    type: ECronEngineJobType.Recurring,
    pattern: "0 9 * * *",
    reminderText: "Legacy reminder.",
    reminderPromptData: null,
    reminderFallbackText: "Legacy reminder.",
    nextRunAt: now + 60_000,
    lastRunAt: null,
    createdAt: now,
    status: ECronEngineJobStatus.Active,
    finishedAt: null,
    finishedReason: null,
    timezone: null,
  });
}

describe("update-cron-job tool execution", () => {
  beforeEach(async () => {
    cleanupCronSingleton();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    cleanupCronSingleton();
  });

  test("updates recurring reminder pattern and preserves content", async () => {
    const chatId = "runtime-update-recurring-user";

    await executeToolCall({
      toolCall: createToolCall(
        "schedule-cron",
        SCHEDULE_RECURRING_TOOL,
        JSON.stringify({
          name: "drink-water",
          pattern: "0 9 * * *",
          group: "health",
          reminderText: "Drink water.",
        }),
      ),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    const updateResult = await executeToolCall({
      toolCall: createToolCall(
        "update-cron",
        UPDATE_CRON_JOB_TOOL,
        JSON.stringify({
          name: "drink-water",
          pattern: "0 10 * * *",
        }),
      ),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.data).toMatchObject({
      name: "drink-water",
      scope: chatId,
      group: "health",
      type: ECronEngineJobType.Recurring,
      pattern: "0 10 * * *",
      reminderText: "Drink water.",
      reminderFallbackText: "Drink water.",
    });
  });

  test("updates recurring reminder and preserves existing timezone", async () => {
    const chatId = "runtime-update-recurring-timezone-user";

    const scheduled = await CronSingleton.instance.schedule({
      name: "timezone-reminder",
      scope: chatId,
      pattern: "0 9 * * *",
      timezone: "America/New_York",
      reminderText: "Timezone reminder.",
    });

    expect("error" in scheduled).toBe(false);

    const updateResult = await executeToolCall({
      toolCall: createToolCall(
        "update-cron-timezone",
        UPDATE_CRON_JOB_TOOL,
        JSON.stringify({
          name: "timezone-reminder",
          pattern: "0 10 * * *",
        }),
      ),
      chatId,
      allowedToolNames: new Set([UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.data).toMatchObject({
      name: "timezone-reminder",
      timezone: "America/New_York",
    });

    const updatedJob = await CronSingleton.instance.getJob("timezone-reminder", chatId);

    expect(updatedJob?.timezone).toBe("America/New_York");
  });

  test("updates legacy recurring reminder and applies owner timezone", async () => {
    const chatId = "runtime-update-legacy-timezone-user";
    const settings = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsTimezone]: "Asia/Tokyo",
    };

    await insertLegacyRecurringJob("legacy-timezone-reminder", chatId);

    const updateResult = await executeToolCall({
      toolCall: createToolCall(
        "update-legacy-timezone",
        UPDATE_CRON_JOB_TOOL,
        JSON.stringify({
          name: "legacy-timezone-reminder",
          pattern: "0 10 * * *",
        }),
      ),
      chatId,
      allowedToolNames: new Set([UPDATE_CRON_JOB_TOOL]),
      settings,
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.data).toMatchObject({
      name: "legacy-timezone-reminder",
      timezone: "Asia/Tokyo",
    });

    const updatedJob = await CronSingleton.instance.getJob("legacy-timezone-reminder", chatId);

    expect(updatedJob?.timezone).toBe("Asia/Tokyo");
  });

  test("updates one-time reminder text and preserves fire time", async () => {
    const chatId = "runtime-update-once-user";
    const fireAt = new Date(Date.now() + 60_000).toISOString();

    await executeToolCall({
      toolCall: createToolCall(
        "schedule-once",
        SCHEDULE_ONCE_TOOL,
        JSON.stringify({
          name: "stretch-once",
          fireAt,
          reminderPromptData: '{"topic":"stretching"}',
          reminderFallbackText: "Stretch now.",
        }),
      ),
      chatId,
      allowedToolNames: new Set([SCHEDULE_ONCE_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    const updateResult = await executeToolCall({
      toolCall: createToolCall(
        "update-once",
        UPDATE_CRON_JOB_TOOL,
        JSON.stringify({
          name: "stretch-once",
          reminderText: "Stand up and stretch.",
        }),
      ),
      chatId,
      allowedToolNames: new Set([SCHEDULE_ONCE_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.data).toMatchObject({
      name: "stretch-once",
      scope: chatId,
      type: ECronEngineJobType.OneTime,
      pattern: undefined,
      reminderText: "Stand up and stretch.",
      reminderPromptData: undefined,
      reminderFallbackText: "Stand up and stretch.",
    });
  });

  test("rejects one-time schedule fields for recurring reminders", async () => {
    const chatId = "runtime-update-invalid-user";

    await executeToolCall({
      toolCall: createToolCall(
        "schedule-cron",
        SCHEDULE_RECURRING_TOOL,
        JSON.stringify({
          name: "drink-water",
          pattern: "0 9 * * *",
          reminderText: "Drink water.",
        }),
      ),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    const updateResult = await executeToolCall({
      toolCall: createToolCall(
        "update-cron",
        UPDATE_CRON_JOB_TOOL,
        JSON.stringify({
          name: "drink-water",
          fireAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(updateResult.success).toBe(false);
    expect(updateResult.error).toContain("fireAt can only update one-time reminders");
  });
});
