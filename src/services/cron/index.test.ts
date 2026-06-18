import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { ECronEngineJobType, type TCronEngineJobContext } from "../../lib/cron-engine";
import { DatabaseConnector } from "../database";
import { cronEngineJobsTable } from "../database/schema";
import { resetCronEngineJobsTable } from "../database/test-utils";
import { CronSingleton } from "./index";

type TCronSingletonInternals = {
  engine: {
    tick: () => Promise<void>;
  };
};

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

function cleanupCronSingleton() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
}

async function forceJobDue(name: string, scope: string) {
  const db = DatabaseConnector.instance.database;

  await db
    .update(cronEngineJobsTable)
    .set({ nextRunAt: Date.now() - 1_000 })
    .where(and(eq(cronEngineJobsTable.name, name), eq(cronEngineJobsTable.scope, scope)));
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

    const first = await cron.schedule({
      name: "shared-name",
      scope: "user-a",
      pattern: "0 9 * * *",
      group: "alerts",
      reminderText: "Take medicine.",
    });
    const second = await cron.schedule({
      name: "shared-name",
      scope: "user-b",
      pattern: "0 10 * * *",
    });

    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);

    const userAJob = await cron.getJob("shared-name", "user-a");
    const userBJob = await cron.getJob("shared-name", "user-b");
    const userAJobs = await cron.getAllJobs("user-a");

    expect(userAJob).toMatchObject({
      name: "shared-name",
      scope: "user-a",
      group: "alerts",
      type: ECronEngineJobType.Recurring,
      pattern: "0 9 * * *",
      reminderText: "Take medicine.",
      reminderFallbackText: "Take medicine.",
    });
    expect(userBJob).toMatchObject({
      name: "shared-name",
      scope: "user-b",
      group: undefined,
      type: ECronEngineJobType.Recurring,
      pattern: "0 10 * * *",
      reminderText: undefined,
      reminderPromptData: undefined,
      reminderFallbackText: undefined,
    });
    expect(userAJobs).toHaveLength(1);
  });

  test("rejects duplicate job names inside same user", async () => {
    const cron = CronSingleton.instance;

    const first = await cron.schedule({
      name: "duplicate-job",
      scope: "user-a",
      pattern: "0 9 * * *",
    });
    const duplicate = await cron.schedule({
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

    const first = await cron.schedule({
      name: "overwrite-job",
      scope: "user-a",
      pattern: "0 9 * * *",
      group: "alerts",
      reminderText: "First reminder.",
    });
    const overwritten = await cron.schedule({
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

    const job = await cron.getJob("overwrite-job", "user-a");

    expect(job).toMatchObject({
      name: "overwrite-job",
      scope: "user-a",
      pattern: "0 10 * * *",
      group: "reminders",
      type: ECronEngineJobType.Recurring,
      reminderText: undefined,
      reminderPromptData: '{"topic":"hydration"}',
      reminderFallbackText: "Drink water.",
    });
  });

  test("fires one-time jobs with mapped context and deactivates them", async () => {
    const cron = CronSingleton.instance;
    const internals = cron as unknown as TCronSingletonInternals;

    const scheduled = await cron.scheduleOnce({
      name: "one-time-job",
      scope: "user-a",
      fireAt: new Date(Date.now() + 60_000),
      group: "timers",
      reminderText: "Stretch now.",
    });

    expect("error" in scheduled).toBe(false);

    await forceJobDue("one-time-job", "user-a");

    const fired = new Promise<TCronEngineJobContext>((resolve) => {
      cron.on("one-time-job", (ctx) => {
        resolve(ctx);
      });
    });

    await internals.engine.tick();

    const ctx = await fired;
    const remainingJob = await cron.getJob("one-time-job", "user-a");

    expect(ctx).toMatchObject({
      name: "one-time-job",
      scope: "user-a",
      group: "timers",
      type: ECronEngineJobType.OneTime,
      pattern: undefined,
      reminderText: "Stretch now.",
      reminderPromptData: undefined,
      reminderFallbackText: "Stretch now.",
      lastRunAt: undefined,
    });
    expect(ctx.nextRunAt).toBeInstanceOf(Date);
    expect(remainingJob).toBeUndefined();
  });

  test("fires recurring jobs with mapped context and keeps them scheduled", async () => {
    const cron = CronSingleton.instance;
    const internals = cron as unknown as TCronSingletonInternals;

    const scheduled = await cron.schedule({
      name: "recurring-job",
      scope: "user-a",
      pattern: "*/5 * * * *",
      group: "alerts",
      reminderPromptData: '{"topic":"posture"}',
      reminderFallbackText: "Posture check.",
    });

    expect("error" in scheduled).toBe(false);

    await forceJobDue("recurring-job", "user-a");

    const fired = new Promise<TCronEngineJobContext>((resolve) => {
      cron.on("recurring-job", (ctx) => {
        resolve(ctx);
      });
    });

    await internals.engine.tick();

    const ctx = await fired;
    const job = await cron.getJob("recurring-job", "user-a");

    expect(ctx).toMatchObject({
      name: "recurring-job",
      scope: "user-a",
      group: "alerts",
      type: ECronEngineJobType.Recurring,
      pattern: "*/5 * * * *",
      reminderText: undefined,
      reminderPromptData: '{"topic":"posture"}',
      reminderFallbackText: "Posture check.",
      lastRunAt: undefined,
    });
    expect(job).toMatchObject({
      name: "recurring-job",
      scope: "user-a",
      group: "alerts",
      type: ECronEngineJobType.Recurring,
      pattern: "*/5 * * * *",
      reminderText: undefined,
      reminderPromptData: '{"topic":"posture"}',
      reminderFallbackText: "Posture check.",
      lastRunAt: expect.any(Date),
    });
    expect(job?.nextRunAt).toBeInstanceOf(Date);
    expect((job?.nextRunAt.getTime() ?? 0) > Date.now()).toBe(true);
  });

  test("generic cron event does not collide with job named cron-event", async () => {
    const cron = CronSingleton.instance;
    const internals = cron as unknown as TCronSingletonInternals;

    const scheduled = await cron.schedule({
      name: "cron-event",
      scope: "user-a",
      pattern: "0 9 * * *",
      reminderText: "Test.",
    });

    expect("error" in scheduled).toBe(false);

    await forceJobDue("cron-event", "user-a");

    const namedEvents: TCronEngineJobContext[] = [];
    const cronEvents: TCronEngineJobContext[] = [];

    cron.on("cron-event", (ctx) => {
      namedEvents.push(ctx);
    });
    cron.onCronEvent((ctx) => {
      cronEvents.push(ctx);
    });

    await internals.engine.tick();

    expect(namedEvents).toHaveLength(1);
    expect(cronEvents).toHaveLength(1);
    expect(namedEvents[0]?.name).toBe("cron-event");
    expect(cronEvents[0]?.name).toBe("cron-event");
    expect(cronEvents[0]?.scope).toBe("user-a");
  });
});
