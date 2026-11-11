import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AutomationService } from "../../../automation";
import { EAutomationRunOutcome } from "../../../automation/runner";
import { CronScheduler } from "../../../cron";
import { resetAutomationsTables, resetCronEngineJobsTable } from "../../../database/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { automationPreview } from ".";

const tool = automationPreview.createAgentTool({
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  verifySettings: mock(async () => undefined),
});
const args = {
  name: "weather",
  source: `export default async function run(ctx, host) {
    host.log("computed");
    return { kind: "data", data: { temperatureC: ctx.config.temperature } };
  }`,
  config: { temperature: 21 },
  allowedOrigins: [],
};

describe("automation-preview", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    CronScheduler.instance.destroy();
  });

  test("returns a previewId with the input and output of a successful run", async () => {
    const result = await tool.execute("call", args);

    expect(result.details).toEqual({
      success: true,
      previewId: expect.any(Number),
      name: "weather",
      input: {
        allowedOrigins: [],
        config: { temperature: 21 },
        outputCapBytes: 16_384,
        fetched: [],
      },
      output: { outcome: EAutomationRunOutcome.Data, text: undefined, data: { temperatureC: 21 } },
      logs: ["computed"],
    });
    expect(await AutomationService.instance.list("discord:1")).toEqual([]);
  });

  test("returns the error and logs without a previewId and deletes the draft on failure", async () => {
    const result = await tool.execute("call", {
      ...args,
      source: `export default async function run(ctx, host) {
        host.log("before failure");
        throw new Error("no forecast");
      }`,
    });
    const details = result.details as Record<string, unknown>;

    expect(details.success).toBe(false);
    expect(details).not.toHaveProperty("previewId");
    expect(details).toMatchObject({ fetched: [], logs: ["before failure"] });
    expect(String(details.error)).toContain("no forecast");
    expect(await AutomationService.instance.getDraft("discord:1", 1)).toBeUndefined();
  });

  test("returns invalid drafts as tool errors with a stable code", async () => {
    const result = await tool.execute("call", { ...args, allowedOrigins: ["ftp://example.com"] });

    expect(result.details).toEqual({ errorCode: "invalid-automation" });
    expect(result.isError).toBe(true);
  });
});
