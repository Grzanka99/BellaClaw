import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AutomationService } from "../../../automation";
import { CronScheduler } from "../../../cron";
import { resetAutomationsTables, resetCronEngineJobsTable } from "../../../database/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { automationDelete } from ".";

const tool = automationDelete.createAgentTool({
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  verifySettings: mock(async () => undefined),
  runScheduledTask: mock(async () => {
    throw new Error("not used");
  }),
});

async function saveAutomation(name: string) {
  const draft = await AutomationService.instance.createDraft({
    scope: "discord:1",
    name,
    source: "export default async () => ({ kind: 'silent' })",
    config: {},
    allowedOrigins: [],
  });

  return AutomationService.instance.saveDraft("discord:1", draft.id);
}

describe("automation-delete", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    CronScheduler.instance.destroy();
  });

  test("reports the cron jobs that lost the automation", async () => {
    const automation = await saveAutomation("weather");
    const keep = await saveAutomation("keep");
    await CronScheduler.instance.createRecurring({
      name: "raw-only",
      scope: "discord:1",
      pattern: "0 8 * * *",
      content: { kind: "automations" },
      automationIds: [automation.id],
    });
    await CronScheduler.instance.createRecurring({
      name: "briefing",
      scope: "discord:1",
      pattern: "0 7 * * *",
      content: { kind: "task", prompt: "Morning briefing", fallback: "Good morning" },
      automationIds: [automation.id, keep.id],
    });

    const result = await tool.execute("call", { name: "weather" });

    expect(result.details).toEqual({
      name: "weather",
      updatedJobs: ["briefing"],
      cancelledJobs: ["raw-only"],
    });
    await expect(tool.execute("call", { name: "weather" })).resolves.toMatchObject({
      details: { errorCode: "automation-not-found" },
      isError: true,
    });
  });
});
