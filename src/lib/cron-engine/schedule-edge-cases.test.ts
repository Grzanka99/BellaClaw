import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import { CronScheduler } from "./index";

describe("CronScheduler schedule edge cases", () => {
  let engine: CronScheduler;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    engine = new CronScheduler({});
  });

  afterEach(() => {
    engine.destroy();
  });

  test("returns a structured error for unschedulable valid cron patterns", async () => {
    const result = await engine.createRecurring({
      name: "impossible-pattern",
      scope: "scope-a",
      pattern: "0 0 31 2 *",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(String(result.error)).toContain("cannot be scheduled");
      expect(String(result.error)).toContain("0 0 31 2 *");
    }

    const storedJob = await engine.get("impossible-pattern", "scope-a");
    expect(storedJob).toBeUndefined();
  });

  test("concurrent recurring schedules allow one success and one duplicate error", async () => {
    const results = await Promise.all([
      engine.createRecurring({
        name: "duplicate-recurring",
        scope: "scope-a",
        pattern: "0 9 * * *",
      }),
      engine.createRecurring({
        name: "duplicate-recurring",
        scope: "scope-a",
        pattern: "0 9 * * *",
      }),
    ]);

    const successfulResults = results.filter((result) => !("error" in result));
    const failedResults = results.filter((result) => "error" in result);

    expect(successfulResults).toHaveLength(1);
    expect(failedResults).toHaveLength(1);
    expect(String(failedResults[0]?.error)).toContain("already exists");

    const jobs = await engine.list("scope-a");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("duplicate-recurring");
  });

  test("concurrent one-time schedules allow one success and one duplicate error", async () => {
    const fireAt = new Date(Date.now() + 60_000);
    const results = await Promise.all([
      engine.createOnce({
        name: "duplicate-onetime",
        scope: "scope-a",
        fireAt: fireAt,
      }),
      engine.createOnce({
        name: "duplicate-onetime",
        scope: "scope-a",
        fireAt: fireAt,
      }),
    ]);

    const successfulResults = results.filter((result) => !("error" in result));
    const failedResults = results.filter((result) => "error" in result);

    expect(successfulResults).toHaveLength(1);
    expect(failedResults).toHaveLength(1);
    expect(String(failedResults[0]?.error)).toContain("already exists");

    const jobs = await engine.list("scope-a");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("duplicate-onetime");
  });
});
