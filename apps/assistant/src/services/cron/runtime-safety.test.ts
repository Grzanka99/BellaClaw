import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cronEngineJobsTable, EEventType, eventsTable } from "@bellaclaw/database";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { resetCronEngineJobsTable, resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { CronScheduler } from "./index";
import { createOnce } from "./test-utils";

type TSchedulerInternals = {
  fire: (id: number) => Promise<void>;
};

async function fireJob(scheduler: CronScheduler, id: number) {
  const internals = scheduler as unknown as TSchedulerInternals;
  await internals.fire(id);
}

async function forceJobNextRunAt(id: number, nextRunAt: Date) {
  const db = DatabaseConnector.instance.database;

  await db.update(cronEngineJobsTable).set({ nextRunAt }).where(eq(cronEngineJobsTable.id, id));
}

describe("CronScheduler runtime safety", () => {
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

  test("overlapping fires complete a one-time job named error once", async () => {
    const scheduled = await createOnce({
      name: "error",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
      content: { kind: "text", text: "Hi." },
    });
    await forceJobNextRunAt(scheduled.id, new Date(Date.now() - 1_000));

    await Promise.all([fireJob(scheduler, scheduled.id), fireJob(scheduler, scheduled.id)]);

    const fired = await DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.CronFired));
    expect(fired.map((row) => row.key)).toEqual(["scope-a|error"]);
    expect(await scheduler.get("error", "scope-a")).toBeUndefined();
  });
});
