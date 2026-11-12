import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { cronEngineJobsTable } from "../database/schema";
import { resetCronEngineJobsTable, resetEventTables } from "../database/test-utils";
import { ESubscriptionMode, EventBus } from "../events";
import { EEventType, type TCronFiredPayload, type TEvent } from "../events/catalog";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { CronScheduler } from "./index";
import { cancelJob, createOnce, createRecurring } from "./test-utils";
import {
  ECronFinishedReason,
  ECronJobStatus,
  ECronJobType,
  type TCronJob,
  type TJobContent,
} from "./types";

type TSchedulerInternals = {
  fire: (id: number) => Promise<void>;
  startTimerIfActive: (job: TCronJob) => Promise<void>;
  timers: Map<number, unknown>;
};

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

  await db.update(cronEngineJobsTable).set({ nextRunAt }).where(eq(cronEngineJobsTable.id, id));
}

async function insertOneTimeJob(name: string, scope: string, nextRunAt: Date) {
  const db = DatabaseConnector.instance.database;

  const row = await db
    .insert(cronEngineJobsTable)
    .values({
      name,
      scope,
      type: ECronJobType.OneTime,
      pattern: null,
      contentKind: "text",
      contentBody: "One-time reminder.",
      nextRunAt,
      lastRunAt: null,
      createdAt: new Date(),
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
      type: ECronJobType.Recurring,
      pattern: "*/5 * * * *",
      contentKind: "text",
      contentBody: "Recurring reminder.",
      nextRunAt,
      lastRunAt: null,
      createdAt: new Date(),
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
  let fired: TEvent<EEventType.CronFired>[];
  let firstFire: PromiseWithResolvers<TCronFiredPayload>;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    await resetEventTables();
    Object.assign(EventBus, { _instance: undefined });
    fired = [];
    firstFire = Promise.withResolvers();
    EventBus.instance.subscribe({
      consumer: "test",
      type: EEventType.CronFired,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        fired.push(event);
        firstFire.resolve(event.payload);
      },
    });
    scheduler = new CronScheduler({});
    scheduler.subscribe();
    await EventBus.instance.start();
  });

  afterEach(async () => {
    scheduler.destroy();
    await EventBus.instance.idle();
    await EventBus.instance.stop();
  });

  test("createRecurring rejects invalid cron pattern before storing", async () => {
    const result = createRecurring({
      name: "bad-pattern",
      scope: "scope-a",
      pattern: "not-a-cron",
      content: { kind: "text", text: "Hi." },
    });

    await expect(result).rejects.toMatchObject({ errorCode: "create-failed" });
    await expect(result).rejects.toThrow("not-a-cron");

    const job = await scheduler.get("bad-pattern", "scope-a");
    expect(job).toBeUndefined();
  });

  test("createRecurring rejects invalid timezone before storing", async () => {
    await expect(
      createRecurring({
        name: "bad-timezone",
        scope: "scope-a",
        pattern: "0 9 * * *",
        timezone: "Not/A_Timezone",
        content: { kind: "text", text: "Hi." },
      }),
    ).rejects.toThrow("Invalid timezone");

    const job = await scheduler.get("bad-timezone", "scope-a");
    expect(job).toBeUndefined();
  });

  test("same job name can exist in different scopes", async () => {
    await createRecurring({
      name: "shared-name",
      scope: "scope-a",
      pattern: "0 9 * * *",
      content: { kind: "text", text: "Hi." },
    });
    await createRecurring({
      name: "shared-name",
      scope: "scope-b",
      pattern: "0 10 * * *",
      content: { kind: "text", text: "Hi." },
    });

    const scopeAJob = await scheduler.get("shared-name", "scope-a");
    const scopeBJob = await scheduler.get("shared-name", "scope-b");
    const scopeAJobs = await scheduler.list("scope-a");

    expect(scopeAJob?.pattern).toBe("0 9 * * *");
    expect(scopeBJob?.pattern).toBe("0 10 * * *");
    expect(scopeAJobs.length).toBe(1);
    expect(scopeAJobs[0]?.scope).toBe("scope-a");
  });

  test("cross-type replacement stays blocked even with overwrite", async () => {
    await createOnce({
      name: "conflict-job",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
      content: { kind: "text", text: "Hi." },
    });

    await expect(
      createRecurring({
        name: "conflict-job",
        scope: "scope-a",
        pattern: "*/5 * * * *",
        overwrite: true,
        content: { kind: "text", text: "Hi." },
      }),
    ).rejects.toMatchObject({
      errorCode: "job-already-exists",
      message:
        "create failed: A one-time job named 'conflict-job' already exists. Cancel it first.",
    });

    await createRecurring({
      name: "conflict-job-2",
      scope: "scope-a",
      pattern: "*/5 * * * *",
      content: { kind: "text", text: "Hi." },
    });

    await expect(
      createOnce({
        name: "conflict-job-2",
        scope: "scope-a",
        fireAt: new Date(Date.now() + 60_000),
        overwrite: true,
        content: { kind: "text", text: "Hi." },
      }),
    ).rejects.toMatchObject({
      errorCode: "job-already-exists",
      message:
        "create failed: A recurring job named 'conflict-job-2' already exists. Cancel it first.",
    });
  });

  test("recurring fire claims row, recomputes next run, and emits events", async () => {
    const scheduled = await createRecurring({
      name: "recurring-job",
      scope: "scope-a",
      pattern: "*/5 * * * *",
      content: { kind: "generated", promptData: '{"topic":"water"}', fallback: "Drink water." },
    });
    const overdueRunAt = new Date(Date.now() - 10 * 60_000);
    await forceJobNextRunAt(scheduled.id, overdueRunAt);

    await fireJob(scheduler, scheduled.id);

    const emitted = await firstFire.promise;
    const updatedJob = await scheduler.get("recurring-job", "scope-a");

    expect(emitted).toMatchObject({
      jobId: scheduled.id,
      name: "recurring-job",
      scope: "scope-a",
      jobType: ECronJobType.Recurring,
      nextRunAt: overdueRunAt.getTime(),
    });
    expect(fired[0]?.key).toBe("scope-a|recurring-job");
    expect(fired[0]?.dedupeKey).toBe(`cron:${scheduled.id}:${overdueRunAt.getTime()}`);
    expect(updatedJob?.lastRunAt).toBeInstanceOf(Date);
    expect(updatedJob?.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(updatedJob?.content).toEqual({
      kind: "generated",
      promptData: '{"topic":"water"}',
      fallback: "Drink water.",
    });
  });

  test("persists and emits scheduled task content", async () => {
    const taskContent: TJobContent = {
      kind: "task",
      prompt: "Find today's important news with source links.",
      fallback: "No briefing is available.",
    };
    const scheduled = await createRecurring({
      name: "daily-news",
      scope: "scope-a",
      pattern: "0 8 * * *",
      content: taskContent,
    });
    await forceJobNextRunAt(scheduled.id, new Date(Date.now() - 1_000));

    await fireJob(scheduler, scheduled.id);

    const listed = await scheduler.get("daily-news", "scope-a");
    const context = await firstFire.promise;

    expect(listed?.content).toEqual(taskContent);
    expect(context.content).toEqual(taskContent);
  });

  test("create does not start a timer after a queued cancel wins", async () => {
    const createPromise = createOnce({
      name: "race-once",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
      content: { kind: "text", text: "Hi." },
    });
    const cancelPromise = cancelJob("race-once", "scope-a");

    const created = await createPromise;
    const cancelled = await cancelPromise;
    const internals = scheduler as unknown as TSchedulerInternals;

    expect(cancelled.id).toBe(created.id);

    expect(internals.timers.has(created.id)).toBe(false);
    expect(await scheduler.get("race-once", "scope-a")).toBeUndefined();
  });

  test("one-time fire completes job once and keeps history", async () => {
    const scheduledId = await insertOneTimeJob(
      "one-time-job",
      "scope-a",
      new Date(Date.now() - 1_000),
    );

    await fireJob(scheduler, scheduledId);
    await fireJob(scheduler, scheduledId);
    await EventBus.instance.idle();
    const fireEvents = fired.map((event) => ({
      type: event.payload.jobType,
      content: event.payload.content,
    }));

    const remainingJob = await scheduler.get("one-time-job", "scope-a");
    const rowsAfterFire = await getJobRows("one-time-job", "scope-a");

    expect(fireEvents).toEqual([
      {
        type: ECronJobType.OneTime,
        content: { kind: "text", text: "One-time reminder." },
      },
    ]);
    expect(remainingJob).toBeUndefined();
    expect(rowsAfterFire).toHaveLength(1);
    expect(rowsAfterFire[0]?.status).toBe(ECronJobStatus.Completed);
    expect(rowsAfterFire[0]?.finishedReason).toBe(ECronFinishedReason.Fired);
    expect(rowsAfterFire[0]?.lastRunAt).toBeInstanceOf(Date);
    expect(rowsAfterFire[0]?.finishedAt).toBeInstanceOf(Date);

    await createOnce({
      name: "one-time-job",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
      content: { kind: "text", text: "Hi." },
    });

    const rowsAfterReuse = await getJobRows("one-time-job", "scope-a");
    expect(rowsAfterReuse).toHaveLength(2);
    expect(rowsAfterReuse.map((row) => row.status)).toEqual([
      ECronJobStatus.Completed,
      ECronJobStatus.Active,
    ]);
  });

  test("future one-time timer fires without polling", async () => {
    await createOnce({
      name: "live-once",
      scope: "scope-a",
      fireAt: nextWholeSecond(),
      content: { kind: "text", text: "Live timer." },
    });

    const ctx = await firstFire.promise;

    expect(ctx.name).toBe("live-once");
    expect(ctx.jobType).toBe(ECronJobType.OneTime);
    expect(await scheduler.get("live-once", "scope-a")).toBeUndefined();
  });

  test("destroyed scheduler refuses later timer activation", async () => {
    const job = await createOnce({
      name: "destroyed-activation",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
      content: { kind: "text", text: "Hi." },
    });
    const internals = scheduler as unknown as TSchedulerInternals;

    scheduler.destroy();
    await internals.startTimerIfActive(job);

    expect(internals.timers.size).toBe(0);
  });

  test("cancel cancels active job and active reads exclude it", async () => {
    await createRecurring({
      name: "cancel-job",
      scope: "scope-a",
      pattern: "0 9 * * *",
      content: { kind: "text", text: "Hi." },
    });

    const result = await cancelJob("cancel-job", "scope-a");

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

    await createRecurring({
      name: "cancel-job",
      scope: "scope-a",
      pattern: "0 10 * * *",
      content: { kind: "text", text: "Hi." },
    });

    const rowsAfterReuse = await getJobRows("cancel-job", "scope-a");
    expect(rowsAfterReuse).toHaveLength(2);
    expect(rowsAfterReuse.map((row) => row.status)).toEqual([
      ECronJobStatus.Cancelled,
      ECronJobStatus.Active,
    ]);
  });

  test("overwrite cancels old active row and inserts replacement", async () => {
    const first = await createRecurring({
      name: "overwrite-job",
      scope: "scope-a",
      pattern: "0 9 * * *",
      content: { kind: "text", text: "First reminder." },
    });

    await createRecurring({
      name: "overwrite-job",
      scope: "scope-a",
      pattern: "0 10 * * *",
      content: { kind: "text", text: "Replacement reminder." },
      overwrite: true,
    });

    const activeJob = await scheduler.get("overwrite-job", "scope-a");
    const activeJobs = await scheduler.list("scope-a");
    const rows = await getJobRows("overwrite-job", "scope-a");
    const internals = scheduler as unknown as TSchedulerInternals;

    expect(activeJob?.pattern).toBe("0 10 * * *");
    expect(activeJob?.content).toEqual({ kind: "text", text: "Replacement reminder." });
    expect(activeJob?.status).toBe(ECronJobStatus.Active);
    expect(activeJobs).toHaveLength(1);
    expect(internals.timers.has(first.id)).toBe(false);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe(ECronJobStatus.Cancelled);
    expect(rows[0]?.finishedReason).toBe(ECronFinishedReason.Overwritten);
    expect(rows[1]?.status).toBe(ECronJobStatus.Active);
    expect(rows[1]?.finishedReason).toBeNull();
  });

  test("cancel throws a coded error when no active job matches", async () => {
    await expect(cancelJob("missing-job", "scope-a")).rejects.toMatchObject({
      errorCode: "job-not-found",
      message: "cancel failed: No job found with name: missing-job",
    });
  });

  test("createOnce rejects a past fireAt with a coded error", async () => {
    await expect(
      createOnce({
        name: "past-job",
        scope: "scope-a",
        fireAt: new Date(Date.now() - 1_000),
        content: { kind: "text", text: "Hi." },
      }),
    ).rejects.toMatchObject({
      errorCode: "fire-at-in-past",
      message: "create failed: fireAt must be in the future",
    });
  });

  test("duplicate create without overwrite throws a coded error", async () => {
    await createRecurring({
      name: "duplicate-job",
      scope: "scope-a",
      pattern: "0 9 * * *",
      content: { kind: "text", text: "Hi." },
    });

    await expect(
      createRecurring({
        name: "duplicate-job",
        scope: "scope-a",
        pattern: "0 9 * * *",
        content: { kind: "text", text: "Hi." },
      }),
    ).rejects.toMatchObject({
      errorCode: "job-already-exists",
      message: "create failed: Job 'duplicate-job' already exists. Set overwrite: true to replace.",
    });
  });

  test("setup fires overdue one-time jobs immediately", async () => {
    const overdueScheduler = new CronScheduler({});

    try {
      await insertOneTimeJob("startup-once", "scope-a", new Date(Date.now() - 1_000));
      await overdueScheduler.setup();

      const ctx = await firstFire.promise;
      const job = await overdueScheduler.get("startup-once", "scope-a");

      expect(ctx.name).toBe("startup-once");
      expect(ctx.jobType).toBe(ECronJobType.OneTime);
      expect(job).toBeUndefined();
    } finally {
      overdueScheduler.destroy();
    }
  });

  test("setup skips overdue recurring jobs to a future run", async () => {
    const overdueScheduler = new CronScheduler({});

    try {
      const id = await insertRecurringJob(
        "startup-recurring",
        "scope-a",
        new Date(Date.now() - 60_000),
      );
      await overdueScheduler.setup();
      await EventBus.instance.idle();

      const job = await overdueScheduler.get("startup-recurring", "scope-a");
      const internals = overdueScheduler as unknown as TSchedulerInternals;

      expect(fired).toEqual([]);
      expect(job?.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect(internals.timers.has(id)).toBe(true);
    } finally {
      overdueScheduler.destroy();
    }
  });
});

describe("CronScheduler.instance", () => {
  afterEach(async () => {
    CronScheduler.instance.destroy();
    await EventBus.instance.idle();
    await EventBus.instance.stop();
  });

  test("recreates a destroyed singleton and uses the default timezone", async () => {
    await resetCronEngineJobsTable();
    await resetEventTables();
    const first = CronScheduler.instance;
    expect(CronScheduler.instance).toBe(first);
    first.destroy();
    const second = CronScheduler.instance;
    expect(second).not.toBe(first);
    Object.assign(EventBus, { _instance: undefined });
    second.subscribe();
    await EventBus.instance.start();

    const job = await createRecurring({
      name: "default-timezone",
      scope: "scope-a",
      pattern: "0 9 * * *",
      content: { kind: "text", text: "Hi." },
    });
    expect(job).toMatchObject({ timezone: DefaultConfigRecord[EConfigKey.AiInstructionsTimezone] });
  });
});
