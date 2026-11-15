import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cronEngineJobsTable,
  ECronJobStatus,
  ECronJobType,
  EEventType,
  eventsTable,
} from "@bellaclaw/database";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { resetCronEngineJobsTable, resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import type { TCronFiredPayload } from "../events/catalog";
import { CronScheduler } from "./index";
import { createOnce, createRecurring } from "./test-utils";

type TSchedulerInternals = {
  fire: (id: number) => Promise<void>;
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

async function firedPayload(name: string) {
  const rows = await DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, EEventType.CronFired));

  return rows
    .map((row) => row.payload as TCronFiredPayload)
    .find((payload) => payload.name === name);
}

async function forceJobNextRunAt(id: number, nextRunAt: Date) {
  const db = DatabaseConnector.instance.database;

  await db.update(cronEngineJobsTable).set({ nextRunAt }).where(eq(cronEngineJobsTable.id, id));
}

async function insertRecurringJobWithoutTimezone() {
  const db = DatabaseConnector.instance.database;

  const row = await db
    .insert(cronEngineJobsTable)
    .values({
      name: "default-tz-recurring",
      scope: "scope-a",
      type: ECronJobType.Recurring,
      pattern: "0 9 * * *",
      contentKind: "text",
      contentBody: "Hi.",
      nextRunAt: new Date(Date.now() - 1_000),
      lastRunAt: null,
      createdAt: new Date(),
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
    await resetEventTables();
    Object.assign(EventBus, { _instance: undefined });
    scheduler = new CronScheduler({});
    scheduler.subscribe();
    await EventBus.instance.start();
  });

  afterEach(async () => {
    scheduler.destroy();
    await EventBus.instance.idle();
    await EventBus.instance.stop();
  });

  test("recurring job scheduled with explicit timezone stores it and uses it for first run", async () => {
    await createRecurring({
      name: "tz-recurring",
      scope: "scope-a",
      pattern: "0 9 * * *",
      timezone: "America/New_York",
      content: { kind: "text", text: "Hi." },
    });

    const job = await scheduler.get("tz-recurring", "scope-a");

    if (!job) {
      throw new Error("Expected scheduled job");
    }

    expect(job.timezone).toBe("America/New_York");
    expect(formatWall(job.nextRunAt, "America/New_York")).toMatch(/ 09:00:00$/);
  });

  test("recurring fire recomputes next run using stored timezone", async () => {
    const result = await createRecurring({
      name: "tz-recurring-fire",
      scope: "scope-a",
      pattern: "0 9 * * *",
      timezone: "America/New_York",
      content: { kind: "text", text: "Hi." },
    });

    const fireAt = new Date(Date.now() - 60_000);
    await forceJobNextRunAt(result.id, fireAt);

    await fireJob(scheduler, result.id);

    const ctx = await firedPayload("tz-recurring-fire");
    expect(ctx?.timezone).toBe("America/New_York");

    const job = await scheduler.get("tz-recurring-fire", "scope-a");

    if (!job) {
      throw new Error("Expected job after fire");
    }

    expect(job.timezone).toBe("America/New_York");
    expect(formatWall(job.nextRunAt, "America/New_York")).toMatch(/ 09:00:00$/);
    expect(ctx?.nextRunAt).toBe(fireAt.getTime());
  });

  test("rows with null timezone fire using scheduler default timezone", async () => {
    const tzScheduler = new CronScheduler({ timezone: "Europe/Warsaw" });

    try {
      const id = await insertRecurringJobWithoutTimezone();

      await fireJob(tzScheduler, id);

      const ctx = await firedPayload("default-tz-recurring");
      expect(ctx?.timezone).toBe("Europe/Warsaw");

      const job = await tzScheduler.get("default-tz-recurring", "scope-a");

      if (!job) {
        throw new Error("Expected job after fire");
      }

      expect(job.timezone).toBeNull();
      expect(formatWall(job.nextRunAt, "Europe/Warsaw")).toMatch(/ 09:00:00$/);
      expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      tzScheduler.destroy();
    }
  });

  test("one-time job scheduled with timezone stores it and keeps fireAt absolute", async () => {
    const fireAt = new Date(Date.now() + 60_000);
    await createOnce({
      name: "tz-onetime",
      scope: "scope-a",
      fireAt,
      timezone: "America/New_York",
      content: { kind: "text", text: "Hi." },
    });

    const job = await scheduler.get("tz-onetime", "scope-a");

    if (!job) {
      throw new Error("Expected scheduled one-time job");
    }

    expect(job.timezone).toBe("America/New_York");
    expect(job.nextRunAt.getTime()).toBe(fireAt.getTime());
  });

  test("recurring job scheduled without timezone preserves existing local behavior", async () => {
    await createRecurring({
      name: "no-tz-recurring",
      scope: "scope-a",
      pattern: "*/5 * * * *",
      content: { kind: "text", text: "Hi." },
    });

    const job = await scheduler.get("no-tz-recurring", "scope-a");

    if (!job) {
      throw new Error("Expected scheduled job");
    }

    expect(job.timezone).toBeNull();
    expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });
});
