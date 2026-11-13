import { describe, expect, mock, test } from "bun:test";
import { CommandRejectedError } from "../../../events";
import { ERejectionCode } from "../../../events/catalog";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { unscheduleCronJob } from ".";

const context = {
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  events: testEventRequester,
  verifySettings: mock(async () => undefined),
  runScheduledTask: mock(async () => {
    throw new Error("not used");
  }),
};

describe("unschedule-cron-job", () => {
  test("returns rejections as model-visible tool errors with a stable code", async () => {
    const tool = unscheduleCronJob.createAgentTool({
      ...context,
      events: {
        ...testEventRequester,
        request: async () => {
          throw new CommandRejectedError(
            ERejectionCode.Failed,
            "cancel failed: No job found with name: daily",
            "job-not-found",
          );
        },
      },
    });

    await expect(tool.execute("call", { name: "daily" })).resolves.toEqual({
      content: [{ type: "text", text: "cancel failed: No job found with name: daily" }],
      details: { errorCode: "job-not-found" },
      isError: true,
    });
  });
});
