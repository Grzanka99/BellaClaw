import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DatabaseConnector } from "../database";
import { cronEngineJobsTable, eventsTable } from "../database/schema";
import { resetCronEngineJobsTable, resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { EEventType, type TCronFiredPayload } from "../events/catalog";
import { CronScheduler } from "./index";
import { createOnce, createRecurring } from "./test-utils";
import { ECronFinishedReason, ECronJobStatus } from "./types";

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

  test("persists an automations-only job and emits its automationIds on fire", async () => {
    const job = await createRecurring({
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

    await (scheduler as unknown as { fire: (id: number) => Promise<void> }).fire(job.id);

    const fired = await DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.CronFired))
      .get();
    const context = fired?.payload as TCronFiredPayload;
    expect(context.automationIds).toEqual([3, 1]);
    expect(context.content).toEqual({ kind: "automations" });
  });

  test("allows automationIds with a task and stores an empty list as null", async () => {
    const withTask = await createOnce({
      name: "task",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
      content: { kind: "task", prompt: "Summarize.", fallback: "Nothing." },
      automationIds: [1],
    });
    expect(withTask.automationIds).toEqual([1]);

    const plain = await createRecurring({
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
      createRecurring({
        name: "invalid",
        scope: "scope-a",
        pattern: "0 8 * * *",
        content: { kind: "text", text: "Hi" },
        automationIds: [1],
      }),
    ).rejects.toMatchObject({ errorCode: "automations-without-task" });
    await expect(
      createRecurring({
        name: "invalid",
        scope: "scope-a",
        pattern: "0 8 * * *",
        content: { kind: "generated", promptData: "{}", fallback: "Hi" },
        automationIds: [1],
      }),
    ).rejects.toMatchObject({ errorCode: "automations-without-task" });
    await expect(
      createRecurring({
        name: "invalid",
        scope: "scope-a",
        pattern: "0 8 * * *",
        content: { kind: "automations" },
      }),
    ).rejects.toMatchObject({ errorCode: "missing-automations" });

    expect(await scheduler.get("invalid", "scope-a")).toBeUndefined();
  });

  test("automation.deleted updates jobs and cancels emptied ones within scope", async () => {
    const rawOnly = await createRecurring({
      name: "raw-only",
      scope: "scope-a",
      pattern: "0 8 * * *",
      content: { kind: "automations" },
      automationIds: [7],
    });
    const rawMulti = await createRecurring({
      name: "raw-multi",
      scope: "scope-a",
      pattern: "0 8 * * *",
      content: { kind: "automations" },
      automationIds: [7, 8],
    });
    const withTask = await createRecurring({
      name: "with-task",
      scope: "scope-a",
      pattern: "0 8 * * *",
      content: { kind: "task", prompt: "Summarize.", fallback: "Nothing." },
      automationIds: [7],
    });
    const otherScope = await createRecurring({
      name: "other-scope",
      scope: "scope-b",
      pattern: "0 8 * * *",
      content: { kind: "automations" },
      automationIds: [7],
    });

    await EventBus.instance.publish({
      type: EEventType.AutomationDeleted,
      source: "automations",
      key: "scope-a",
      trace: { turnId: "test:automation-deleted", chatId: undefined, platform: undefined },
      payload: { scope: "scope-a", automationId: 7, name: "seven" },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await EventBus.instance.idle();
    const [detached] = await DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.CronAutomationDetached));

    expect(detached?.payload).toMatchObject({ automationId: 7, cancelledJobs: ["raw-only"] });
    expect(
      (detached?.payload as { updatedJobs: string[] } | undefined)?.updatedJobs.sort(),
    ).toEqual(["raw-multi", "with-task"]);

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
