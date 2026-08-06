import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import { CronScheduler } from "./index";

describe("CronScheduler scheduleOnce timezone validation", () => {
  let engine: CronScheduler;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    engine = new CronScheduler({});
  });

  afterEach(() => {
    engine.destroy();
  });

  test("rejects invalid one-time job timezones before storing", async () => {
    const result = await engine.createOnce({
      name: "invalid-onetime-timezone",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
      timezone: "Not/A_Timezone",
      reminderText: "Hi.",
    });

    if (!("error" in result)) {
      throw new Error("Expected invalid timezone to fail");
    }

    expect(String(result.error)).toContain("Invalid timezone");

    const job = await engine.get("invalid-onetime-timezone", "scope-a");
    expect(job).toBeUndefined();
  });
});
