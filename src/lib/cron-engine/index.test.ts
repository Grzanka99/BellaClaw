import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { DatabaseConnector } from "../../services/database";
import { cronEngineJobsTable } from "../../services/database/schema";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import {
  CronScheduler,
  ECronFinishedReason,
  ECronJobStatus,
  ECronJobType,
  type TCronJob,
  type TCronJobContext,
  type TCronSchedulerError,
} from "./index";

type TSchedulerInternals = {
  fire: (id: number) => Promise<void>;
  startTimerIfActive: (job: TCronJob) => Promise<void>;
  timers: Map<number, unknown>;
};

function expectCreated(result: TCronJob | TCronSchedulerError) {
  if ("error" in result) {
    throw new Error(String(result.error));
  }

  return result;
}

async function fireJob(scheduler: CronScheduler, id: number) {
  const internals = scheduler as unknown as TSchedulerInternals;
  await internals.fire(id);
}

async function getJobRows(name: string, scope: string) {
  const db = DatabaseConnector.instance.database;

  return db
    .select()
    .from(cronEngineJobsTable)
    .where(and(eq(cronEngineJobsTable.name, name), eq(cronEngineJobsTable.scope, scope)))
    .orderBy(asc(cronEngineJobsTable.id));
}

async function forceJobNextRunAt(id: number, nextRunAt: Date) {
  const db = DatabaseConnector.instance.database;

  await db
    .update(cronEngineJobsTable)
    .set({ nextRunAt: nextRunAt.getTime() })
    .where(eq(cronEngineJobsTable.id, id));
}

async function insertOneTimeJob(name: string, scope: string, nextRunAt: Date) {
  const db = DatabaseConnector.instance.database;

  const row = await db
    .insert(cronEngineJobsTable)
    .values({
      name,
      scope,
      group: '{"kind":"one-time"}',
      type: ECronJobType.OneTime,
      pattern: null,
      reminderText: "One-time reminder.",
      reminderPromptData: null,
      reminderFallbackText: "One-time reminder.",
      nextRunAt: nextRunAt.getTime(),
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

async function insertRecurringJob(name: string, scope: string, nextRunAt: Date) {
  const db = DatabaseConnector.instance.database;

  const row = await db
    .insert(cronEngineJobsTable)
    .values({
      name,
      scope,
      group: null,
      type: ECronJobType.Recurring,
      pattern: "*/5 * * * *",
      reminderText: null,
      reminderPromptData: null,
      reminderFallbackText: null,
      nextRunAt: nextRunAt.getTime(),
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

function nextWholeSecond() {
  return new Date(Math.ceil((Date.now() + 1_500) / 1_000) * 1_000);
}

describe("CronScheduler", () => {
  let scheduler: CronScheduler;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    scheduler = new CronScheduler({});
  });

  afterEach(() => {
    scheduler.destroy();
  });

  test("createRecurring rejects invalid cron pattern before storing", async () => {
    const result = await scheduler.createRecurring({
      name: "bad-pattern",
      scope: "scope-a",
      pattern: "not-a-cron",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(String(result.error)).toContain("not-a-cron");
    }

    const job = await scheduler.get("bad-pattern", "scope-a");
    expect(job).toBeUndefined();
  });

  test("createRecurring rejects invalid timezone before storing", async () => {
    const result = await scheduler.createRecurring({
      name: "bad-timezone",
      scope: "scope-a",
      pattern: "0 9 * * *",
      timezone: "Not/A_Timezone",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(String(result.error)).toContain("Invalid timezone");
    }

    const job = await scheduler.get("bad-timezone", "scope-a");
    expect(job).toBeUndefined();
  });

  test("same job name can exist in different scopes", async () => {
    const first = await scheduler.createRecurring({
      name: "shared-name",
      scope: "scope-a",
      pattern: "0 9 * * *",
    });
    const second = await scheduler.createRecurring({
      name: "shared-name",
      scope: "scope-b",
      pattern: "0 10 * * *",
    });

    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);

    const scopeAJob = await scheduler.get("shared-name", "scope-a");
    const scopeBJob = await scheduler.get("shared-name", "scope-b");
    const scopeAJobs = await scheduler.list("scope-a");

    expect(scopeAJob?.pattern).toBe("0 9 * * *");
    expect(scopeBJob?.pattern).toBe("0 10 * * *");
    expect(scopeAJobs.length).toBe(1);
    expect(scopeAJobs[0]?.scope).toBe("scope-a");
  });

  test("cross-type replacement stays blocked even with overwrite", async () => {
    await scheduler.createOnce({
      name: "conflict-job",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
    });

    const recurringResult = await scheduler.createRecurring({
      name: "conflict-job",
      scope: "scope-a",
      pattern: "*/5 * * * *",
      overwrite: true,
    });
    expect("error" in recurringResult).toBe(true);

    await scheduler.createRecurring({
      name: "conflict-job-2",
      scope: "scope-a",
      pattern: "*/5 * * * *",
    });

    const oneTimeResult = await scheduler.createOnce({
      name: "conflict-job-2",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
      overwrite: true,
    });
    expect("error" in oneTimeResult).toBe(true);
  });

  test("recurring fire claims row, recomputes next run, and emits events", async () => {
    const scheduled = expectCreated(
      await scheduler.createRecurring({
        name: "recurring-job",
        scope: "scope-a",
        pattern: "*/5 * * * *",
        group: '{"kind":"recurring"}',
        reminderPromptData: '{"topic":"water"}',
        reminderFallbackText: "Drink water.",
      }),
    );
    const overdueRunAt = new Date(Date.now() - 10 * 60_000);
    await forceJobNextRunAt(scheduled.id, overdueRunAt);

    const namedEvent = new Promise<
      Pick<TCronJobContext, "name" | "scope" | "type" | "lastRunAt" | "nextRunAt">
    >((resolve) => {
      scheduler.on("recurring-job", (ctx: TCronJobContext) => {
        resolve({
          name: ctx.name,
          scope: ctx.scope,
          type: ctx.type,
          lastRunAt: ctx.lastRunAt,
          nextRunAt: ctx.nextRunAt,
        });
      });
    });

    const fireEvent = new Promise<string>((resolve) => {
      scheduler.onFire((ctx) => {
        if (ctx.name === "recurring-job") {
          resolve(ctx.name);
        }
      });
    });

    await fireJob(scheduler, scheduled.id);

    const emitted = await namedEvent;
    const firedName = await fireEvent;
    const updatedJob = await scheduler.get("recurring-job", "scope-a");

    expect(emitted).toEqual({
      name: "recurring-job",
      scope: "scope-a",
      type: ECronJobType.Recurring,
      lastRunAt: undefined,
      nextRunAt: overdueRunAt,
    });
    expect(firedName).toBe("recurring-job");
    expect(updatedJob?.lastRunAt).toBeInstanceOf(Date);
    expect(updatedJob?.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(updatedJob?.reminderPromptData).toBe('{"topic":"water"}');
    expect(updatedJob?.reminderFallbackText).toBe("Drink water.");
  });

  test("generic fire event does not collide with job named fire", async () => {
    const scheduled = expectCreated(
      await scheduler.createRecurring({
        name: "fire",
        scope: "scope-a",
        pattern: "*/5 * * * *",
      }),
    );
    await forceJobNextRunAt(scheduled.id, new Date(Date.now() - 1_000));

    const namedEvents: string[] = [];
    const fireEvents: string[] = [];

    scheduler.on("fire", (ctx: TCronJobContext) => {
      namedEvents.push(ctx.name);
    });
    scheduler.onFire((ctx) => {
      fireEvents.push(ctx.name);
    });

    await fireJob(scheduler, scheduled.id);

    expect(namedEvents).toEqual(["fire"]);
    expect(fireEvents).toEqual(["fire"]);
  });

  test("create does not start a timer after a queued cancel wins", async () => {
    const createPromise = scheduler.createOnce({
      name: "race-once",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
    });
    const cancelPromise = scheduler.cancel("race-once", "scope-a");

    const created = await createPromise;
    const cancelled = await cancelPromise;
    const internals = scheduler as unknown as TSchedulerInternals;

    expect("error" in created).toBe(false);
    expect("error" in cancelled).toBe(false);
    if ("error" in created) {
      throw new Error(String(created.error));
    }

    expect(internals.timers.has(created.id)).toBe(false);
    expect(await scheduler.get("race-once", "scope-a")).toBeUndefined();
  });

  test("one-time fire completes job once and keeps history", async () => {
    const scheduledId = await insertOneTimeJob(
      "one-time-job",
      "scope-a",
      new Date(Date.now() - 1_000),
    );

    const namedEvents: Array<{
      type: ECronJobType;
      reminderText: string | undefined;
      reminderFallbackText: string | undefined;
    }> = [];
    scheduler.on("one-time-job", (ctx: TCronJobContext) => {
      namedEvents.push({
        type: ctx.type,
        reminderText: ctx.reminderText,
        reminderFallbackText: ctx.reminderFallbackText,
      });
    });

    await fireJob(scheduler, scheduledId);
    await fireJob(scheduler, scheduledId);

    const remainingJob = await scheduler.get("one-time-job", "scope-a");
    const rowsAfterFire = await getJobRows("one-time-job", "scope-a");

    expect(namedEvents).toEqual([
      {
        type: ECronJobType.OneTime,
        reminderText: "One-time reminder.",
        reminderFallbackText: "One-time reminder.",
      },
    ]);
    expect(remainingJob).toBeUndefined();
    expect(rowsAfterFire).toHaveLength(1);
    expect(rowsAfterFire[0]?.status).toBe(ECronJobStatus.Completed);
    expect(rowsAfterFire[0]?.finishedReason).toBe(ECronFinishedReason.Fired);
    expect(typeof rowsAfterFire[0]?.lastRunAt).toBe("number");
    expect(typeof rowsAfterFire[0]?.finishedAt).toBe("number");

    const replacement = await scheduler.createOnce({
      name: "one-time-job",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
    });

    expect("error" in replacement).toBe(false);

    const rowsAfterReuse = await getJobRows("one-time-job", "scope-a");
    expect(rowsAfterReuse).toHaveLength(2);
    expect(rowsAfterReuse.map((row) => row.status)).toEqual([
      ECronJobStatus.Completed,
      ECronJobStatus.Active,
    ]);
  });

  test("future one-time timer fires without polling", async () => {
    const fired = new Promise<TCronJobContext>((resolve) => {
      scheduler.on("live-once", (ctx: TCronJobContext) => {
        resolve(ctx);
      });
    });

    await scheduler.createOnce({
      name: "live-once",
      scope: "scope-a",
      fireAt: nextWholeSecond(),
      reminderText: "Live timer.",
    });

    const ctx = await Promise.race([
      fired,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Timed out waiting for one-time timer"));
        }, 3_500);
      }),
    ]);

    expect(ctx.name).toBe("live-once");
    expect(ctx.type).toBe(ECronJobType.OneTime);
    expect(await scheduler.get("live-once", "scope-a")).toBeUndefined();
  });

  test("activating an expired one-time job fires it immediately", async () => {
    await insertOneTimeJob("expired-before-activation", "scope-a", new Date(Date.now() - 1_000));
    const job = await scheduler.get("expired-before-activation", "scope-a");
    if (!job) {
      throw new Error("Expected active one-time job");
    }

    const fired = new Promise<TCronJobContext>((resolve) => {
      scheduler.on("expired-before-activation", (ctx: TCronJobContext) => {
        resolve(ctx);
      });
    });
    const internals = scheduler as unknown as TSchedulerInternals;

    await internals.startTimerIfActive(job);

    expect((await fired).name).toBe("expired-before-activation");
    expect(await scheduler.get("expired-before-activation", "scope-a")).toBeUndefined();
  });

  test("activating an expired recurring job advances it before starting its timer", async () => {
    const id = await insertRecurringJob(
      "expired-recurring-before-activation",
      "scope-a",
      new Date(Date.now() - 60_000),
    );
    const job = await scheduler.get("expired-recurring-before-activation", "scope-a");
    if (!job) {
      throw new Error("Expected active recurring job");
    }

    const events: string[] = [];
    scheduler.on("expired-recurring-before-activation", (ctx: TCronJobContext) => {
      events.push(ctx.name);
    });
    const internals = scheduler as unknown as TSchedulerInternals;

    await internals.startTimerIfActive(job);

    const updated = await scheduler.get("expired-recurring-before-activation", "scope-a");
    expect(events).toEqual([]);
    expect(updated?.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(internals.timers.has(id)).toBe(true);
  });

  test("destroyed scheduler refuses later timer activation", async () => {
    const job = expectCreated(
      await scheduler.createOnce({
        name: "destroyed-activation",
        scope: "scope-a",
        fireAt: new Date(Date.now() + 60_000),
      }),
    );
    const internals = scheduler as unknown as TSchedulerInternals;

    scheduler.destroy();
    await internals.startTimerIfActive(job);

    expect(internals.timers.size).toBe(0);
  });

  test("cancel cancels active job and active reads exclude it", async () => {
    await scheduler.createRecurring({
      name: "cancel-job",
      scope: "scope-a",
      pattern: "0 9 * * *",
    });

    const result = await scheduler.cancel("cancel-job", "scope-a");

    if ("error" in result) {
      throw new Error(String(result.error));
    }

    const activeJob = await scheduler.get("cancel-job", "scope-a");
    const activeJobs = await scheduler.list("scope-a");
    const rowsAfterCancel = await getJobRows("cancel-job", "scope-a");

    expect(result.status).toBe(ECronJobStatus.Cancelled);
    expect(result.finishedReason).toBe(ECronFinishedReason.Unscheduled);
    expect(result.finishedAt).toBeInstanceOf(Date);
    expect(activeJob).toBeUndefined();
    expect(activeJobs).toEqual([]);
    expect(rowsAfterCancel).toHaveLength(1);
    expect(rowsAfterCancel[0]?.status).toBe(ECronJobStatus.Cancelled);
    expect(rowsAfterCancel[0]?.finishedReason).toBe(ECronFinishedReason.Unscheduled);

    const replacement = await scheduler.createRecurring({
      name: "cancel-job",
      scope: "scope-a",
      pattern: "0 10 * * *",
    });

    expect("error" in replacement).toBe(false);

    const rowsAfterReuse = await getJobRows("cancel-job", "scope-a");
    expect(rowsAfterReuse).toHaveLength(2);
    expect(rowsAfterReuse.map((row) => row.status)).toEqual([
      ECronJobStatus.Cancelled,
      ECronJobStatus.Active,
    ]);
  });

  test("overwrite cancels old active row and inserts replacement", async () => {
    const first = expectCreated(
      await scheduler.createRecurring({
        name: "overwrite-job",
        scope: "scope-a",
        pattern: "0 9 * * *",
        reminderText: "First reminder.",
      }),
    );

    const overwritten = await scheduler.createRecurring({
      name: "overwrite-job",
      scope: "scope-a",
      pattern: "0 10 * * *",
      reminderText: "Replacement reminder.",
      overwrite: true,
    });

    expect("error" in overwritten).toBe(false);

    const activeJob = await scheduler.get("overwrite-job", "scope-a");
    const activeJobs = await scheduler.list("scope-a");
    const rows = await getJobRows("overwrite-job", "scope-a");
    const internals = scheduler as unknown as TSchedulerInternals;

    expect(activeJob?.pattern).toBe("0 10 * * *");
    expect(activeJob?.status).toBe(ECronJobStatus.Active);
    expect(activeJobs).toHaveLength(1);
    expect(internals.timers.has(first.id)).toBe(false);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe(ECronJobStatus.Cancelled);
    expect(rows[0]?.finishedReason).toBe(ECronFinishedReason.Overwritten);
    expect(rows[1]?.status).toBe(ECronJobStatus.Active);
    expect(rows[1]?.finishedReason).toBeNull();
  });

  test("setup fires overdue one-time jobs immediately", async () => {
    const overdueScheduler = new CronScheduler({});
    const fired = new Promise<TCronJobContext>((resolve) => {
      overdueScheduler.on("startup-once", (ctx: TCronJobContext) => {
        resolve(ctx);
      });
    });

    try {
      await insertOneTimeJob("startup-once", "scope-a", new Date(Date.now() - 1_000));
      await overdueScheduler.setup();

      const ctx = await fired;
      const job = await overdueScheduler.get("startup-once", "scope-a");

      expect(ctx.name).toBe("startup-once");
      expect(ctx.type).toBe(ECronJobType.OneTime);
      expect(job).toBeUndefined();
    } finally {
      overdueScheduler.destroy();
    }
  });

  test("setup skips overdue recurring jobs to a future run", async () => {
    const overdueScheduler = new CronScheduler({});
    const events: string[] = [];

    try {
      const id = await insertRecurringJob(
        "startup-recurring",
        "scope-a",
        new Date(Date.now() - 60_000),
      );
      overdueScheduler.on("startup-recurring", (ctx: TCronJobContext) => {
        events.push(ctx.name);
      });

      await overdueScheduler.setup();

      const job = await overdueScheduler.get("startup-recurring", "scope-a");
      const internals = overdueScheduler as unknown as TSchedulerInternals;

      expect(events).toEqual([]);
      expect(job?.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect(internals.timers.has(id)).toBe(true);
    } finally {
      overdueScheduler.destroy();
    }
  });
});
