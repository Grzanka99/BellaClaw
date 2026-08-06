import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../../services/database";
import { cronEngineJobsTable } from "../../services/database/schema";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import { CronScheduler, ECronJobStatus, ECronJobType } from "./index";

type TSchedulerInternals = {
  fire: (id: number) => Promise<void>;
};

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

async function insertDueOneTimeJob(name: string, scope: string) {
  const db = DatabaseConnector.instance.database;

  const row = await db
    .insert(cronEngineJobsTable)
    .values({
      name,
      scope,
      group: null,
      type: ECronJobType.OneTime,
      pattern: null,
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

describe("CronScheduler runtime safety", () => {
  let scheduler: CronScheduler;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    scheduler = new CronScheduler({});
  });

  afterEach(() => {
    scheduler.destroy();
  });

  test("overlapping fires complete a one-time job once", async () => {
    const scheduled = await scheduler.createOnce({
      name: "overlap-job",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
    });

    if ("error" in scheduled) {
      throw new Error(String(scheduled.error));
    }
    await forceJobNextRunAt(scheduled.id, new Date(Date.now() - 1_000));

    const fireEvents: string[] = [];
    scheduler.onFire((ctx) => {
      fireEvents.push(ctx.name);
    });

    await Promise.all([fireJob(scheduler, scheduled.id), fireJob(scheduler, scheduled.id)]);

    expect(fireEvents).toEqual(["overlap-job"]);
    expect(await scheduler.get("overlap-job", "scope-a")).toBeUndefined();
  });

  test("parallel schedulers fire a recurring occurrence once", async () => {
    const secondScheduler = new CronScheduler({});

    try {
      const scheduled = await scheduler.createRecurring({
        name: "parallel-recurring",
        scope: "scope-a",
        pattern: "*/5 * * * *",
      });

      if ("error" in scheduled) {
        throw new Error(String(scheduled.error));
      }
      await forceJobNextRunAt(scheduled.id, new Date(Date.now() - 60_000));

      const fireEvents: string[] = [];
      scheduler.onFire((ctx) => {
        fireEvents.push(ctx.name);
      });
      secondScheduler.onFire((ctx) => {
        fireEvents.push(ctx.name);
      });

      await Promise.all([fireJob(scheduler, scheduled.id), fireJob(secondScheduler, scheduled.id)]);

      expect(fireEvents).toEqual(["parallel-recurring"]);
    } finally {
      secondScheduler.destroy();
    }
  });

  test("reserved EventEmitter names are rejected when scheduling", async () => {
    for (const name of ["error", "newListener", "removeListener"]) {
      const recurring = await scheduler.createRecurring({
        name,
        scope: "scope-a",
        pattern: "*/5 * * * *",
      });
      const oneTime = await scheduler.createOnce({
        name,
        scope: "scope-a",
        fireAt: new Date(Date.now() + 60_000),
      });

      expect("error" in recurring).toBe(true);
      expect("error" in oneTime).toBe(true);
      if ("error" in recurring) {
        expect(String(recurring.error)).toContain("reserved");
      }
      if ("error" in oneTime) {
        expect(String(oneTime.error)).toContain("reserved");
      }
    }
  });

  test("persisted reserved job names still fire generic listeners", async () => {
    const id = await insertDueOneTimeJob("error", "scope-a");

    const fireEvents: string[] = [];
    scheduler.onFire((ctx) => {
      fireEvents.push(ctx.name);
    });

    await fireJob(scheduler, id);

    expect(fireEvents).toEqual(["error"]);
  });
});
