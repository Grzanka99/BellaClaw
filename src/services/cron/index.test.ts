import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ECronJobType, type TCronJobContext } from "../../lib/cron-engine";
import { DatabaseConnector } from "../database";
import { cronEngineJobsTable } from "../database/schema";
import { resetCronEngineJobsTable } from "../database/test-utils";
import { CronSingleton } from "./index";

type TCronSingletonInternals = {
  scheduler: {
    fire: (id: number) => Promise<void>;
  };
};

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

function cleanupCronSingleton() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
}

async function forceJobNextRunAt(id: number, nextRunAt: Date) {
  const db = DatabaseConnector.instance.database;

  await db
    .update(cronEngineJobsTable)
    .set({ nextRunAt: nextRunAt.getTime() })
    .where(eq(cronEngineJobsTable.id, id));
}

describe("CronSingleton", () => {
  beforeEach(async () => {
    cleanupCronSingleton();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    cleanupCronSingleton();
  });

  test("keeps jobs isolated per user and preserves service fields", async () => {
    const cron = CronSingleton.instance;

    const first = await cron.createRecurring({
      name: "shared-name",
      scope: "user-a",
      pattern: "0 9 * * *",
      group: "alerts",
      reminderText: "Take medicine.",
    });
    const second = await cron.createRecurring({
      name: "shared-name",
      scope: "user-b",
      pattern: "0 10 * * *",
    });

    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);

    const userAJob = await cron.get("shared-name", "user-a");
    const userBJob = await cron.get("shared-name", "user-b");
    const userAJobs = await cron.list("user-a");

    expect(userAJob).toMatchObject({
      name: "shared-name",
      scope: "user-a",
      group: "alerts",
      type: ECronJobType.Recurring,
      pattern: "0 9 * * *",
      reminderText: "Take medicine.",
      reminderFallbackText: "Take medicine.",
    });
    expect(userBJob).toMatchObject({
      name: "shared-name",
      scope: "user-b",
      group: undefined,
      type: ECronJobType.Recurring,
      pattern: "0 10 * * *",
      reminderText: undefined,
      reminderPromptData: undefined,
      reminderFallbackText: undefined,
    });
    expect(userAJobs).toHaveLength(1);
  });

  test("rejects duplicate job names inside same user", async () => {
    const cron = CronSingleton.instance;

    const first = await cron.createRecurring({
      name: "duplicate-job",
      scope: "user-a",
      pattern: "0 9 * * *",
    });
    const duplicate = await cron.createRecurring({
      name: "duplicate-job",
      scope: "user-a",
      pattern: "0 10 * * *",
    });

    expect("error" in first).toBe(false);
    expect("error" in duplicate).toBe(true);

    if ("error" in duplicate) {
      expect(String(duplicate.error)).toContain("already exists");
    }
  });

  test("overwrites recurring job with updated fields", async () => {
    const cron = CronSingleton.instance;

    const first = await cron.createRecurring({
      name: "overwrite-job",
      scope: "user-a",
      pattern: "0 9 * * *",
      group: "alerts",
      reminderText: "First reminder.",
    });
    const overwritten = await cron.createRecurring({
      name: "overwrite-job",
      scope: "user-a",
      pattern: "0 10 * * *",
      group: "reminders",
      reminderPromptData: '{"topic":"hydration"}',
      reminderFallbackText: "Drink water.",
      overwrite: true,
    });

    expect("error" in first).toBe(false);
    expect("error" in overwritten).toBe(false);

    const job = await cron.get("overwrite-job", "user-a");

    expect(job).toMatchObject({
      name: "overwrite-job",
      scope: "user-a",
      pattern: "0 10 * * *",
      group: "reminders",
      type: ECronJobType.Recurring,
      reminderText: undefined,
      reminderPromptData: '{"topic":"hydration"}',
      reminderFallbackText: "Drink water.",
    });
  });

  test("fires one-time jobs with mapped context and deactivates them", async () => {
    const cron = CronSingleton.instance;
    const internals = cron as unknown as TCronSingletonInternals;

    const scheduled = await cron.createOnce({
      name: "one-time-job",
      scope: "user-a",
      fireAt: new Date(Date.now() + 60_000),
      group: "timers",
      reminderText: "Stretch now.",
    });

    expect("error" in scheduled).toBe(false);
    if ("error" in scheduled) {
      throw new Error(String(scheduled.error));
    }
    await forceJobNextRunAt(scheduled.id, new Date(Date.now() - 1_000));

    const fired = new Promise<TCronJobContext>((resolve) => {
      cron.on("one-time-job", (ctx) => {
        resolve(ctx);
      });
    });

    await internals.scheduler.fire(scheduled.id);

    const ctx = await fired;
    const remainingJob = await cron.get("one-time-job", "user-a");

    expect(ctx).toMatchObject({
      name: "one-time-job",
      scope: "user-a",
      group: "timers",
      type: ECronJobType.OneTime,
      pattern: undefined,
      reminderText: "Stretch now.",
      reminderPromptData: undefined,
      reminderFallbackText: "Stretch now.",
    });
    expect(ctx.lastRunAt).toBeInstanceOf(Date);
    expect(ctx.nextRunAt).toBeInstanceOf(Date);
    expect(remainingJob).toBeUndefined();
  });

  test("fires recurring jobs with mapped context and keeps them scheduled", async () => {
    const cron = CronSingleton.instance;
    const internals = cron as unknown as TCronSingletonInternals;

    const scheduled = await cron.createRecurring({
      name: "recurring-job",
      scope: "user-a",
      pattern: "*/5 * * * *",
      group: "alerts",
      reminderPromptData: '{"topic":"posture"}',
      reminderFallbackText: "Posture check.",
    });

    expect("error" in scheduled).toBe(false);
    if ("error" in scheduled) {
      throw new Error(String(scheduled.error));
    }
    await forceJobNextRunAt(scheduled.id, new Date(Date.now() - 60_000));

    const fired = new Promise<TCronJobContext>((resolve) => {
      cron.on("recurring-job", (ctx) => {
        resolve(ctx);
      });
    });

    await internals.scheduler.fire(scheduled.id);

    const ctx = await fired;
    const job = await cron.get("recurring-job", "user-a");

    if (!job) {
      throw new Error("Expected recurring job after fire");
    }

    expect(ctx).toMatchObject({
      name: "recurring-job",
      scope: "user-a",
      group: "alerts",
      type: ECronJobType.Recurring,
      pattern: "*/5 * * * *",
      reminderText: undefined,
      reminderPromptData: '{"topic":"posture"}',
      reminderFallbackText: "Posture check.",
    });
    expect(job).toMatchObject({
      name: "recurring-job",
      scope: "user-a",
      group: "alerts",
      type: ECronJobType.Recurring,
      pattern: "*/5 * * * *",
      reminderText: undefined,
      reminderPromptData: '{"topic":"posture"}',
      reminderFallbackText: "Posture check.",
    });
    expect(ctx.lastRunAt).toBeInstanceOf(Date);
    expect(job.nextRunAt).toBeInstanceOf(Date);
    expect(ctx.lastRunAt?.getTime()).toBe(job.lastRunAt?.getTime());
    expect(ctx.nextRunAt.getTime()).toBe(job.nextRunAt.getTime());
    expect(job.nextRunAt.getTime() > Date.now()).toBe(true);
  });

  test("generic cron event does not collide with job named cron-event", async () => {
    const cron = CronSingleton.instance;
    const internals = cron as unknown as TCronSingletonInternals;

    const scheduled = await cron.createRecurring({
      name: "cron-event",
      scope: "user-a",
      pattern: "0 9 * * *",
      reminderText: "Test.",
    });

    expect("error" in scheduled).toBe(false);
    if ("error" in scheduled) {
      throw new Error(String(scheduled.error));
    }
    await forceJobNextRunAt(scheduled.id, new Date(Date.now() - 60_000));

    const namedEvents: TCronJobContext[] = [];
    const cronEvents: TCronJobContext[] = [];

    cron.on("cron-event", (ctx) => {
      namedEvents.push(ctx);
    });
    cron.onCronEvent((ctx) => {
      cronEvents.push(ctx);
    });

    await internals.scheduler.fire(scheduled.id);

    expect(namedEvents).toHaveLength(1);
    expect(cronEvents).toHaveLength(1);
    expect(namedEvents[0]?.name).toBe("cron-event");
    expect(cronEvents[0]?.name).toBe("cron-event");
    expect(cronEvents[0]?.scope).toBe("user-a");
  });
});
