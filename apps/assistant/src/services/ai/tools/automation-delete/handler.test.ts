import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AutomationService } from "../../../automation";
import { CronSingleton } from "../../../cron";
import { resetAutomationsTables, resetCronEngineJobsTable } from "../../../database/test-utils";
import { handleAutomationDelete } from "./handler";

describe("handleAutomationDelete", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    CronSingleton.instance.destroy();
  });

  test("reports the cron jobs that lost the automation", async () => {
    const draft = await AutomationService.instance.createDraft({
      scope: "discord:1",
      name: "weather",
      source: "export default async () => ({ kind: 'silent' })",
      config: {},
      allowedOrigins: [],
    });
    const automation = await AutomationService.instance.saveDraft("discord:1", draft.id);
    const keepDraft = await AutomationService.instance.createDraft({
      scope: "discord:1",
      name: "keep",
      source: "export default async () => ({ kind: 'silent' })",
      config: {},
      allowedOrigins: [],
    });
    const keep = await AutomationService.instance.saveDraft("discord:1", keepDraft.id);
    await CronSingleton.instance.createRecurring({
      name: "raw-only",
      scope: "discord:1",
      pattern: "0 8 * * *",
      automationIds: [automation.id],
    });
    await CronSingleton.instance.createRecurring({
      name: "briefing",
      scope: "discord:1",
      pattern: "0 7 * * *",
      automationIds: [automation.id, keep.id],
    });

    const result = await handleAutomationDelete("discord:1", { name: "weather" });

    expect(result).toEqual({
      name: "weather",
      updatedJobs: ["briefing"],
      cancelledJobs: ["raw-only"],
    });
  });
});
