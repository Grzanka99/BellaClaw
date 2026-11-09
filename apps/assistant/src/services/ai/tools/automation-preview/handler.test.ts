import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TScriptFetcher } from "../../../../lib/script-sandbox";
import { AutomationService } from "../../../automation";
import { EAutomationRunOutcome } from "../../../automation/runner";
import { CronSingleton } from "../../../cron";
import { resetAutomationsTables, resetCronEngineJobsTable } from "../../../database/test-utils";
import { handleAutomationPreview } from "./handler";

const fetcher: TScriptFetcher = async (url) => ({
  url,
  status: 200,
  contentType: "application/json",
  text: JSON.stringify({ temperature: 21 }),
});
const options = { timezone: "Europe/Warsaw", trace: undefined, fetcher };
const args = {
  name: "weather",
  source: `export default async function run(ctx, host) {
    const json = await host.fetchJson(ctx.config.url);
    host.log("fetched");
    return { kind: "data", data: { temperatureC: json.temperature } };
  }`,
  config: { url: "https://api.example.com/forecast" },
  allowedOrigins: ["https://api.example.com"],
};

describe("handleAutomationPreview", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    CronSingleton.instance.destroy();
  });

  test("returns a previewId with the input and output of a successful run", async () => {
    const result = await handleAutomationPreview("discord:1", args, options);

    expect(result).toEqual({
      success: true,
      previewId: expect.any(Number),
      name: "weather",
      input: {
        allowedOrigins: ["https://api.example.com"],
        config: { url: "https://api.example.com/forecast" },
        outputCapBytes: 16_384,
        fetched: [{ url: "https://api.example.com/forecast", status: 200, bytes: 18 }],
      },
      output: { outcome: EAutomationRunOutcome.Data, text: undefined, data: { temperatureC: 21 } },
      logs: ["fetched"],
    });
    expect(await AutomationService.instance.list("discord:1")).toEqual([]);
  });

  test("returns the error, fetches, and logs without a previewId when the run fails", async () => {
    const result = await handleAutomationPreview(
      "discord:1",
      {
        ...args,
        source: `export default async function run(ctx, host) {
          host.log("before failure");
          throw new Error("no forecast");
        }`,
      },
      options,
    );

    expect(result.success).toBe(false);
    expect("previewId" in result).toBe(false);
    expect(result).toMatchObject({ fetched: [], logs: ["before failure"] });
    if ("error" in result) {
      expect(result.error).toContain("no forecast");
    }
  });
});
