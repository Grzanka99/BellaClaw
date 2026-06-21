import { describe, expect, test } from "bun:test";
import {
  ECronEngineJobStatus,
  ECronEngineJobType,
  type TCronEngineJob,
} from "../../../lib/cron-engine";
import { serializeCronJobForModel } from "./tools/cron-serialization";

function createJob(overrides: Partial<TCronEngineJob> = {}): TCronEngineJob {
  return {
    id: 1,
    name: "tz-job",
    scope: undefined,
    group: undefined,
    type: ECronEngineJobType.Recurring,
    pattern: "0 9 * * *",
    nextRunAt: new Date("2026-01-05T08:00:00.000Z"),
    lastRunAt: undefined,
    createdAt: new Date("2026-01-01T08:00:00.000Z"),
    status: ECronEngineJobStatus.Active,
    finishedAt: undefined,
    finishedReason: undefined,
    reminderText: undefined,
    reminderPromptData: undefined,
    reminderFallbackText: undefined,
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
    const serialized = serializeCronJobForModel(job, "Asia/Tokyo");

    expect(serialized.timezone).toBe("America/New_York");
    expect(serialized.nextRunAtLocal).toBe(formatLocalDateTime(job.nextRunAt, "America/New_York"));
    expect(serialized.createdAtLocal).toBe(formatLocalDateTime(job.createdAt, "America/New_York"));
    expect(serialized.lastRunAtLocal).toBeUndefined();
  });

  test("falls back to owner timezone when job has no timezone", () => {
    const job = createJob({ timezone: undefined });
    const ownerTimezone = "Asia/Tokyo";
    const serialized = serializeCronJobForModel(job, ownerTimezone);

    expect(serialized.timezone).toBe(ownerTimezone);
    expect(serialized.nextRunAtLocal).toBe(formatLocalDateTime(job.nextRunAt, ownerTimezone));
  });
});
