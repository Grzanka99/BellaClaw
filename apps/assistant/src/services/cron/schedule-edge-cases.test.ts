import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetCronEngineJobsTable, resetEventTables } from "../database/test-utils";
import { CommandRejectedError, EventBus } from "../events";
import { CronScheduler } from "./index";
import { createOnce, createRecurring } from "./test-utils";

describe("CronScheduler schedule edge cases", () => {
  let engine: CronScheduler;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    await resetEventTables();
    Object.assign(EventBus, { _instance: undefined });
    engine = new CronScheduler({});
    engine.subscribe();
    await EventBus.instance.start();
  });

  afterEach(async () => {
    engine.destroy();
    await EventBus.instance.idle();
    await EventBus.instance.stop();
  });

  test("throws a coded error for unschedulable valid cron patterns", async () => {
    await expect(
      createRecurring({
        name: "impossible-pattern",
        scope: "scope-a",
        pattern: "0 0 31 2 *",
        content: { kind: "text", text: "Hi." },
      }),
    ).rejects.toMatchObject({
      errorCode: "unschedulable-pattern",
      message: "create failed: Cron pattern '0 0 31 2 *' cannot be scheduled",
    });

    const storedJob = await engine.get("impossible-pattern", "scope-a");
    expect(storedJob).toBeUndefined();
  });

  test("concurrent recurring schedules allow one success and one duplicate error", async () => {
    const results = await Promise.allSettled([
      createRecurring({
        name: "duplicate-recurring",
        scope: "scope-a",
        pattern: "0 9 * * *",
        content: { kind: "text", text: "Hi." },
      }),
      createRecurring({
        name: "duplicate-recurring",
        scope: "scope-a",
        pattern: "0 9 * * *",
        content: { kind: "text", text: "Hi." },
      }),
    ]);

    const successfulResults = results.filter((result) => result.status === "fulfilled");
    const failedResults = results.filter((result) => result.status === "rejected");

    expect(successfulResults).toHaveLength(1);
    expect(failedResults).toHaveLength(1);
    expect(failedResults[0]?.reason).toBeInstanceOf(CommandRejectedError);
    expect(failedResults[0]?.reason).toMatchObject({ errorCode: "job-already-exists" });
    expect(String(failedResults[0]?.reason.message)).toContain("already exists");

    const jobs = await engine.list("scope-a");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("duplicate-recurring");
  });

  test("concurrent one-time schedules allow one success and one duplicate error", async () => {
    const fireAt = new Date(Date.now() + 60_000);
    const results = await Promise.allSettled([
      createOnce({
        name: "duplicate-onetime",
        scope: "scope-a",
        fireAt: fireAt,
        content: { kind: "text", text: "Hi." },
      }),
      createOnce({
        name: "duplicate-onetime",
        scope: "scope-a",
        fireAt: fireAt,
        content: { kind: "text", text: "Hi." },
      }),
    ]);

    const successfulResults = results.filter((result) => result.status === "fulfilled");
    const failedResults = results.filter((result) => result.status === "rejected");

    expect(successfulResults).toHaveLength(1);
    expect(failedResults).toHaveLength(1);
    expect(failedResults[0]?.reason).toBeInstanceOf(CommandRejectedError);
    expect(failedResults[0]?.reason).toMatchObject({ errorCode: "job-already-exists" });
    expect(String(failedResults[0]?.reason.message)).toContain("already exists");

    const jobs = await engine.list("scope-a");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("duplicate-onetime");
  });
});
