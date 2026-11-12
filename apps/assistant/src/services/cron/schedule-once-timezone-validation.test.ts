import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetCronEngineJobsTable, resetEventTables } from "../database/test-utils";
import { EventBus } from "../events";
import { CronScheduler } from "./index";
import { createOnce } from "./test-utils";

describe("CronScheduler scheduleOnce timezone validation", () => {
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

  test("rejects invalid one-time job timezones before storing", async () => {
    await expect(
      createOnce({
        name: "invalid-onetime-timezone",
        scope: "scope-a",
        fireAt: new Date(Date.now() + 60_000),
        timezone: "Not/A_Timezone",
        content: { kind: "text", text: "Hi." },
      }),
    ).rejects.toMatchObject({
      errorCode: "create-failed",
      message: "create failed: Error: Invalid timezone: Not/A_Timezone",
    });

    const job = await engine.get("invalid-onetime-timezone", "scope-a");
    expect(job).toBeUndefined();
  });
});
