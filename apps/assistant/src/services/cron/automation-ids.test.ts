import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { cronEngineJobsTable } from "../database/schema";
import { resetCronEngineJobsTable } from "../database/test-utils";
import { CronScheduler } from "./index";
import { ECronFinishedReason, ECronJobStatus, type TCronJobContext } from "./types";

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

  test("persists an automations-only job and emits its automationIds on fire", async () => {
    const job = await scheduler.createRecurring({
      name: "raw",
      scope: "scope-a",
      pattern: "0 8 * * *",
      content: { kind: "automations" },
      automationIds: [3, 1],
    });

    expect(job.content).toEqual({ kind: "automations" });
    expect(job.automationIds).toEqual([3, 1]);
    const row = await getRow(job.id);
    expect(row?.contentKind).toBe("automations");
    expect(row?.contentBody).toBe("");
    expect(row?.contentFallback).toBeNull();
    expect(row?.automationIds).toEqual([3, 1]);

    await DatabaseConnector.instance.database
      .update(cronEngineJobsTable)
      .set({ nextRunAt: new Date(Date.now() - 1_000) })
      .where(eq(cronEngineJobsTable.id, job.id));

    const fired = new Promise<TCronJobContext>((resolve) => {
      scheduler.onFire(resolve);
    });
    await (scheduler as unknown as { fire: (id: number) => Promise<void> }).fire(job.id);

    const context = await fired;
    expect(context.automationIds).toEqual([3, 1]);
    expect(context.content).toEqual({ kind: "automations" });
  });

  test("allows automationIds with a task and stores an empty list as null", async () => {
    const withTask = await scheduler.createOnce({
      name: "task",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
      content: { kind: "task", prompt: "Summarize.", fallback: "Nothing." },
      automationIds: [1],
    });
    expect(withTask.automationIds).toEqual([1]);

    const plain = await scheduler.createRecurring({
      name: "plain",
      scope: "scope-a",
      pattern: "0 8 * * *",
      content: { kind: "text", text: "Hi" },
      automationIds: [],
    });
    expect(plain.automationIds).toEqual([]);
    expect((await getRow(plain.id))?.automationIds).toBeNull();
  });

  test("rejects automationIds with reminders and automations content without ids", async () => {
    await expect(
      scheduler.createRecurring({
        name: "invalid",
        scope: "scope-a",
        pattern: "0 8 * * *",
        content: { kind: "text", text: "Hi" },
        automationIds: [1],
      }),
    ).rejects.toMatchObject({ code: "automations-without-task" });
    await expect(
      scheduler.createRecurring({
        name: "invalid",
        scope: "scope-a",
        pattern: "0 8 * * *",
        content: { kind: "generated", promptData: "{}", fallback: "Hi" },
        automationIds: [1],
      }),
    ).rejects.toMatchObject({ code: "automations-without-task" });
    await expect(
      scheduler.createRecurring({
        name: "invalid",
        scope: "scope-a",
        pattern: "0 8 * * *",
        content: { kind: "automations" },
      }),
    ).rejects.toMatchObject({ code: "missing-automations" });

    expect(await scheduler.get("invalid", "scope-a")).toBeUndefined();
  });

  test("removeAutomation updates jobs and cancels emptied ones within scope", async () => {
    const rawOnly = await scheduler.createRecurring({
      name: "raw-only",
      scope: "scope-a",
      pattern: "0 8 * * *",
      content: { kind: "automations" },
      automationIds: [7],
    });
    const rawMulti = await scheduler.createRecurring({
      name: "raw-multi",
      scope: "scope-a",
      pattern: "0 8 * * *",
      content: { kind: "automations" },
      automationIds: [7, 8],
    });
    const withTask = await scheduler.createRecurring({
      name: "with-task",
      scope: "scope-a",
      pattern: "0 8 * * *",
      content: { kind: "task", prompt: "Summarize.", fallback: "Nothing." },
      automationIds: [7],
    });
    const otherScope = await scheduler.createRecurring({
      name: "other-scope",
      scope: "scope-b",
      pattern: "0 8 * * *",
      content: { kind: "automations" },
      automationIds: [7],
    });

    const result = await scheduler.removeAutomation("scope-a", 7);

    expect(result.cancelledJobs.map((job) => job.name)).toEqual(["raw-only"]);
    expect(result.updatedJobs.sort()).toEqual(["raw-multi", "with-task"]);

    const cancelledRow = await getRow(rawOnly.id);
    expect(cancelledRow?.status).toBe(ECronJobStatus.Cancelled);
    expect(cancelledRow?.finishedReason).toBe(ECronFinishedReason.Unscheduled);
    expect(cancelledRow?.finishedAt).not.toBeNull();
    expect((scheduler as unknown as { timers: Map<number, unknown> }).timers.has(rawOnly.id)).toBe(
      false,
    );

    expect((await getRow(rawMulti.id))?.automationIds).toEqual([8]);
    expect((await getRow(withTask.id))?.automationIds).toBeNull();
    expect((await getRow(otherScope.id))?.automationIds).toEqual([7]);
  });
});
