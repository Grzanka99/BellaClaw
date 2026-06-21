import { afterEach, describe, expect, mock, test } from "bun:test";
import { ERole, type TAssistantToolLoopArgs } from "../ai/api";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../settings/schema";
import { SettingsMessageHandler } from "./index";

type TSettingsMessageHandlerInternals = {
  ai: {
    runAssistantToolLoop: typeof import("../ai/api").AiConnector.prototype.runAssistantToolLoop;
  };
};

function resetSettingsHandlerInstances() {
  (
    SettingsMessageHandler as unknown as { _instances: Map<string, SettingsMessageHandler> }
  )._instances.clear();
}

function resetSettingsInstance() {
  const SettingsServiceStatic = SettingsService as unknown as { _instance: unknown };
  SettingsServiceStatic._instance = undefined;
}

describe("SettingsMessageHandler runtime settings", () => {
  afterEach(() => {
    resetSettingsHandlerInstances();
    resetSettingsInstance();
  });

  test("passes stored settings through to the runtime", async () => {
    const storedSettings: TConfigRecord = {
      ...DefaultConfigRecord,
      [EConfigKey.AiInstructionsLanguage]: "Klingon",
      [EConfigKey.AiProvidersOpencodeGoModelsChat]: "bad-chat-model",
      [EConfigKey.AiProvidersOpencodeGoModelsChatAccurate]: "bad-chat-accurate-model",
    };

    const SettingsServiceStatic = SettingsService as unknown as { _instance: unknown };
    SettingsServiceStatic._instance = {
      getAll: mock(async () => storedSettings),
    };

    const capturedArgs: TAssistantToolLoopArgs[] = [];
    const handler = SettingsMessageHandler.getInstance("test-settings-runtime-chat-id");
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
      chatId: "test-settings-runtime-chat-id",
      message: { type: "text", content: "fix your model" },
      author: { type: ERole.User, id: "test-user-id", username: "TestUser" },
    });

    const args = capturedArgs[0];

    if (args === undefined) {
      throw new Error("Expected captured runAssistantToolLoop args");
    }

    expect(args.settings[EConfigKey.AiProvider]).toBe(DefaultConfigRecord[EConfigKey.AiProvider]);
    expect(args.settings[EConfigKey.AiProvidersOpencodeGoModelsChat]).toBe("bad-chat-model");
    expect(args.settings[EConfigKey.AiProvidersOpencodeGoModelsChatAccurate]).toBe(
      "bad-chat-accurate-model",
    );
    expect(args.settings[EConfigKey.AiInstructionsLanguage]).toBe("Klingon");
    expect(args.history[0]?.content).toContain("Reply in Klingon.");
  });
});
