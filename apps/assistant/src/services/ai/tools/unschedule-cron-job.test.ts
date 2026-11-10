import { afterEach, describe, expect, mock, test } from "bun:test";
import { CronScheduler } from "../../cron";
import { CronSchedulerError } from "../../cron/types";
import { DefaultConfigRecord } from "../../settings/schema";
import { unscheduleCronJob } from "./unschedule-cron-job";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  verifySettings: mock(async () => undefined),
};

afterEach(() => {
  (CronScheduler as unknown as { _instance: unknown })._instance = undefined;
});

describe("unschedule-cron-job", () => {
  test("returns service failures as model-visible tool errors with a stable code", async () => {
    (CronScheduler as unknown as { _instance: unknown })._instance = {
      cancel: mock(async () => {
        throw new CronSchedulerError("job-not-found", "cancel", "No job found with name: daily");
      }),
    };
    const tool = unscheduleCronJob.createAgentTool(context);

    await expect(tool.execute("call", { name: "daily" })).resolves.toEqual({
      content: [{ type: "text", text: "cancel failed: No job found with name: daily" }],
      details: { errorCode: "job-not-found" },
      isError: true,
    });
  });
});
