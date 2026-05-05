import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CronSingleton } from "./index";
import { ECronJobType, type TJobContext } from "./types";

const tempDir = Bun.env.TMPDIR ?? "/var/folders/q5/24yvwq2937j076ff04yjn_dc0000gn/T/opencode";
const TEST_DB = join(tempDir, "test-cron-service.db");

type TCronSingletonWithInternals = CronSingleton & {
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

function forceJobDue(cron: CronSingleton, name: string, userId: string) {
  const internals = cron as unknown as TCronSingletonWithInternals;

  internals.engine.db
    .query("UPDATE cron_engine_jobs SET nextRunAt = $ts WHERE name = $name AND scope = $scope")
    .run({
      $ts: Date.now() - 1_000,
      $name: name,
      $scope: userId,
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
      userId: "user-a",
      pattern: "0 9 * * *",
      group: "alerts",
    });
    const second = await cron.schedule({
      name: "shared-name",
      userId: "user-b",
      pattern: "0 10 * * *",
    });

    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);

    const userAJob = await cron.getJob("shared-name", "user-a");
    const userBJob = await cron.getJob("shared-name", "user-b");
    const userAJobs = await cron.getAllJobs("user-a");

    expect(userAJob).toMatchObject({
      name: "shared-name",
      userId: "user-a",
      group: "alerts",
      type: ECronJobType.Recurring,
      pattern: "0 9 * * *",
    });
    expect(userBJob).toMatchObject({
      name: "shared-name",
      userId: "user-b",
      group: undefined,
      type: ECronJobType.Recurring,
      pattern: "0 10 * * *",
    });
    expect(userAJobs).toHaveLength(1);
  });

  test("rejects duplicate job names inside same user", async () => {
    const cron = CronSingleton.instance;

    const first = await cron.schedule({
      name: "duplicate-job",
      userId: "user-a",
      pattern: "0 9 * * *",
    });
    const duplicate = await cron.schedule({
      name: "duplicate-job",
      userId: "user-a",
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
      userId: "user-a",
      pattern: "0 9 * * *",
      group: "alerts",
    });
    const overwritten = await cron.schedule({
      name: "overwrite-job",
      userId: "user-a",
      pattern: "0 10 * * *",
      group: "reminders",
      overwrite: true,
    });

    expect("error" in first).toBe(false);
    expect("error" in overwritten).toBe(false);

    const job = await cron.getJob("overwrite-job", "user-a");

    expect(job).toMatchObject({
      name: "overwrite-job",
      userId: "user-a",
      pattern: "0 10 * * *",
      group: "reminders",
      type: ECronJobType.Recurring,
    });
  });

  test("fires one-time jobs with mapped context and removes them", async () => {
    const cron = CronSingleton.instance;
    const internals = cron as unknown as TCronSingletonWithInternals;

    const scheduled = await cron.scheduleOnce({
      name: "one-time-job",
      userId: "user-a",
      fireAt: new Date(Date.now() + 60_000),
      group: "timers",
    });

    expect("error" in scheduled).toBe(false);

    forceJobDue(cron, "one-time-job", "user-a");

    const fired = new Promise<TJobContext>((resolve) => {
      cron.on("one-time-job", (ctx) => {
        resolve(ctx);
      });
    });

    await internals.engine.tick();

    const ctx = await fired;
    const remainingJob = await cron.getJob("one-time-job", "user-a");

    expect(ctx).toMatchObject({
      name: "one-time-job",
      userId: "user-a",
      group: "timers",
      type: ECronJobType.OneTime,
      pattern: undefined,
      lastRunAt: undefined,
    });
    expect(ctx.nextRunAt).toBeInstanceOf(Date);
    expect(remainingJob).toBeUndefined();
  });

  test("fires recurring jobs with mapped context and keeps them scheduled", async () => {
    const cron = CronSingleton.instance;
    const internals = cron as unknown as TCronSingletonWithInternals;

    const scheduled = await cron.schedule({
      name: "recurring-job",
      userId: "user-a",
      pattern: "*/5 * * * *",
      group: "alerts",
    });

    expect("error" in scheduled).toBe(false);

    forceJobDue(cron, "recurring-job", "user-a");

    const fired = new Promise<TJobContext>((resolve) => {
      cron.on("recurring-job", (ctx) => {
        resolve(ctx);
      });
    });

    await internals.engine.tick();

    const ctx = await fired;
    const job = await cron.getJob("recurring-job", "user-a");

    expect(ctx).toMatchObject({
      name: "recurring-job",
      userId: "user-a",
      group: "alerts",
      type: ECronJobType.Recurring,
      pattern: "*/5 * * * *",
      lastRunAt: undefined,
    });
    expect(job).toMatchObject({
      name: "recurring-job",
      userId: "user-a",
      group: "alerts",
      type: ECronJobType.Recurring,
      pattern: "*/5 * * * *",
      lastRunAt: expect.any(Date),
    });
    expect(job?.nextRunAt).toBeInstanceOf(Date);
    expect((job?.nextRunAt.getTime() ?? 0) > Date.now()).toBe(true);
  });
});
