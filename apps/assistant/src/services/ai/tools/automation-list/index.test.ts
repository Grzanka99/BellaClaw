import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AutomationService } from "../../../automation";
import { CronScheduler } from "../../../cron";
import { DatabaseConnector } from "../../../database";
import {
  resetAutomationsTables,
  resetCronEngineJobsTable,
  resetEventTables,
} from "../../../database/test-utils";
import { EventBus } from "../../../events";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { automationList } from ".";

const trace = { turnId: "test", chatId: undefined, platform: undefined };

function createTool(chatId: string) {
  return automationList.createAgentTool({
    chatId,
    settings: DefaultConfigRecord,
    trace,
    events: testEventRequester,
    verifySettings: mock(async () => undefined),
    runScheduledTask: mock(async () => {
      throw new Error("not used");
    }),
  });
}

describe("automation-list", () => {
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

  test("lists automations of the chat without source or config", async () => {
    const draft = await AutomationService.instance.createDraft(
      DatabaseConnector.instance.database,
      {
        scope: "discord:1",
        name: "weather",
        source: "export default async () => ({ kind: 'silent' })",
        config: { city: "Warsaw" },
        allowedOrigins: [],
      },
    );
    await AutomationService.instance.saveDraft(
      DatabaseConnector.instance.database,
      "discord:1",
      draft.id,
    );

    const result = (await createTool("discord:1").execute("call", {})).details as Array<
      Record<string, unknown>
    >;

    expect(result.map((automation) => automation.name)).toEqual(["weather"]);
    expect(result[0]).not.toHaveProperty("source");
    expect(result[0]).not.toHaveProperty("config");
    expect((await createTool("discord:2").execute("call", {})).details).toEqual([]);
  });
});
