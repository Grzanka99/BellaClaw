import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AutomationService } from "../../../automation";
import { CronSingleton } from "../../../cron";
import { resetAutomationsTables, resetCronEngineJobsTable } from "../../../database/test-utils";
import { handleAutomationGet } from "./handler";

const source = "export default async () => ({ kind: 'silent' })";

describe("handleAutomationGet", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
    const draft = await AutomationService.instance.createDraft({
      scope: "discord:1",
      name: "weather",
      source,
      config: { city: "Warsaw" },
      allowedOrigins: [],
    });
    await AutomationService.instance.saveDraft("discord:1", draft.id);
  });

  afterEach(() => {
    CronSingleton.instance.destroy();
  });

  test("returns details and includes source only on request", async () => {
    const withoutSource = await handleAutomationGet("discord:1", { name: "weather" });
    const withSource = await handleAutomationGet("discord:1", {
      name: "weather",
      includeSource: true,
    });

    expect(withoutSource.config).toEqual({ city: "Warsaw" });
    expect(withoutSource.source).toBeUndefined();
    expect(withSource.source).toBe(source);
    await expect(handleAutomationGet("discord:1", { name: "missing" })).rejects.toThrow(
      "not found",
    );
  });
});
