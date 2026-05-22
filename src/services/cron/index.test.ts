import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ECronEngineJobType, type TCronEngineJobContext } from "../../lib/cron-engine";
import { CronSingleton } from "./index";

const tempDir = Bun.env.TMPDIR ?? "/var/folders/q5/24yvwq2937j076ff04yjn_dc0000gn/T/opencode";
const TEST_DB = join(tempDir, "test-cron-service.db");

type TCronSingletonInternals = {
  engine: {
    db: import("bun:sqlite").Database;
    tick: () => Promise<void>;
  };
};

type TCronSingletonStatic = {
  _instance: CronSingleton | undefined;
};

function cleanupCronSingleton() {
  const CronSingletonWithInternals = CronSingleton as unknown as TCronSingletonStatic;
  CronSingletonWithInternals._instance?.destroy();
  CronSingleton.resetDbFile();
}

function forceJobDue(cron: CronSingleton, name: string, scope: string) {
  const internals = cron as unknown as TCronSingletonInternals;

  internals.engine.db
    .query("UPDATE cron_engine_jobs SET nextRunAt = $ts WHERE name = $name AND scope = $scope")
    .run({
      $ts: Date.now() - 1_000,
      $name: name,
      $scope: scope,
    });
}

describe("CronSingleton", () => {
  beforeEach(() => {
    cleanupCronSingleton();

    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }

    CronSingleton.setDbFile(TEST_DB);
  });

  afterEach(() => {
    cleanupCronSingleton();

    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
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

  test("fires one-time jobs with mapped context and removes them", async () => {
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

    forceJobDue(cron, "one-time-job", "user-a");

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

    forceJobDue(cron, "recurring-job", "user-a");

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

    forceJobDue(cron, "cron-event", "user-a");

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
