import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetCronEngineJobsTable } from "../../services/database/test-utils";
import { CronEngine } from "./index";

describe("CronEngine scheduleOnce timezone validation", () => {
  let engine: CronEngine;

  beforeEach(async () => {
    await resetCronEngineJobsTable();
    engine = new CronEngine({});
  });

  afterEach(() => {
    engine.destroy();
  });

  test("rejects invalid one-time job timezones before storing", async () => {
    const result = await engine.scheduleOnce({
      name: "invalid-onetime-timezone",
      scope: "scope-a",
      fireAt: new Date(Date.now() + 60_000),
      timezone: "Not/A_Timezone",
      reminderText: "Hi.",
    });

    if (!("error" in result)) {
      throw new Error("Expected invalid timezone to fail");
    }

    expect(result.error).toBe("Invalid timezone: Not/A_Timezone");

    const job = await engine.getJob("invalid-onetime-timezone", "scope-a");
    expect(job).toBeUndefined();
  });
});
