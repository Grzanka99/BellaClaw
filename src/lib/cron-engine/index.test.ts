import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { DatabaseConnector } from "../../services/database";
import { cronEngineJobsTable } from "../../services/database/schema";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import { CronEngine, ECronEngineJobType } from "./index";

type TEngineWithInternals = {
  tick: () => Promise<void>;
};

async function forceJobDue(name: string, scope: string) {
  const db = DatabaseConnector.instance.database;

  await db
    .update(cronEngineJobsTable)
    .set({ nextRunAt: Date.now() - 1_000 })
    .where(and(eq(cronEngineJobsTable.name, name), eq(cronEngineJobsTable.scope, scope)));
}

async function insertDueOneTimeJob() {
  const db = DatabaseConnector.instance.database;

  await db.insert(cronEngineJobsTable).values({
    name: "one-time-job",
    scope: "scope-a",
    group: '{"kind":"one-time"}',
    type: "onetime",
    pattern: null,
    reminderText: "One-time reminder.",
    reminderPromptData: null,
    reminderFallbackText: "One-time reminder.",
    nextRunAt: Date.now() - 1_000,
    lastRunAt: null,
    createdAt: Date.now(),
  });
}

describe("CronEngine", () => {
  let engine: CronEngine;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    engine = new CronEngine({});
  });

  afterEach(() => {
    engine.destroy();
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
      group: '{"kind":"recurring"}',
      reminderPromptData: '{"topic":"water"}',
      reminderFallbackText: "Drink water.",
    });

    const internals = engine as unknown as TEngineWithInternals;
    await forceJobDue("recurring-job", "scope-a");

    const namedEvent = new Promise<{
      name: string;
      scope: string | undefined;
      type: ECronEngineJobType;
      group: string | undefined;
      reminderPromptData: string | undefined;
      reminderFallbackText: string | undefined;
    }>((resolve) => {
      engine.on("recurring-job", (ctx) => {
        resolve({
          name: ctx.name,
          scope: ctx.scope,
          type: ctx.type,
          group: ctx.group,
          reminderPromptData: ctx.reminderPromptData,
          reminderFallbackText: ctx.reminderFallbackText,
        });
      });
    });

    const fireEvent = new Promise<string>((resolve) => {
      engine.onFire((ctx) => {
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
    expect(emitted.group).toBe('{"kind":"recurring"}');
    expect(emitted.reminderPromptData).toBe('{"topic":"water"}');
    expect(emitted.reminderFallbackText).toBe("Drink water.");
    expect(firedName).toBe("recurring-job");
    expect(updatedJob?.lastRunAt).toBeInstanceOf(Date);
    expect(updatedJob?.nextRunAt).toBeInstanceOf(Date);
    expect(updatedJob?.reminderPromptData).toBe('{"topic":"water"}');
    expect(updatedJob?.reminderFallbackText).toBe("Drink water.");
    expect((updatedJob?.nextRunAt.getTime() ?? 0) > Date.now()).toBe(true);
  });

  test("generic fire event does not collide with job named fire", async () => {
    await engine.schedule({
      name: "fire",
      scope: "scope-a",
      pattern: "*/5 * * * *",
    });

    const internals = engine as unknown as TEngineWithInternals;
    await forceJobDue("fire", "scope-a");

    const namedEvents: string[] = [];
    const fireEvents: string[] = [];

    engine.on("fire", (ctx) => {
      namedEvents.push(ctx.name);
    });
    engine.onFire((ctx) => {
      fireEvents.push(ctx.name);
    });

    await internals.tick();

    expect(namedEvents).toEqual(["fire"]);
    expect(fireEvents).toEqual(["fire"]);
  });

  test("tick removes one-time job after firing", async () => {
    const internals = engine as unknown as TEngineWithInternals;
    await insertDueOneTimeJob();

    const namedEvent = new Promise<{
      type: ECronEngineJobType;
      reminderText: string | undefined;
      reminderFallbackText: string | undefined;
    }>((resolve) => {
      engine.on("one-time-job", (ctx) => {
        resolve({
          type: ctx.type,
          reminderText: ctx.reminderText,
          reminderFallbackText: ctx.reminderFallbackText,
        });
      });
    });

    await internals.tick();

    const emitted = await namedEvent;
    const remainingJob = await engine.getJob("one-time-job", "scope-a");

    expect(emitted.type).toBe(ECronEngineJobType.OneTime);
    expect(emitted.reminderText).toBe("One-time reminder.");
    expect(emitted.reminderFallbackText).toBe("One-time reminder.");
    expect(remainingJob).toBeUndefined();
  });
});
