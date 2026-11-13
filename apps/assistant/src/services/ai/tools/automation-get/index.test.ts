import { beforeEach, describe, expect, mock, test } from "bun:test";
import { AutomationService } from "../../../automation";
import { DatabaseConnector } from "../../../database";
import { resetAutomationsTables } from "../../../database/test-utils";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { automationGet } from ".";

const source = "export default async () => ({ kind: 'silent' })";
const tool = automationGet.createAgentTool({
  chatId: "discord:1",
  settings: DefaultConfigRecord,
  trace: { turnId: "test", chatId: undefined, platform: undefined },
  events: testEventRequester,
  verifySettings: mock(async () => undefined),
  runScheduledTask: mock(async () => {
    throw new Error("not used");
  }),
});

describe("automation-get", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    const draft = await AutomationService.instance.createDraft(
      DatabaseConnector.instance.database,
      {
        scope: "discord:1",
        name: "weather",
        source,
        config: { city: "Warsaw" },
        allowedOrigins: [],
      },
    );
    await AutomationService.instance.saveDraft(
      DatabaseConnector.instance.database,
      "discord:1",
      draft.id,
    );
  });

  test("returns details and includes source only on request", async () => {
    const withoutSource = (await tool.execute("call", { name: "weather" })).details as Record<
      string,
      unknown
    >;
    const withSource = (await tool.execute("call", { name: "weather", includeSource: true }))
      .details as Record<string, unknown>;

    expect(withoutSource.config).toEqual({ city: "Warsaw" });
    expect(withoutSource.state).toBeUndefined();
    expect(withoutSource.lastError).toBeUndefined();
    expect(withoutSource.source).toBeUndefined();
    expect(withSource.source).toBe(source);
    await expect(tool.execute("call", { name: "missing" })).resolves.toEqual({
      content: [{ type: "text", text: "Automation 'missing' not found" }],
      details: { errorCode: "automation-not-found" },
      isError: true,
    });
  });
});
