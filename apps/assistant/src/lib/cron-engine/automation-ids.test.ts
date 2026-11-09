import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../../services/database";
import { cronEngineJobsTable } from "../../services/database/schema";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import {
  CronScheduler,
  ECronFinishedReason,
  ECronJobStatus,
  SCreateRecurringArgs,
  type TCronJob,
  type TCronJobContext,
  type TCronSchedulerError,
} from "./index";

function expectCreated(result: TCronJob | TCronSchedulerError) {
  if ("error" in result) {
    throw new Error(String(result.error));
  }

  return result;
}

async function getRow(id: number) {
  return DatabaseConnector.instance.database
    .select()
    .from(cronEngineJobsTable)
    .where(eq(cronEngineJobsTable.id, id))
    .get();
}

describe("CronScheduler automationIds", () => {
  let scheduler: CronScheduler;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    scheduler = new CronScheduler({});
  });

  afterEach(() => {
    scheduler.destroy();
  });

  test("persists automationIds alone and emits them on fire", async () => {
    const job = expectCreated(
      await scheduler.createRecurring({
        name: "raw",
        scope: "scope-a",
        pattern: "0 8 * * *",
        automationIds: [3, 1],
      }),
    );

    expect(job.automationIds).toEqual([3, 1]);
    expect((await getRow(job.id))?.automationIds).toBe("[3,1]");

    await DatabaseConnector.instance.database
      .update(cronEngineJobsTable)
      .set({ nextRunAt: Date.now() - 1_000 })
      .where(eq(cronEngineJobsTable.id, job.id));

    const fired = new Promise<TCronJobContext>((resolve) => {
      scheduler.onFire(resolve);
    });
    await (scheduler as unknown as { fire: (id: number) => Promise<void> }).fire(job.id);

    expect((await fired).automationIds).toEqual([3, 1]);
  });

  test("allows automationIds with taskPrompt and stores empty list as null", async () => {
    const withTask = expectCreated(
      await scheduler.createOnce({
        name: "task",
        scope: "scope-a",
        fireAt: new Date(Date.now() + 60_000),
        taskPrompt: "Summarize.",
        taskFallbackText: "Nothing.",
        automationIds: [1],
      }),
    );
    expect(withTask.automationIds).toEqual([1]);

    const plain = expectCreated(
      await scheduler.createRecurring({
        name: "plain",
        scope: "scope-a",
        pattern: "0 8 * * *",
        reminderText: "Hi",
        automationIds: [],
      }),
    );
    expect(plain.automationIds).toEqual([]);
    expect((await getRow(plain.id))?.automationIds).toBeNull();
  });

  test("rejects automationIds combined with reminderText or reminderPromptData", () => {
    const base = { name: "invalid", pattern: "0 8 * * *" };
    const withText = SCreateRecurringArgs.safeParse({
      ...base,
      reminderText: "Hi",
      automationIds: [1],
    });
    expect(withText.success).toBe(false);
    if (!withText.success) {
      expect(withText.error.message).toContain(
        "automationIds can only be combined with taskPrompt",
      );
    }

    const withPromptData = SCreateRecurringArgs.safeParse({
      ...base,
      reminderPromptData: "{}",
      reminderFallbackText: "Hi",
      automationIds: [1],
    });
    expect(withPromptData.success).toBe(false);
  });

  test("corrupt automationIds column parses as empty list", async () => {
    const job = expectCreated(
      await scheduler.createRecurring({
        name: "corrupt",
        scope: "scope-a",
        pattern: "0 8 * * *",
        taskPrompt: "Summarize.",
        taskFallbackText: "Nothing.",
      }),
    );

    await DatabaseConnector.instance.database
      .update(cronEngineJobsTable)
      .set({ automationIds: "{not json" })
      .where(eq(cronEngineJobsTable.id, job.id));

    expect((await scheduler.get("corrupt", "scope-a"))?.automationIds).toEqual([]);
  });

  test("removeAutomation updates jobs and cancels emptied ones within scope", async () => {
    const rawOnly = expectCreated(
      await scheduler.createRecurring({
        name: "raw-only",
        scope: "scope-a",
        pattern: "0 8 * * *",
        automationIds: [7],
      }),
    );
    const rawMulti = expectCreated(
      await scheduler.createRecurring({
        name: "raw-multi",
        scope: "scope-a",
        pattern: "0 8 * * *",
        automationIds: [7, 8],
      }),
    );
    const withTask = expectCreated(
      await scheduler.createRecurring({
        name: "with-task",
        scope: "scope-a",
        pattern: "0 8 * * *",
        taskPrompt: "Summarize.",
        taskFallbackText: "Nothing.",
        automationIds: [7],
      }),
    );
    const otherScope = expectCreated(
      await scheduler.createRecurring({
        name: "other-scope",
        scope: "scope-b",
        pattern: "0 8 * * *",
        automationIds: [7],
      }),
    );

    const result = await scheduler.removeAutomation("scope-a", 7);

    expect(result.cancelledJobs).toEqual(["raw-only"]);
    expect(result.updatedJobs.sort()).toEqual(["raw-multi", "with-task"]);

    const cancelledRow = await getRow(rawOnly.id);
    expect(cancelledRow?.status).toBe(ECronJobStatus.Cancelled);
    expect(cancelledRow?.finishedReason).toBe(ECronFinishedReason.Unscheduled);
    expect(cancelledRow?.finishedAt).not.toBeNull();
    expect((scheduler as unknown as { timers: Map<number, unknown> }).timers.has(rawOnly.id)).toBe(
      false,
    );

    expect((await getRow(rawMulti.id))?.automationIds).toBe("[8]");
    expect((await getRow(withTask.id))?.automationIds).toBeNull();
    expect((await getRow(otherScope.id))?.automationIds).toBe("[7]");
  });
});
