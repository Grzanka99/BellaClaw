import { afterEach, describe, expect, mock, test } from "bun:test";
import { CronSingleton } from "../../cron";
import { DefaultConfigRecord } from "../../settings/schema";
import { unscheduleCronJob } from "./unschedule-cron-job";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  verifySettings: mock(async () => undefined),
};

afterEach(() => {
  (CronSingleton as unknown as { _instance: unknown })._instance = undefined;
});

describe("unschedule-cron-job", () => {
  test("returns service failures as model-visible tool errors with a stable code", async () => {
    (CronSingleton as unknown as { _instance: unknown })._instance = {
      cancel: mock(async () => ({ operation: "cancel", error: "database unavailable" })),
    };
    const tool = unscheduleCronJob.createAgentTool(context);

    await expect(tool.execute("call", { name: "daily" })).resolves.toEqual({
      content: [{ type: "text", text: "cancel failed: database unavailable" }],
      details: { errorCode: "cancel-failed" },
      isError: true,
    });
  });
});
