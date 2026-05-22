import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AsyncQueue } from "../../utils/async-queue";
import { CronEngine } from "./index";

const tempDir = Bun.env.TMPDIR ?? "/var/folders/q5/24yvwq2937j076ff04yjn_dc0000gn/T/opencode";
const TEST_DB = join(tempDir, "test-cron-engine-runtime-safety.db");
const TABLE_NAME = "cron_engine_runtime_safety_jobs";

type TEngineWithInternals = {
  db: Database;
  queue: AsyncQueue;
  tick: () => Promise<void>;
};

async function forceJobDue(engine: CronEngine, name: string, scope: string) {
  const internals = engine as unknown as TEngineWithInternals;

  await internals.queue.enqueue(async () => {
    internals.db
      .query(`UPDATE ${TABLE_NAME} SET nextRunAt = $ts WHERE name = $name AND scope = $scope`)
      .run({
        $ts: Date.now() - 1_000,
        $name: name,
        $scope: scope,
      });
  });
}

async function insertDueOneTimeJob(engine: CronEngine, name: string, scope: string) {
  const internals = engine as unknown as TEngineWithInternals;

  await internals.queue.enqueue(async () => {
    internals.db
      .query(
        `INSERT INTO ${TABLE_NAME} (name, scope, "group", type, pattern, reminderText, reminderPromptData, reminderFallbackText, nextRunAt, lastRunAt, createdAt)
         VALUES ($name, $scope, $group, $type, $pattern, $reminderText, $reminderPromptData, $reminderFallbackText, $nextRunAt, $lastRunAt, $createdAt)`,
      )
      .run({
        $name: name,
        $scope: scope,
        $group: null,
        $type: "onetime",
        $pattern: null,
        $reminderText: null,
        $reminderPromptData: null,
        $reminderFallbackText: null,
        $nextRunAt: Date.now() - 1_000,
        $lastRunAt: null,
        $createdAt: Date.now(),
      });
  });
}

describe("CronEngine runtime safety", () => {
  let engine: CronEngine;

  beforeEach(() => {
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }

    engine = new CronEngine({
      dbFile: TEST_DB,
      tableName: TABLE_NAME,
    });
  });

  afterEach(() => {
    engine.destroy();

    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
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
