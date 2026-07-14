import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Config } from "../../../config";
import { ECronJobStatus, ECronJobType } from "../../../lib/cron-engine";
import type { AsyncQueue } from "../../../utils/async-queue";
import { CronSingleton } from "../../cron";
import { DatabaseConnector } from "../../database";
import { cronEngineJobsTable } from "../../database/schema";
import { resetCronEngineJobsTable } from "../../database/test-utils";
import { DefaultConfigRecord, EConfigKey } from "../../settings/schema";
import { SCHEDULE_ONCE_TOOL } from "../tools/schedule-once/definition";
import { SCHEDULE_RECURRING_TOOL } from "../tools/schedule-recurring/definition";
import { UPDATE_CRON_JOB_TOOL } from "../tools/update-cron-job/definition";
import type { TToolCall } from "../types";
import { executeToolCall } from "./tool-execution";

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

type TCronSingletonInternals = {
  queue: AsyncQueue;
};

function cleanupCronSingleton() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
}

function createToolCall(id: string, name: string, toolArguments: unknown): TToolCall {
  return {
    id,
    name,
    arguments: toolArguments,
  };
}

async function insertLegacyRecurringJob(name: string, scope: string) {
  const internals = CronSingleton.instance as unknown as TCronSingletonInternals;
  const db = DatabaseConnector.instance.database;
  const now = Date.now();

  await internals.queue.enqueue(async () => {
    await db.insert(cronEngineJobsTable).values({
      name,
      scope,
      group: null,
      type: ECronJobType.Recurring,
      pattern: "0 9 * * *",
      reminderText: "Legacy reminder.",
      reminderPromptData: null,
      reminderFallbackText: "Legacy reminder.",
      nextRunAt: now + 60_000,
      lastRunAt: null,
      createdAt: now,
      status: ECronJobStatus.Active,
      finishedAt: null,
      finishedReason: null,
      timezone: null,
    });
  });
}

async function insertLegacyOneTimeJob(name: string, scope: string, fireAt: Date) {
  const internals = CronSingleton.instance as unknown as TCronSingletonInternals;
  const db = DatabaseConnector.instance.database;
  const now = Date.now();

  await internals.queue.enqueue(async () => {
    await db.insert(cronEngineJobsTable).values({
      name,
      scope,
      group: null,
      type: ECronJobType.OneTime,
      pattern: null,
      reminderText: "Legacy one-time reminder.",
      reminderPromptData: null,
      reminderFallbackText: "Legacy one-time reminder.",
      nextRunAt: fireAt.getTime(),
      lastRunAt: null,
      createdAt: now,
      status: ECronJobStatus.Active,
      finishedAt: null,
      finishedReason: null,
      timezone: null,
    });
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
      toolCall: createToolCall("schedule-cron", SCHEDULE_RECURRING_TOOL, {
        name: "drink-water",
        pattern: "0 9 * * *",
        group: "health",
        reminderText: "Drink water.",
      }),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    const updateResult = await executeToolCall({
      toolCall: createToolCall("update-cron", UPDATE_CRON_JOB_TOOL, {
        name: "drink-water",
        pattern: "0 10 * * *",
      }),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.data).toMatchObject({
      name: "drink-water",
      scope: chatId,
      group: "health",
      type: ECronJobType.Recurring,
      pattern: "0 10 * * *",
      reminderText: "Drink water.",
      reminderFallbackText: "Drink water.",
    });
  });

  test("updates recurring reminder and preserves existing timezone", async () => {
    const chatId = "runtime-update-recurring-timezone-user";

    const scheduled = await CronSingleton.instance.createRecurring({
      name: "timezone-reminder",
      scope: chatId,
      pattern: "0 9 * * *",
      timezone: "America/New_York",
      reminderText: "Timezone reminder.",
    });

    expect("error" in scheduled).toBe(false);

    const updateResult = await executeToolCall({
      toolCall: createToolCall("update-cron-timezone", UPDATE_CRON_JOB_TOOL, {
        name: "timezone-reminder",
        pattern: "0 10 * * *",
      }),
      chatId,
      allowedToolNames: new Set([UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.data).toMatchObject({
      name: "timezone-reminder",
      timezone: "America/New_York",
    });

    const updatedJob = await CronSingleton.instance.get("timezone-reminder", chatId);

    expect(updatedJob?.timezone).toBe("America/New_York");
  });

  test("updates legacy recurring reminder and preserves engine timezone fallback", async () => {
    const chatId = "runtime-update-legacy-timezone-user";
    const settings = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsTimezone]: "Asia/Tokyo",
    };

    await insertLegacyRecurringJob("legacy-timezone-reminder", chatId);

    const updateResult = await executeToolCall({
      toolCall: createToolCall("update-legacy-timezone", UPDATE_CRON_JOB_TOOL, {
        name: "legacy-timezone-reminder",
        pattern: "0 10 * * *",
      }),
      chatId,
      allowedToolNames: new Set([UPDATE_CRON_JOB_TOOL]),
      settings,
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.data).toMatchObject({
      name: "legacy-timezone-reminder",
      timezone: Config.ai.instructions.timezone,
    });

    const updatedJob = await CronSingleton.instance.get("legacy-timezone-reminder", chatId);

    expect(updatedJob?.timezone).toBe(Config.ai.instructions.timezone);
  });

  test("updates legacy one-time reminder and preserves engine timezone fallback", async () => {
    const chatId = "runtime-update-legacy-onetime-timezone-user";
    const fireAt = new Date(Date.now() + 60_000);
    const settings = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsTimezone]: "Asia/Tokyo",
    };

    await insertLegacyOneTimeJob("legacy-onetime-timezone-reminder", chatId, fireAt);

    const updateResult = await executeToolCall({
      toolCall: createToolCall("update-legacy-onetime-timezone", UPDATE_CRON_JOB_TOOL, {
        name: "legacy-onetime-timezone-reminder",
        reminderText: "Updated legacy one-time reminder.",
      }),
      chatId,
      allowedToolNames: new Set([UPDATE_CRON_JOB_TOOL]),
      settings,
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.data).toMatchObject({
      name: "legacy-onetime-timezone-reminder",
      timezone: Config.ai.instructions.timezone,
      reminderText: "Updated legacy one-time reminder.",
    });

    const updatedJob = await CronSingleton.instance.get("legacy-onetime-timezone-reminder", chatId);

    expect(updatedJob?.timezone).toBe(Config.ai.instructions.timezone);
    expect(updatedJob?.nextRunAt.getTime()).toBe(fireAt.getTime());
  });

  test("updates one-time reminder text and preserves fire time", async () => {
    const chatId = "runtime-update-once-user";
    const fireAt = new Date(Date.now() + 60_000).toISOString();

    await executeToolCall({
      toolCall: createToolCall("schedule-once", SCHEDULE_ONCE_TOOL, {
        name: "stretch-once",
        fireAt,
        reminderPromptData: '{"topic":"stretching"}',
        reminderFallbackText: "Stretch now.",
      }),
      chatId,
      allowedToolNames: new Set([SCHEDULE_ONCE_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    const updateResult = await executeToolCall({
      toolCall: createToolCall("update-once", UPDATE_CRON_JOB_TOOL, {
        name: "stretch-once",
        reminderText: "Stand up and stretch.",
      }),
      chatId,
      allowedToolNames: new Set([SCHEDULE_ONCE_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.data).toMatchObject({
      name: "stretch-once",
      scope: chatId,
      type: ECronJobType.OneTime,
      pattern: undefined,
      reminderText: "Stand up and stretch.",
      reminderPromptData: undefined,
      reminderFallbackText: "Stand up and stretch.",
    });
  });

  test("switches content modes without preserving stale fields", async () => {
    const chatId = "runtime-update-task-user";

    await executeToolCall({
      toolCall: createToolCall("schedule-cron", SCHEDULE_RECURRING_TOOL, {
        name: "daily-news",
        pattern: "0 8 * * *",
        reminderText: "Old reminder.",
      }),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    const taskResult = await executeToolCall({
      toolCall: createToolCall("update-to-task", UPDATE_CRON_JOB_TOOL, {
        name: "daily-news",
        taskPrompt: "Find today's important news with source links.",
        taskFallbackText: "No briefing is available.",
      }),
      chatId,
      allowedToolNames: new Set([UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(taskResult.success).toBe(true);
    expect(taskResult.data).toMatchObject({
      contentMode: "scheduled-task",
      taskPrompt: "Find today's important news with source links.",
      taskFallbackText: "No briefing is available.",
    });

    const taskJob = await CronSingleton.instance.get("daily-news", chatId);

    expect(taskJob).toMatchObject({
      reminderText: undefined,
      reminderPromptData: undefined,
      reminderFallbackText: undefined,
      taskPrompt: "Find today's important news with source links.",
      taskFallbackText: "No briefing is available.",
    });

    const directResult = await executeToolCall({
      toolCall: createToolCall("update-to-direct", UPDATE_CRON_JOB_TOOL, {
        name: "daily-news",
        reminderText: "Check the news.",
      }),
      chatId,
      allowedToolNames: new Set([UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(directResult.success).toBe(true);
    expect(directResult.data).toMatchObject({
      contentMode: "direct-reminder",
    });

    const directJob = await CronSingleton.instance.get("daily-news", chatId);

    expect(directJob).toMatchObject({
      reminderText: "Check the news.",
      reminderPromptData: undefined,
      reminderFallbackText: "Check the news.",
      taskPrompt: undefined,
      taskFallbackText: undefined,
    });
  });

  test("rejects one-time schedule fields for recurring reminders", async () => {
    const chatId = "runtime-update-invalid-user";

    await executeToolCall({
      toolCall: createToolCall("schedule-cron", SCHEDULE_RECURRING_TOOL, {
        name: "drink-water",
        pattern: "0 9 * * *",
        reminderText: "Drink water.",
      }),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    const updateResult = await executeToolCall({
      toolCall: createToolCall("update-cron", UPDATE_CRON_JOB_TOOL, {
        name: "drink-water",
        fireAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, UPDATE_CRON_JOB_TOOL]),
      settings: DefaultConfigRecord,
    });

    expect(updateResult.success).toBe(false);
    expect(updateResult.error).toContain("fireAt can only update one-time reminders");
  });
});
