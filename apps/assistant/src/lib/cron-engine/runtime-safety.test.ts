import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../../services/database";
import { cronEngineJobsTable } from "../../services/database/schema";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import { CronScheduler } from "./index";

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

describe("CronScheduler runtime safety", () => {
  let scheduler: CronScheduler;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    scheduler = new CronScheduler({});
  });

  afterEach(() => {
    scheduler.destroy();
  });

  test("overlapping fires complete a one-time job named error once", async () => {
    const scheduled = await scheduler.createOnce({
      name: "error",
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

    expect(fireEvents).toEqual(["error"]);
    expect(await scheduler.get("error", "scope-a")).toBeUndefined();
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
});
