import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { DatabaseConnector } from "../../services/database";
import { cronEngineJobsTable } from "../../services/database/schema";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import type { AsyncQueue } from "../../utils/async-queue";
import { CronEngine } from "./index";

type TEngineWithInternals = {
  queue: AsyncQueue;
  tick: () => Promise<void>;
};

async function forceJobDue(engine: CronEngine, name: string, scope: string) {
  const internals = engine as unknown as TEngineWithInternals;
  const db = DatabaseConnector.instance.database;

  await internals.queue.enqueue(async () => {
    await db
      .update(cronEngineJobsTable)
      .set({ nextRunAt: Date.now() - 1_000 })
      .where(and(eq(cronEngineJobsTable.name, name), eq(cronEngineJobsTable.scope, scope)));
  });
}

async function insertDueOneTimeJob(engine: CronEngine, name: string, scope: string) {
  const internals = engine as unknown as TEngineWithInternals;
  const db = DatabaseConnector.instance.database;

  await internals.queue.enqueue(async () => {
    await db.insert(cronEngineJobsTable).values({
      name,
      scope,
      group: null,
      type: "onetime",
      pattern: null,
      reminderText: null,
      reminderPromptData: null,
      reminderFallbackText: null,
      nextRunAt: Date.now() - 1_000,
      lastRunAt: null,
      createdAt: Date.now(),
    });
  });
}

describe("CronEngine runtime safety", () => {
  let engine: CronEngine;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    engine = new CronEngine({});
  });

  afterEach(() => {
    engine.destroy();
  });

  test("overlapping ticks fire a due job once", async () => {
    const scheduled = await engine.scheduleOnce({
      name: "overlap-job",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
    });
    expect("error" in scheduled).toBe(false);

    await forceJobDue(engine, "overlap-job", "scope-a");

    const fireEvents: string[] = [];
    engine.onFire((ctx) => {
      fireEvents.push(ctx.name);
    });

    const internals = engine as unknown as TEngineWithInternals;
    await Promise.all([internals.tick(), internals.tick()]);

    expect(fireEvents).toEqual(["overlap-job"]);
    expect(await engine.getJob("overlap-job", "scope-a")).toBeUndefined();
  });

  test("reserved EventEmitter names are rejected when scheduling", async () => {
    for (const name of ["error", "newListener", "removeListener"]) {
      const recurring = await engine.schedule({
        name,
        scope: "scope-a",
        pattern: "*/5 * * * *",
      });
      const oneTime = await engine.scheduleOnce({
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
    await insertDueOneTimeJob(engine, "error", "scope-a");

    const fireEvents: string[] = [];
    engine.onFire((ctx) => {
      fireEvents.push(ctx.name);
    });

    const internals = engine as unknown as TEngineWithInternals;
    await internals.tick();

    expect(fireEvents).toEqual(["error"]);
  });
});
