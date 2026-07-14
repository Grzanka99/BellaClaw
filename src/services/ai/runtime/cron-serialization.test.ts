import { describe, expect, test } from "bun:test";
import { Config } from "../../../config";
import { ECronJobStatus, ECronJobType, type TCronJob } from "../../../lib/cron-engine";
import { serializeCronJobForModel } from "./tools/cron-serialization";

function createJob(overrides: Partial<TCronJob> = {}): TCronJob {
  return {
    id: 1,
    name: "tz-job",
    scope: undefined,
    group: undefined,
    type: ECronJobType.Recurring,
    pattern: "0 9 * * *",
    nextRunAt: new Date("2026-01-05T08:00:00.000Z"),
    lastRunAt: undefined,
    createdAt: new Date("2026-01-01T08:00:00.000Z"),
    status: ECronJobStatus.Active,
    finishedAt: undefined,
    finishedReason: undefined,
    reminderText: undefined,
    reminderPromptData: undefined,
    reminderFallbackText: undefined,
    taskPrompt: undefined,
    taskFallbackText: undefined,
    timezone: undefined,
    ...overrides,
  };
}

function formatLocalDateTime(date: Date, timezone: string) {
  return date.toLocaleString("sv-SE-u-nu-latn", {
    timeZone: timezone,
    hourCycle: "h23",
  });
}

describe("serializeCronJobForModel", () => {
  test("uses stored job timezone for local display fields when present", () => {
    const job = createJob({ timezone: "America/New_York" });
    const serialized = serializeCronJobForModel(job);

    expect(serialized.timezone).toBe("America/New_York");
    expect(serialized.nextRunAtLocal).toBe(formatLocalDateTime(job.nextRunAt, "America/New_York"));
    expect(serialized.createdAtLocal).toBe(formatLocalDateTime(job.createdAt, "America/New_York"));
    expect(serialized.lastRunAtLocal).toBeUndefined();
  });

  test("falls back to global config timezone when job has no timezone", () => {
    const job = createJob({ timezone: undefined });
    const serialized = serializeCronJobForModel(job);

    expect(serialized.timezone).toBe(Config.ai.instructions.timezone);
    expect(serialized.nextRunAtLocal).toBe(
      formatLocalDateTime(job.nextRunAt, Config.ai.instructions.timezone),
    );
  });

  test("preserves task content and identifies scheduled tasks", () => {
    const serialized = serializeCronJobForModel(
      createJob({
        taskPrompt: "Private task prompt.",
        taskFallbackText: "Private task fallback.",
      }),
    );

    expect(serialized.contentMode).toBe("scheduled-task");
    expect(serialized.taskPromptChars).toBe(20);
    expect(serialized.taskFallbackTextChars).toBe(22);
    expect(serialized.taskPrompt).toBe("Private task prompt.");
    expect(serialized.taskFallbackText).toBe("Private task fallback.");
  });
});
