import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AutomationService } from "../../../automation";
import { EAutomationRunOutcome } from "../../../automation/runner";
import { resetAutomationsTables, resetEventTables } from "../../../database/test-utils";
import { EventBus } from "../../../events";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { automationPreview } from ".";

const tool = automationPreview.createAgentTool({
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  events: testEventRequester,
  verifySettings: mock(async () => undefined),
  runScheduledTask: mock(async () => {
    throw new Error("not used");
  }),
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
    await resetEventTables();
    Object.assign(EventBus, { _instance: undefined });
    AutomationService.instance.setup();
    await EventBus.instance.start();
  });

  afterEach(async () => {
    await EventBus.instance.idle();
    await EventBus.instance.stop();
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
