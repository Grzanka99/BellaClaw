import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AutomationService, EAutomationStatus } from "../../../automation";
import { CronSingleton } from "../../../cron";
import { resetAutomationsTables, resetCronEngineJobsTable } from "../../../database/test-utils";
import { handleAutomationSave } from "./handler";

describe("handleAutomationSave", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    CronSingleton.instance.destroy();
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

    const result = await handleAutomationSave("discord:1", { previewId: draft.id });

    expect(result).toEqual({
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
    await expect(handleAutomationSave("discord:2", { previewId: draft.id })).rejects.toThrow(
      "not found",
    );
  });
});
