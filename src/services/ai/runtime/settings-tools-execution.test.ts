import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetUserConfigsTable } from "../../database/test-utils";
import {
  getMessageHandlerInstructions,
  invalidateMessageHandlerInstructions,
} from "../../message-handler/instructions";
import { SettingsService } from "../../settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../../settings/schema";
import { AiConnector } from "../api";
import { getAiModelIds } from "../providers/registry";
import { GET_SETTINGS_TOOL } from "../tools/get-settings/definition";
import { UPDATE_SETTINGS_TOOL } from "../tools/update-settings/definition";
import { EAiProvider, type EModelPurpose, type TToolCall } from "../types";
import { executeToolCall } from "./tool-execution";

type TSettingsServiceStatic = {
  _instance: unknown;
};

type TAiConnectorStatic = {
  _instance: unknown;
};

function createToolCall(id: string, name: string, toolArguments: unknown): TToolCall {
  return {
    id,
    name,
    arguments: toolArguments,
  };
}

function resetSettingsInstance() {
  const SettingsServiceStatic = SettingsService as unknown as TSettingsServiceStatic;
  SettingsServiceStatic._instance = undefined;
}

function resetAiConnectorInstance() {
  const AiConnectorStatic = AiConnector as unknown as TAiConnectorStatic;
  AiConnectorStatic._instance = undefined;
}

function mockAiSettingsVerification(error: string | undefined) {
  const AiConnectorStatic = AiConnector as unknown as TAiConnectorStatic;
  AiConnectorStatic._instance = {
    verifySettings: mock(async () => error),
  };
}

describe("settings tools execution", () => {
  beforeEach(async () => {
    resetSettingsInstance();
    resetAiConnectorInstance();
    await resetUserConfigsTable();
    invalidateMessageHandlerInstructions();
  });

  afterEach(() => {
    resetSettingsInstance();
    resetAiConnectorInstance();
    invalidateMessageHandlerInstructions();
  });

  describe("get-settings", () => {
    test("returns effective settings for the owner", async () => {
      const chatId = "settings-get-owner";

      const result = await executeToolCall({
        toolCall: createToolCall("get-1", GET_SETTINGS_TOOL, {}),
        chatId,
        allowedToolNames: new Set([GET_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result).toMatchObject({
        toolCallId: "get-1",
        toolName: GET_SETTINGS_TOOL,
        success: true,
      });

      const data = result.data as {
        settings: TConfigRecord;
        aiRuntime: {
          provider: EAiProvider;
          models: Record<EModelPurpose, string>;
        };
      };
      expect(data.settings).toEqual(DefaultConfigRecord);
      expect(data.aiRuntime).toEqual({
        provider: EAiProvider.OpencodeGo,
        models: getAiModelIds(EAiProvider.OpencodeGo),
      });
    });

    test("fails when chatId is missing", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("get-no-chat", GET_SETTINGS_TOOL, {}),
        chatId: undefined,
        allowedToolNames: new Set([GET_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("chatId is required");
    });

    test("fails when not in allowedToolNames", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("get-disallowed", GET_SETTINGS_TOOL, {}),
        chatId: "settings-owner",
        allowedToolNames: new Set(["other-tool"]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool requested");
    });

    test("rejects extra arguments via strict schema", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("get-extra", GET_SETTINGS_TOOL, { foo: "bar" }),
        chatId: "settings-owner",
        allowedToolNames: new Set([GET_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Arguments validation failed");
    });
  });

  describe("update-settings", () => {
    test("updates timezone and returns effective settings", async () => {
      const chatId = "settings-update-tz";

      const result = await executeToolCall({
        toolCall: createToolCall("update-tz", UPDATE_SETTINGS_TOOL, {
          timezone: "America/New_York",
        }),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(true);

      const data = result.data as {
        settings: TConfigRecord;
      };

      expect(data.settings[EConfigKey.AiInstructionsTimezone]).toBe("America/New_York");

      const readBack = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiInstructionsTimezone,
      );
      expect(readBack).toBe("America/New_York");
    });

    test("updates multiple fields in one call", async () => {
      const chatId = "settings-update-multi";

      const result = await executeToolCall({
        toolCall: createToolCall("update-multi", UPDATE_SETTINGS_TOOL, {
          timezone: "Asia/Tokyo",
          language: "English",
          assistantName: "Bella",
        }),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(true);

      const data = result.data as {
        settings: TConfigRecord;
      };

      expect(data.settings[EConfigKey.AiInstructionsTimezone]).toBe("Asia/Tokyo");
      expect(data.settings[EConfigKey.AiInstructionsLanguage]).toBe("English");
      expect(data.settings[EConfigKey.AiInstructionsAssistantName]).toBe("Bella");
    });

    test("updates platform and persists to EConfigKey.AiInstructionsPlatform", async () => {
      const chatId = "settings-update-platform";

      const result = await executeToolCall({
        toolCall: createToolCall("update-platform", UPDATE_SETTINGS_TOOL, {
          platform: "Signal messages",
        }),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(true);

      const data = result.data as {
        settings: TConfigRecord;
      };

      expect(data.settings[EConfigKey.AiInstructionsPlatform]).toBe("Signal messages");

      const readBack = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiInstructionsPlatform,
      );
      expect(readBack).toBe("Signal messages");
    });

    test("rejects empty args with at least-one-field requirement", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("update-empty", UPDATE_SETTINGS_TOOL, {}),
        chatId: "settings-update-empty",
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("at least one field");
    });

    test("rejects unknown extra fields via strict schema", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("update-unknown", UPDATE_SETTINGS_TOOL, {
          timezone: "UTC",
          bogusKey: "value",
        }),
        chatId: "settings-update-unknown",
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Arguments validation failed");
    });

    test("rejects invalid timezone without writing", async () => {
      const chatId = "settings-update-invalid-tz";

      const result = await executeToolCall({
        toolCall: createToolCall("update-bad-tz", UPDATE_SETTINGS_TOOL, {
          timezone: "Not/A_Real_Tz",
        }),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid value for timezone");

      const readBack = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiInstructionsTimezone,
      );
      expect(readBack).toBe(DefaultConfigRecord[EConfigKey.AiInstructionsTimezone]);
    });

    test("rejects invalid aiProvider without writing", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("update-bad-provider", UPDATE_SETTINGS_TOOL, {
          aiProvider: "invalid-provider",
        }),
        chatId: "settings-update-invalid-provider",
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
    });

    test("validates all fields before any write on multi-field invalid request", async () => {
      const chatId = "settings-update-partial-invalid";

      const result = await executeToolCall({
        toolCall: createToolCall("update-partial-bad", UPDATE_SETTINGS_TOOL, {
          timezone: "Not/A_Real_Tz",
          language: "English",
        }),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid value for timezone");

      const languageReadBack = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiInstructionsLanguage,
      );
      expect(languageReadBack).toBe(DefaultConfigRecord[EConfigKey.AiInstructionsLanguage]);
    });

    test("updates aiProvider and persists to EConfigKey.AiProvider", async () => {
      const chatId = "settings-update-provider";
      mockAiSettingsVerification(undefined);

      const result = await executeToolCall({
        toolCall: createToolCall("update-provider", UPDATE_SETTINGS_TOOL, {
          aiProvider: "openrouter",
        }),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(true);

      const readBack = await SettingsService.instance.get(chatId, EConfigKey.AiProvider);
      expect(readBack).toBe("openrouter");
    });

    test("rejects aiProvider when provider verification fails", async () => {
      const chatId = "settings-update-unavailable-provider";
      mockAiSettingsVerification("Provider failed for ChatAccurate: unavailable");

      const result = await executeToolCall({
        toolCall: createToolCall("update-unavailable-provider", UPDATE_SETTINGS_TOOL, {
          aiProvider: "openrouter",
        }),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Provider failed");

      const readBack = await SettingsService.instance.get(chatId, EConfigKey.AiProvider);
      expect(readBack).toBe(DefaultConfigRecord[EConfigKey.AiProvider]);
    });

    test("rejects model update fields", async () => {
      const chatId = "settings-update-model-field";

      const result = await executeToolCall({
        toolCall: createToolCall("update-model-field", UPDATE_SETTINGS_TOOL, {
          opencodeGoChatModel: "glm-5.2",
        }),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unrecognized key");
    });

    test("fails when chatId is missing", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("update-no-chat", UPDATE_SETTINGS_TOOL, { timezone: "UTC" }),
        chatId: undefined,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("chatId is required");
    });

    test("fails when not in allowedToolNames", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("update-disallowed", UPDATE_SETTINGS_TOOL, { timezone: "UTC" }),
        chatId: "settings-owner",
        allowedToolNames: new Set(["other-tool"]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool requested");
    });

    test("invalidates message handler instruction cache after successful update", async () => {
      const originalBunFile = Bun.file;
      let instructionReadCount = 0;

      Bun.file = mock((...args: Parameters<typeof Bun.file>) => {
        const path = args[0];
        let filePath: string | undefined;

        if (typeof path === "string") {
          filePath = path;
        }

        if (filePath?.endsWith("/instructions.xml")) {
          instructionReadCount += 1;
        }

        return originalBunFile(...args);
      }) as unknown as typeof Bun.file;

      try {
        const chatId = "settings-update-invalidate";

        await getMessageHandlerInstructions(chatId, DefaultConfigRecord);
        const readsAfterPrime = instructionReadCount;
        expect(readsAfterPrime).toBeGreaterThan(0);

        const result = await executeToolCall({
          toolCall: createToolCall("update-invalidate", UPDATE_SETTINGS_TOOL, {
            assistantName: "Bella",
          }),
          chatId,
          allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
          settings: DefaultConfigRecord,
        });

        expect(result.success).toBe(true);

        await getMessageHandlerInstructions(chatId, DefaultConfigRecord);

        expect(instructionReadCount).toBeGreaterThan(readsAfterPrime);
      } finally {
        Bun.file = originalBunFile;
      }
    });
  });
});
