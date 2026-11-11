import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AutomationService, EAutomationStatus } from "../../../automation";
import { CronScheduler } from "../../../cron";
import { resetAutomationsTables, resetCronEngineJobsTable } from "../../../database/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { automationSave } from ".";

function createTool(chatId: string) {
  return automationSave.createAgentTool({
    chatId,
    settings: DefaultConfigRecord,
    trace: { turnId: "test", chatId: undefined, platform: undefined },
    verifySettings: mock(async () => undefined),
  });
}

describe("automation-save", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    CronScheduler.instance.destroy();
  });

  test("saves the previewed draft and returns a summary without source", async () => {
    const draft = await AutomationService.instance.createDraft({
      scope: "discord:1",
      name: "weather",
      instructions: "Celsius",
      source: "export default async () => ({ kind: 'silent' })",
      config: { city: "Warsaw" },
      allowedOrigins: ["https://api.example.com"],
    });

    const result = await createTool("discord:1").execute("call", { previewId: draft.id });

    expect(result.details).toEqual({
      name: "weather",
      status: EAutomationStatus.Active,
      failureCount: 0,
      lastError: undefined,
      allowedOrigins: ["https://api.example.com"],
      instructions: "Celsius",
      outputCapBytes: 16_384,
    });
    expect((await AutomationService.instance.get("discord:1", "weather"))?.source).toBe(
      draft.source,
    );
    await expect(
      createTool("discord:2").execute("call", { previewId: draft.id }),
    ).resolves.toMatchObject({ details: { errorCode: "draft-not-found" }, isError: true });
  });
});
