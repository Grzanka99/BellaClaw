import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AutomationService } from "../../../automation";
import { CronSingleton } from "../../../cron";
import { resetAutomationsTables, resetCronEngineJobsTable } from "../../../database/test-utils";
import { handleAutomationList } from "./handler";

describe("handleAutomationList", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    CronSingleton.instance.destroy();
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

    const result = await handleAutomationList("discord:1");

    expect(result.map((automation) => automation.name)).toEqual(["weather"]);
    expect(result[0]).not.toHaveProperty("source");
    expect(result[0]).not.toHaveProperty("config");
    expect(await handleAutomationList("discord:2")).toEqual([]);
  });
});
