import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetCronEngineJobsTable } from "../database/test-utils";
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
    await expect(
      engine.createOnce({
        name: "invalid-onetime-timezone",
        scope: "scope-a",
        fireAt: new Date(Date.now() + 60_000),
        timezone: "Not/A_Timezone",
        content: { kind: "text", text: "Hi." },
      }),
    ).rejects.toMatchObject({
      code: "create-failed",
      message: "Error: Invalid timezone: Not/A_Timezone",
    });

    const job = await engine.get("invalid-onetime-timezone", "scope-a");
    expect(job).toBeUndefined();
  });
});
