import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ERole } from "../ai/types";
import { Memory } from "../memory";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { MessageHandler } from "./index";

type TAiConnectorInternals = {
  ai: {
    runAssistantToolLoop: typeof import("../ai/api").AiConnector.prototype.runAssistantToolLoop;
    runToolTask: typeof import("../ai/api").AiConnector.prototype.runToolTask;
  };
  memory: {
    findRecent: typeof import("../memory").Memory.prototype.findRecent;
    save: typeof import("../memory").Memory.prototype.save;
  };
};

function resetMemoryInstance() {
  const MemoryWithPrivate = Memory as unknown as {
    _instance: unknown;
  };
  MemoryWithPrivate._instance = undefined;
}

function resetSettingsInstance() {
  const SettingsServiceStatic = SettingsService as unknown as { _instance: unknown };
  SettingsServiceStatic._instance = undefined;
}

const OWNER_TIMEZONE = "America/New_York";

function mockSettingsService() {
  const record = {
    ...DefaultConfigRecord,
    [EConfigKey.AiInstructionsTimezone]: OWNER_TIMEZONE,
  };
  const SettingsServiceStatic = SettingsService as unknown as { _instance: unknown };
  SettingsServiceStatic._instance = {
    getAll: mock(async () => record),
  };
}

describe("MessageHandler current time context", () => {
  beforeEach(() => {
    resetMemoryInstance();
    resetSettingsInstance();
    mockSettingsService();
  });

  afterEach(() => {
    (MessageHandler as unknown as { _instances: Map<string, MessageHandler> })._instances.clear();
    resetMemoryInstance();
    resetSettingsInstance();
  });

  test("passes current time context into assistant tool loop", async () => {
    let capturedCurrentTimeContext: string | undefined;
    const handler = MessageHandler.getInstance("test-chat-id");
    const internals = handler as unknown as TAiConnectorInternals;

    internals.memory = {
      findRecent: mock(async () => ({ success: true, data: [] })),
      save: mock(async () => ({
        chatId: "test-chat-id",
        author: ERole.User,
        importance: "low",
        message: "remind me in 2 minutes",
        createdAt: new Date(),
        lastReadAt: new Date(),
      })),
    } as never;

    internals.ai = {
      runToolTask: mock(async () => ({
        assistantResponse: "",
        toolCalls: [],
        toolResults: [],
      })),
      runAssistantToolLoop: mock(async (args: { currentTimeContext?: string }) => {
        capturedCurrentTimeContext = args.currentTimeContext;
        return {
          conversation: [],
          toolActivity: [],
          finalResponse: "test response",
          stopReason: "final-response" as const,
          iterations: 1,
        };
      }),
    } as never;

    await handler.handleMessage({
      chatId: "test-chat-id",
      message: { type: "text", content: "remind me in 2 minutes" },
      author: { type: ERole.User, id: "test-user-id", username: "TestUser" },
    });

    expect(capturedCurrentTimeContext).toStartWith("Current time context:");
    expect(capturedCurrentTimeContext).toContain("UTC:");
    expect(capturedCurrentTimeContext).toContain(`Timezone: ${OWNER_TIMEZONE}`);
    expect(capturedCurrentTimeContext).toContain("Local:");
    expect(capturedCurrentTimeContext).toContain("Weekday:");
  });
});
