import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { DatabaseConnector } from "../../services/database";
import { cronEngineJobsTable } from "../../services/database/schema";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import { CronEngine, ECronEngineJobStatus, ECronEngineJobType } from "./index";

type TEngineWithInternals = {
  tick: () => Promise<void>;
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

async function forceJobDue(name: string, scope: string) {
  const db = DatabaseConnector.instance.database;

  await db
    .update(cronEngineJobsTable)
    .set({ nextRunAt: Date.now() - 1_000 })
    .where(
      and(
        eq(cronEngineJobsTable.name, name),
        eq(cronEngineJobsTable.scope, scope),
        eq(cronEngineJobsTable.status, ECronEngineJobStatus.Active),
      ),
    );
}

async function insertLegacyRecurringJob() {
  const db = DatabaseConnector.instance.database;

  await db.insert(cronEngineJobsTable).values({
    name: "legacy-recurring",
    scope: "scope-a",
    group: null,
    type: ECronEngineJobType.Recurring,
    pattern: "0 9 * * *",
    reminderText: null,
    reminderPromptData: null,
    reminderFallbackText: null,
    nextRunAt: Date.now() - 1_000,
    lastRunAt: null,
    createdAt: Date.now(),
    status: ECronEngineJobStatus.Active,
    finishedAt: null,
    finishedReason: null,
  });
}

describe("CronEngine per-job timezone", () => {
  let engine: CronEngine;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    engine = new CronEngine({});
  });

  afterEach(() => {
    engine.destroy();
  });

  test("recurring job scheduled with explicit timezone stores it and uses it for first run", async () => {
    const result = await engine.schedule({
      name: "tz-recurring",
      scope: "scope-a",
      pattern: "0 9 * * *",
      timezone: "America/New_York",
      reminderText: "Hi.",
    });

    expect("error" in result).toBe(false);

    const job = await engine.getJob("tz-recurring", "scope-a");

    if (!job) {
      throw new Error("Expected scheduled job");
    }

    expect(job.timezone).toBe("America/New_York");
    expect(formatWall(job.nextRunAt, "America/New_York")).toMatch(/ 09:00:00$/);
  });

  test("recurring tick recomputes next run using stored timezone", async () => {
    const result = await engine.schedule({
      name: "tz-recurring-tick",
      scope: "scope-a",
      pattern: "0 9 * * *",
      timezone: "America/New_York",
      reminderText: "Hi.",
    });
    expect("error" in result).toBe(false);

    await forceJobDue("tz-recurring-tick", "scope-a");

    const fired = new Promise<TFiredContext>((resolve) => {
      engine.onFire((ctx) => {
        if (ctx.name === "tz-recurring-tick") {
          resolve({ timezone: ctx.timezone, nextRunAt: ctx.nextRunAt });
        }
      });
    });

    const internals = engine as unknown as TEngineWithInternals;
    await internals.tick();

    const ctx = await fired;
    expect(ctx.timezone).toBe("America/New_York");

    const job = await engine.getJob("tz-recurring-tick", "scope-a");

    if (!job) {
      throw new Error("Expected job after tick");
    }

    expect(job.timezone).toBe("America/New_York");
    expect(formatWall(job.nextRunAt, "America/New_York")).toMatch(/ 09:00:00$/);
    expect(job.nextRunAt.getTime() > Date.now()).toBe(true);
  });

  test("existing rows with null timezone still fire using engine default timezone", async () => {
    const tzEngine = new CronEngine({ timezone: "Europe/Warsaw" });

    try {
      await insertLegacyRecurringJob();

      const fired = new Promise<TFiredContext>((resolve) => {
        tzEngine.onFire((ctx) => {
          if (ctx.name === "legacy-recurring") {
            resolve({ timezone: ctx.timezone, nextRunAt: ctx.nextRunAt });
          }
        });
      });

      const internals = tzEngine as unknown as TEngineWithInternals;
      await internals.tick();

      const ctx = await fired;
      expect(ctx.timezone).toBe("Europe/Warsaw");

      const job = await tzEngine.getJob("legacy-recurring", "scope-a");

      if (!job) {
        throw new Error("Expected job after tick");
      }

      expect(job.timezone).toBeUndefined();
      expect(formatWall(job.nextRunAt, "Europe/Warsaw")).toMatch(/ 09:00:00$/);
      expect(job.nextRunAt.getTime() > Date.now()).toBe(true);
    } finally {
      tzEngine.destroy();
    }
  });

  test("one-time job scheduled with timezone stores it and keeps fireAt absolute", async () => {
    const fireAt = new Date(Date.now() + 60_000);
    const result = await engine.scheduleOnce({
      name: "tz-onetime",
      scope: "scope-a",
      fireAt,
      timezone: "America/New_York",
      reminderText: "Hi.",
    });

    expect("error" in result).toBe(false);

    const job = await engine.getJob("tz-onetime", "scope-a");

    if (!job) {
      throw new Error("Expected scheduled one-time job");
    }

    expect(job.timezone).toBe("America/New_York");
    expect(job.nextRunAt.getTime()).toBe(fireAt.getTime());
  });

  test("recurring job scheduled without timezone preserves existing local behavior", async () => {
    const result = await engine.schedule({
      name: "no-tz-recurring",
      scope: "scope-a",
      pattern: "*/5 * * * *",
      reminderText: "Hi.",
    });

    expect("error" in result).toBe(false);

    const job = await engine.getJob("no-tz-recurring", "scope-a");

    if (!job) {
      throw new Error("Expected scheduled job");
    }

    expect(job.timezone).toBeUndefined();
    expect(job.nextRunAt.getTime() > Date.now()).toBe(true);
  });
});
