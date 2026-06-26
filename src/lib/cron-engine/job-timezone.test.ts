import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../../services/database";
import { cronEngineJobsTable } from "../../services/database/schema";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import { CronScheduler, ECronJobStatus, ECronJobType } from "./index";

type TSchedulerInternals = {
  fire: (id: number) => Promise<void>;
};

type TFiredContext = {
  timezone: string | undefined;
  nextRunAt: Date;
};

function formatWall(date: Date, timezone: string) {
  return date.toLocaleString("sv-SE-u-nu-latn", {
    timeZone: timezone,
    hourCycle: "h23",
  });
}

async function fireJob(scheduler: CronScheduler, id: number) {
  const internals = scheduler as unknown as TSchedulerInternals;
  await internals.fire(id);
}

async function forceJobNextRunAt(id: number, nextRunAt: Date) {
  const db = DatabaseConnector.instance.database;

  await db
    .update(cronEngineJobsTable)
    .set({ nextRunAt: nextRunAt.getTime() })
    .where(eq(cronEngineJobsTable.id, id));
}

async function insertLegacyRecurringJob() {
  const db = DatabaseConnector.instance.database;

  const row = await db
    .insert(cronEngineJobsTable)
    .values({
      name: "legacy-recurring",
      scope: "scope-a",
      group: null,
      type: ECronJobType.Recurring,
      pattern: "0 9 * * *",
      reminderText: null,
      reminderPromptData: null,
      reminderFallbackText: null,
      nextRunAt: Date.now() - 1_000,
      lastRunAt: null,
      createdAt: Date.now(),
      status: ECronJobStatus.Active,
      finishedAt: null,
      finishedReason: null,
    })
    .returning()
    .get();

  return row.id;
}

describe("CronScheduler per-job timezone", () => {
  let scheduler: CronScheduler;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    scheduler = new CronScheduler({});
  });

  afterEach(() => {
    scheduler.destroy();
  });

  test("recurring job scheduled with explicit timezone stores it and uses it for first run", async () => {
    const result = await scheduler.createRecurring({
      name: "tz-recurring",
      scope: "scope-a",
      pattern: "0 9 * * *",
      timezone: "America/New_York",
      reminderText: "Hi.",
    });

    expect("error" in result).toBe(false);

    const job = await scheduler.get("tz-recurring", "scope-a");

    if (!job) {
      throw new Error("Expected scheduled job");
    }

    expect(job.timezone).toBe("America/New_York");
    expect(formatWall(job.nextRunAt, "America/New_York")).toMatch(/ 09:00:00$/);
  });

  test("recurring fire recomputes next run using stored timezone", async () => {
    const result = await scheduler.createRecurring({
      name: "tz-recurring-fire",
      scope: "scope-a",
      pattern: "0 9 * * *",
      timezone: "America/New_York",
      reminderText: "Hi.",
    });

    if ("error" in result) {
      throw new Error(String(result.error));
    }
    await forceJobNextRunAt(result.id, new Date(Date.now() - 60_000));

    const fired = new Promise<TFiredContext>((resolve) => {
      scheduler.onFire((ctx) => {
        if (ctx.name === "tz-recurring-fire") {
          resolve({ timezone: ctx.timezone, nextRunAt: ctx.nextRunAt });
        }
      });
    });

    await fireJob(scheduler, result.id);

    const ctx = await fired;
    expect(ctx.timezone).toBe("America/New_York");

    const job = await scheduler.get("tz-recurring-fire", "scope-a");

    if (!job) {
      throw new Error("Expected job after fire");
    }

    expect(job.timezone).toBe("America/New_York");
    expect(formatWall(job.nextRunAt, "America/New_York")).toMatch(/ 09:00:00$/);
    expect(job.nextRunAt.getTime()).toBeGreaterThan(ctx.nextRunAt.getTime());
  });

  test("existing rows with null timezone still fire using scheduler default timezone", async () => {
    const tzScheduler = new CronScheduler({ timezone: "Europe/Warsaw" });

    try {
      const id = await insertLegacyRecurringJob();

      const fired = new Promise<TFiredContext>((resolve) => {
        tzScheduler.onFire((ctx) => {
          if (ctx.name === "legacy-recurring") {
            resolve({ timezone: ctx.timezone, nextRunAt: ctx.nextRunAt });
          }
        });
      });

      await fireJob(tzScheduler, id);

      const ctx = await fired;
      expect(ctx.timezone).toBe("Europe/Warsaw");

      const job = await tzScheduler.get("legacy-recurring", "scope-a");

      if (!job) {
        throw new Error("Expected job after fire");
      }

      expect(job.timezone).toBeUndefined();
      expect(formatWall(job.nextRunAt, "Europe/Warsaw")).toMatch(/ 09:00:00$/);
      expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      tzScheduler.destroy();
    }
  });

  test("one-time job scheduled with timezone stores it and keeps fireAt absolute", async () => {
    const fireAt = new Date(Date.now() + 60_000);
    const result = await scheduler.createOnce({
      name: "tz-onetime",
      scope: "scope-a",
      fireAt,
      timezone: "America/New_York",
      reminderText: "Hi.",
    });

    expect("error" in result).toBe(false);

    const job = await scheduler.get("tz-onetime", "scope-a");

    if (!job) {
      throw new Error("Expected scheduled one-time job");
    }

    expect(job.timezone).toBe("America/New_York");
    expect(job.nextRunAt.getTime()).toBe(fireAt.getTime());
  });

  test("recurring job scheduled without timezone preserves existing local behavior", async () => {
    const result = await scheduler.createRecurring({
      name: "no-tz-recurring",
      scope: "scope-a",
      pattern: "*/5 * * * *",
      reminderText: "Hi.",
    });

    expect("error" in result).toBe(false);

    const job = await scheduler.get("no-tz-recurring", "scope-a");

    if (!job) {
      throw new Error("Expected scheduled job");
    }

    expect(job.timezone).toBeUndefined();
    expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });
});
