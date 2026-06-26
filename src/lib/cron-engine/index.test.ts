import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { DatabaseConnector } from "../../services/database";
import { cronEngineJobsTable } from "../../services/database/schema";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import {
  CronEngine,
  ECronEngineFinishedReason,
  ECronEngineJobStatus,
  ECronEngineJobType,
} from "./index";

type TEngineWithInternals = {
  tick: () => Promise<void>;
};

async function forceJobDue(name: string, scope: string) {
  const db = DatabaseConnector.instance.database;

  await db
    .update(cronEngineJobsTable)
    .set({ nextRunAt: Date.now() - 1_000 })
    .where(
      and(
        eq(cronEngineJobsTable.name, name),
        eq(cronEngineJobsTable.scope, scope),
        eq(cronEngineJobsTable.status, ECronEngineJobStatus.Active),
      ),
    );
}

async function getJobRows(name: string, scope: string) {
  const db = DatabaseConnector.instance.database;

  return db
    .select()
    .from(cronEngineJobsTable)
    .where(and(eq(cronEngineJobsTable.name, name), eq(cronEngineJobsTable.scope, scope)))
    .orderBy(asc(cronEngineJobsTable.id));
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

  test("schedule rejects invalid timezone before storing", async () => {
    const result = await engine.schedule({
      name: "bad-timezone",
      scope: "scope-a",
      pattern: "0 9 * * *",
      timezone: "Not/A_Timezone",
    });

    if (!("error" in result)) {
      throw new Error("Expected invalid timezone to fail");
    }

    expect(result.error).toBe("Invalid timezone: Not/A_Timezone");

    const job = await engine.getJob("bad-timezone", "scope-a");
    expect(job).toBeUndefined();
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

  test("tick completes one-time job after firing and keeps history", async () => {
    const internals = engine as unknown as TEngineWithInternals;
    await insertDueOneTimeJob();

    const namedEvents: Array<{
      type: ECronEngineJobType;
      reminderText: string | undefined;
      reminderFallbackText: string | undefined;
    }> = [];
    engine.on("one-time-job", (ctx) => {
      namedEvents.push({
        type: ctx.type,
        reminderText: ctx.reminderText,
        reminderFallbackText: ctx.reminderFallbackText,
      });
    });

    await internals.tick();
    await internals.tick();

    const remainingJob = await engine.getJob("one-time-job", "scope-a");
    const rowsAfterFire = await getJobRows("one-time-job", "scope-a");

    expect(namedEvents).toEqual([
      {
        type: ECronEngineJobType.OneTime,
        reminderText: "One-time reminder.",
        reminderFallbackText: "One-time reminder.",
      },
    ]);
    expect(remainingJob).toBeUndefined();
    expect(rowsAfterFire).toHaveLength(1);
    expect(rowsAfterFire[0]?.status).toBe(ECronEngineJobStatus.Completed);
    expect(rowsAfterFire[0]?.finishedReason).toBe(ECronEngineFinishedReason.Fired);
    expect(typeof rowsAfterFire[0]?.lastRunAt).toBe("number");
    expect(typeof rowsAfterFire[0]?.finishedAt).toBe("number");

    const replacement = await engine.scheduleOnce({
      name: "one-time-job",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
    });

    expect("error" in replacement).toBe(false);

    const rowsAfterReuse = await getJobRows("one-time-job", "scope-a");
    expect(rowsAfterReuse).toHaveLength(2);
    expect(rowsAfterReuse.map((row) => row.status)).toEqual([
      ECronEngineJobStatus.Completed,
      ECronEngineJobStatus.Active,
    ]);
  });

  test("unschedule cancels active job and active reads exclude it", async () => {
    await engine.schedule({
      name: "cancel-job",
      scope: "scope-a",
      pattern: "0 9 * * *",
    });

    const result = await engine.unschedule("cancel-job", "scope-a");

    if ("error" in result) {
      throw new Error(String(result.error));
    }

    const activeJob = await engine.getJob("cancel-job", "scope-a");
    const activeJobs = await engine.getAllJobs("scope-a");
    const rowsAfterCancel = await getJobRows("cancel-job", "scope-a");

    expect(result.status).toBe(ECronEngineJobStatus.Cancelled);
    expect(result.finishedReason).toBe(ECronEngineFinishedReason.Unscheduled);
    expect(result.finishedAt).toBeInstanceOf(Date);
    expect(activeJob).toBeUndefined();
    expect(activeJobs).toEqual([]);
    expect(rowsAfterCancel).toHaveLength(1);
    expect(rowsAfterCancel[0]?.status).toBe(ECronEngineJobStatus.Cancelled);
    expect(rowsAfterCancel[0]?.finishedReason).toBe(ECronEngineFinishedReason.Unscheduled);

    const replacement = await engine.schedule({
      name: "cancel-job",
      scope: "scope-a",
      pattern: "0 10 * * *",
    });

    expect("error" in replacement).toBe(false);

    const rowsAfterReuse = await getJobRows("cancel-job", "scope-a");
    expect(rowsAfterReuse).toHaveLength(2);
    expect(rowsAfterReuse.map((row) => row.status)).toEqual([
      ECronEngineJobStatus.Cancelled,
      ECronEngineJobStatus.Active,
    ]);
  });

  test("overwrite cancels old active row and inserts replacement", async () => {
    await engine.schedule({
      name: "overwrite-job",
      scope: "scope-a",
      pattern: "0 9 * * *",
      reminderText: "First reminder.",
    });

    const overwritten = await engine.schedule({
      name: "overwrite-job",
      scope: "scope-a",
      pattern: "0 10 * * *",
      reminderText: "Replacement reminder.",
      overwrite: true,
    });

    expect("error" in overwritten).toBe(false);

    const activeJob = await engine.getJob("overwrite-job", "scope-a");
    const activeJobs = await engine.getAllJobs("scope-a");
    const rows = await getJobRows("overwrite-job", "scope-a");

    expect(activeJob?.pattern).toBe("0 10 * * *");
    expect(activeJob?.status).toBe(ECronEngineJobStatus.Active);
    expect(activeJobs).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe(ECronEngineJobStatus.Cancelled);
    expect(rows[0]?.finishedReason).toBe(ECronEngineFinishedReason.Overwritten);
    expect(rows[1]?.status).toBe(ECronEngineJobStatus.Active);
    expect(rows[1]?.finishedReason).toBeNull();
  });
});
