import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { Config } from "../../../config";
import { CronSingleton } from "../../cron";
import { resetCronEngineJobsTable } from "../../database/test-utils";
import { LIST_CRON_JOBS_TOOL } from "../tools/list-cron-jobs/definition";
import { SCHEDULE_RECURRING_TOOL } from "../tools/schedule-recurring/definition";
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

function formatLocalDateTime(date: Date) {
  return date.toLocaleString("sv-SE-u-nu-latn", {
    timeZone: Config.ai.instructions.timezone,
    hourCycle: "h23",
  });
}

function formatLocalTime(date: Date) {
  return date.toLocaleTimeString("sv-SE-u-nu-latn", {
    timeZone: Config.ai.instructions.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

describe("cron tool result formatting", () => {
  beforeEach(async () => {
    cleanupCronSingleton();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    cleanupCronSingleton();
  });

  test("adds explicit local time fields to cron tool results", async () => {
    const chatId = "runtime-cron-user";
    const scheduleResult = await executeToolCall({
      toolCall: createToolCall(
        "schedule-cron",
        SCHEDULE_RECURRING_TOOL,
        JSON.stringify({
          name: "drink-water",
          pattern: "*/5 * * * *",
          reminderText: "Drink water.",
        }),
      ),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, LIST_CRON_JOBS_TOOL]),
    });
    const listResult = await executeToolCall({
      toolCall: createToolCall("list-cron", LIST_CRON_JOBS_TOOL, "{}"),
      chatId,
      allowedToolNames: new Set([SCHEDULE_RECURRING_TOOL, LIST_CRON_JOBS_TOOL]),
    });

    expect(scheduleResult.success).toBe(true);
    expect(listResult.success).toBe(true);

    const scheduledJob = scheduleResult.data as {
      timezone: string;
      nextRunAt: Date;
      nextRunAtLocal: string;
      nextRunAtLocalTime: string;
      createdAt: Date;
      createdAtLocal: string;
      lastRunAtLocal?: string;
    };
    const listedJobs = listResult.data as Array<{
      timezone: string;
      nextRunAt: Date;
      nextRunAtLocal: string;
      nextRunAtLocalTime: string;
      createdAt: Date;
      createdAtLocal: string;
      lastRunAtLocal?: string;
    }>;

    expect(scheduledJob.timezone).toBe(Config.ai.instructions.timezone);
    expect(scheduledJob.nextRunAtLocal).toBe(formatLocalDateTime(scheduledJob.nextRunAt));
    expect(scheduledJob.nextRunAtLocalTime).toBe(formatLocalTime(scheduledJob.nextRunAt));
    expect(scheduledJob.createdAtLocal).toBe(formatLocalDateTime(scheduledJob.createdAt));
    expect(scheduledJob.lastRunAtLocal).toBeUndefined();

    expect(listedJobs).toHaveLength(1);
    const listedJob = listedJobs[0];

    if (listedJob === undefined) {
      throw new Error("Expected one listed cron job");
    }

    expect(listedJob.timezone).toBe(Config.ai.instructions.timezone);
    expect(listedJob.nextRunAtLocal).toBe(formatLocalDateTime(listedJob.nextRunAt));
    expect(listedJob.nextRunAtLocalTime).toBe(formatLocalTime(listedJob.nextRunAt));
  });
});
