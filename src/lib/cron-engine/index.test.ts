import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CronEngine, ECronEngineJobType } from "./index";

const tempDir = Bun.env.TMPDIR ?? "/var/folders/q5/24yvwq2937j076ff04yjn_dc0000gn/T/opencode";
const TEST_DB = join(tempDir, "test-cron-engine.db");

type TEngineWithInternals = {
  db: import("bun:sqlite").Database;
  tick: () => Promise<void>;
};

describe("CronEngine", () => {
  let engine: CronEngine;

  beforeEach(() => {
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }

    engine = new CronEngine({
      dbFile: TEST_DB,
      tableName: "cron_engine_test_jobs",
    });
  });

  afterEach(() => {
    engine.destroy();

    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
  });

  test("schedule rejects invalid cron pattern", async () => {
    const result = await engine.schedule({
      name: "bad-pattern",
      scope: "scope-a",
      pattern: "not-a-cron",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(String(result.error)).toContain("Invalid cron pattern");
    }
  });

  test("same job name can exist in different scopes", async () => {
    const first = await engine.schedule({
      name: "shared-name",
      scope: "scope-a",
      pattern: "0 9 * * *",
    });
    const second = await engine.schedule({
      name: "shared-name",
      scope: "scope-b",
      pattern: "0 10 * * *",
    });

    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);

    const scopeAJob = await engine.getJob("shared-name", "scope-a");
    const scopeBJob = await engine.getJob("shared-name", "scope-b");
    const scopeAJobs = await engine.getAllJobs("scope-a");

    expect(scopeAJob?.pattern).toBe("0 9 * * *");
    expect(scopeBJob?.pattern).toBe("0 10 * * *");
    expect(scopeAJobs.length).toBe(1);
    expect(scopeAJobs[0]?.scope).toBe("scope-a");
  });

  test("cross-type replacement stays blocked even with overwrite", async () => {
    await engine.scheduleOnce({
      name: "conflict-job",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
    });

    const recurringResult = await engine.schedule({
      name: "conflict-job",
      scope: "scope-a",
      pattern: "*/5 * * * *",
      overwrite: true,
    });
    expect("error" in recurringResult).toBe(true);

    await engine.schedule({
      name: "conflict-job-2",
      scope: "scope-a",
      pattern: "*/5 * * * *",
    });

    const oneTimeResult = await engine.scheduleOnce({
      name: "conflict-job-2",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
      overwrite: true,
    });
    expect("error" in oneTimeResult).toBe(true);
  });

  test("tick reschedules recurring job and emits events", async () => {
    await engine.schedule({
      name: "recurring-job",
      scope: "scope-a",
      pattern: "*/5 * * * *",
      data: '{"kind":"recurring"}',
    });

    const internals = engine as unknown as TEngineWithInternals;
    internals.db.query("UPDATE cron_engine_test_jobs SET nextRunAt = $ts WHERE name = $name AND scope = $scope").run({
      $ts: Date.now() - 1_000,
      $name: "recurring-job",
      $scope: "scope-a",
    });

    const namedEvent = new Promise<{
      name: string;
      scope: string | undefined;
      type: ECronEngineJobType;
      data: string | undefined;
    }>((resolve) => {
      engine.on("recurring-job", (ctx) => {
        resolve({
          name: ctx.name,
          scope: ctx.scope,
          type: ctx.type,
          data: ctx.data,
        });
      });
    });

    const fireEvent = new Promise<string>((resolve) => {
      engine.on("fire", (ctx) => {
        if (ctx.name === "recurring-job") {
          resolve(ctx.name);
        }
      });
    });

    await internals.tick();

    const emitted = await namedEvent;
    const firedName = await fireEvent;
    const updatedJob = await engine.getJob("recurring-job", "scope-a");

    expect(emitted.name).toBe("recurring-job");
    expect(emitted.scope).toBe("scope-a");
    expect(emitted.type).toBe(ECronEngineJobType.Recurring);
    expect(emitted.data).toBe('{"kind":"recurring"}');
    expect(firedName).toBe("recurring-job");
    expect(updatedJob?.lastRunAt).toBeInstanceOf(Date);
    expect(updatedJob?.nextRunAt).toBeInstanceOf(Date);
    expect((updatedJob?.nextRunAt.getTime() ?? 0) > Date.now()).toBe(true);
  });

  test("tick removes one-time job after firing", async () => {
    const internals = engine as unknown as TEngineWithInternals;
    internals.db
      .query(
        `INSERT INTO cron_engine_test_jobs (name, scope, data, type, pattern, nextRunAt, lastRunAt, createdAt)
         VALUES ($name, $scope, $data, $type, $pattern, $nextRunAt, $lastRunAt, $createdAt)`,
      )
      .run({
        $name: "one-time-job",
        $scope: "scope-a",
        $data: '{"kind":"one-time"}',
        $type: "onetime",
        $pattern: null,
        $nextRunAt: Date.now() - 1_000,
        $lastRunAt: null,
        $createdAt: Date.now(),
      });

    const namedEvent = new Promise<ECronEngineJobType>((resolve) => {
      engine.on("one-time-job", (ctx) => {
        resolve(ctx.type);
      });
    });

    await internals.tick();

    const emittedType = await namedEvent;
    const remainingJob = await engine.getJob("one-time-job", "scope-a");

    expect(emittedType).toBe(ECronEngineJobType.OneTime);
    expect(remainingJob).toBeUndefined();
  });
});
