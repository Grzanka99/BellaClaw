import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AutomationService } from "../../../automation";
import { CronScheduler } from "../../../cron";
import { resetAutomationsTables, resetCronEngineJobsTable } from "../../../database/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { automationList } from ".";

const trace = { turnId: "test", chatId: undefined, platform: undefined };

function createTool(chatId: string) {
  return automationList.createAgentTool({
    chatId,
    settings: DefaultConfigRecord,
    trace,
    verifySettings: mock(async () => undefined),
  });
}

describe("automation-list", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    CronScheduler.instance.destroy();
  });

  test("lists automations of the chat without source or config", async () => {
    const draft = await AutomationService.instance.createDraft({
      scope: "discord:1",
      name: "weather",
      source: "export default async () => ({ kind: 'silent' })",
      config: { city: "Warsaw" },
      allowedOrigins: [],
    });
    await AutomationService.instance.saveDraft("discord:1", draft.id);

    const result = (await createTool("discord:1").execute("call", {})).details as Array<
      Record<string, unknown>
    >;

    expect(result.map((automation) => automation.name)).toEqual(["weather"]);
    expect(result[0]).not.toHaveProperty("source");
    expect(result[0]).not.toHaveProperty("config");
    expect((await createTool("discord:2").execute("call", {})).details).toEqual([]);
  });
});
