import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EModelPurpose, ERole, type TAssistantToolLoopArgs } from "../ai/api";
import { GET_SETTINGS_TOOL } from "../ai/tools/get-settings/definition";
import { UPDATE_SETTINGS_TOOL } from "../ai/tools/update-settings/definition";
import { Memory } from "../memory";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import { SettingsMessageHandler } from "./index";

type TSettingsMessageHandlerInternals = {
  ai: {
    runAssistantToolLoop: typeof import("../ai/api").AiConnector.prototype.runAssistantToolLoop;
  };
};

type TMemoryStatic = {
  _instance: unknown;
};

const SETTINGS_TOOL_NAMES = [GET_SETTINGS_TOOL, UPDATE_SETTINGS_TOOL];

function resetMemoryInstance() {
  const MemoryWithPrivate = Memory as unknown as TMemoryStatic;
  MemoryWithPrivate._instance = undefined;
}

function mockSettingsService() {
  const SettingsServiceStatic = SettingsService as unknown as { _instance: unknown };
  SettingsServiceStatic._instance = {
    getAll: mock(async () => DefaultConfigRecord),
  };
}

function resetSettingsInstance() {
  const SettingsServiceStatic = SettingsService as unknown as { _instance: unknown };
  SettingsServiceStatic._instance = undefined;
}

describe("SettingsMessageHandler", () => {
  beforeEach(() => {
    resetMemoryInstance();
    resetSettingsInstance();
    mockSettingsService();
  });

  afterEach(() => {
    (
      SettingsMessageHandler as unknown as { _instances: Map<string, SettingsMessageHandler> }
    )._instances.clear();
    resetMemoryInstance();
    resetSettingsInstance();
  });

  test("passes only get-settings and update-settings tools to runAssistantToolLoop", async () => {
    const capturedArgs: TAssistantToolLoopArgs[] = [];

    const handler = SettingsMessageHandler.getInstance("test-settings-chat-id");
    const internals = handler as unknown as TSettingsMessageHandlerInternals;

    internals.ai = {
      runAssistantToolLoop: mock(async (args: TAssistantToolLoopArgs) => {
        capturedArgs.push(args);
        return {
          conversation: [],
          toolActivity: [],
          finalResponse: "Done — timezone is now UTC.",
          stopReason: "final-response" as const,
          iterations: 1,
        };
      }),
    } as never;

    const reply = await handler.handleMessage({
      chatId: "test-settings-chat-id",
      message: { type: "text", content: "change your timezone to UTC" },
      author: { type: ERole.User, id: "test-user-id", username: "TestUser" },
    });

    expect(capturedArgs).toHaveLength(1);
    const args = capturedArgs[0];

    if (args === undefined) {
      throw new Error("Expected captured runAssistantToolLoop args");
    }

    const toolNames = args.tools.map((tool) => tool.definition.function.name);

    expect(toolNames).toHaveLength(2);
    expect(toolNames).toContain(GET_SETTINGS_TOOL);
    expect(toolNames).toContain(UPDATE_SETTINGS_TOOL);

    for (const name of SETTINGS_TOOL_NAMES) {
      expect(toolNames).toContain(name);
    }

    expect(args.purpose).toBe(EModelPurpose.ChatAccurate);
    expect(args.chatId).toBe("test-settings-chat-id");
    expect(args.history[0]?.role).toBe(ERole.System);

    expect(reply).toBe("Done — timezone is now UTC.");
  });

  test("returns fallback when AI produces no final response", async () => {
    const handler = SettingsMessageHandler.getInstance("test-settings-empty-chat-id");
    const internals = handler as unknown as TSettingsMessageHandlerInternals;

    internals.ai = {
      runAssistantToolLoop: mock(async () => ({
        conversation: [],
        toolActivity: [],
        finalResponse: undefined,
        stopReason: "empty-assistant-response" as const,
        iterations: 1,
      })),
    } as never;

    const reply = await handler.handleMessage({
      chatId: "test-settings-empty-chat-id",
      message: { type: "text", content: "change your timezone to UTC" },
      author: { type: ERole.User, id: "test-user-id", username: "TestUser" },
    });

    expect(reply).toBe("Something went wrong.");
  });

  test("does not include any normal assistant tools", async () => {
    const capturedArgs: TAssistantToolLoopArgs[] = [];

    const handler = SettingsMessageHandler.getInstance("test-settings-no-normal-chat-id");
    const internals = handler as unknown as TSettingsMessageHandlerInternals;

    internals.ai = {
      runAssistantToolLoop: mock(async (args: TAssistantToolLoopArgs) => {
        capturedArgs.push(args);
        return {
          conversation: [],
          toolActivity: [],
          finalResponse: "ok",
          stopReason: "final-response" as const,
          iterations: 1,
        };
      }),
    } as never;

    await handler.handleMessage({
      chatId: "test-settings-no-normal-chat-id",
      message: { type: "text", content: "what timezone are you using?" },
      author: { type: ERole.User, id: "test-user-id", username: "TestUser" },
    });

    const toolNames = capturedArgs[0]?.tools.map((tool) => tool.definition.function.name) ?? [];

    const NORMAL_TOOL_NAMES = [
      "search-memory",
      "list-cron-jobs",
      "schedule-once",
      "schedule-recurring",
      "unschedule-cron-job",
      "update-cron-job",
      "web-search",
      "web-fetch",
      "define-message-importance",
      "define-settings-intent",
    ];

    for (const name of NORMAL_TOOL_NAMES) {
      expect(toolNames).not.toContain(name);
    }
  });
});
