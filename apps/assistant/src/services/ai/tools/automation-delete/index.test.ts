import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AutomationService } from "../../../automation";
import { CronScheduler } from "../../../cron";
import { createRecurring } from "../../../cron/test-utils";
import { DatabaseConnector } from "../../../database";
import {
  resetAutomationsTables,
  resetCronEngineJobsTable,
  resetEventTables,
} from "../../../database/test-utils";
import { EventBus } from "../../../events";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { automationDelete } from ".";

const tool = automationDelete.createAgentTool({
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  events: testEventRequester,
  verifySettings: mock(async () => undefined),
  runScheduledTask: mock(async () => {
    throw new Error("not used");
  }),
});

async function saveAutomation(name: string) {
  const draft = await AutomationService.instance.createDraft(DatabaseConnector.instance.database, {
    scope: "discord:1",
    name,
    source: "export default async () => ({ kind: 'silent' })",
    config: {},
    allowedOrigins: [],
  });

  return AutomationService.instance.saveDraft(
    DatabaseConnector.instance.database,
    "discord:1",
    draft.id,
  );
}

describe("automation-delete", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
    await resetEventTables();
    Object.assign(EventBus, { _instance: undefined });
    CronScheduler.instance.subscribe();
    AutomationService.instance.setup();
    await EventBus.instance.start();
  });

  afterEach(async () => {
    CronScheduler.instance.destroy();
    await EventBus.instance.idle();
    await EventBus.instance.stop();
  });

  test("reports the cron jobs that lost the automation", async () => {
    const automation = await saveAutomation("weather");
    const keep = await saveAutomation("keep");
    await createRecurring({
      name: "raw-only",
      scope: "discord:1",
      pattern: "0 8 * * *",
      content: { kind: "automations" },
      automationIds: [automation.id],
    });
    await createRecurring({
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
