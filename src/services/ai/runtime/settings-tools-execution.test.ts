import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { resetUserConfigsTable } from "../../database/test-utils";
import {
  getMessageHandlerInstructions,
  invalidateMessageHandlerInstructions,
} from "../../message-handler/instructions";
import { SettingsService } from "../../settings";
import { DefaultConfigRecord, EConfigKey, type TConfigRecord } from "../../settings/schema";
import { GET_SETTINGS_TOOL } from "../tools/get-settings/definition";
import { UPDATE_SETTINGS_TOOL } from "../tools/update-settings/definition";
import { executeToolCall } from "./tool-execution";

type TSettingsServiceStatic = {
  _instance: unknown;
};

function createToolCall(id: string, name: string, argumentsText: string): ChatMessageToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: argumentsText,
    },
  };
}

function resetSettingsInstance() {
  const SettingsServiceStatic = SettingsService as unknown as TSettingsServiceStatic;
  SettingsServiceStatic._instance = undefined;
}

describe("settings tools execution", () => {
  beforeEach(async () => {
    resetSettingsInstance();
    await resetUserConfigsTable();
    invalidateMessageHandlerInstructions();
  });

  afterEach(() => {
    resetSettingsInstance();
    invalidateMessageHandlerInstructions();
  });

  describe("get-settings", () => {
    test("returns effective settings for the owner", async () => {
      const chatId = "settings-get-owner";

      const result = await executeToolCall({
        toolCall: createToolCall("get-1", GET_SETTINGS_TOOL, "{}"),
        chatId,
        allowedToolNames: new Set([GET_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result).toMatchObject({
        toolCallId: "get-1",
        toolName: GET_SETTINGS_TOOL,
        success: true,
      });

      const data = result.data as { settings: TConfigRecord };
      expect(data.settings).toEqual(DefaultConfigRecord);
    });

    test("fails when chatId is missing", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("get-no-chat", GET_SETTINGS_TOOL, "{}"),
        chatId: undefined,
        allowedToolNames: new Set([GET_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("chatId is required");
    });

    test("fails when not in allowedToolNames", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("get-disallowed", GET_SETTINGS_TOOL, "{}"),
        chatId: "settings-owner",
        allowedToolNames: new Set(["other-tool"]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool requested");
    });

    test("rejects extra arguments via strict schema", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("get-extra", GET_SETTINGS_TOOL, JSON.stringify({ foo: "bar" })),
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
        toolCall: createToolCall(
          "update-tz",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({ timezone: "America/New_York" }),
        ),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(true);

      const data = result.data as {
        updatedFields: Array<{ field: string; key: string; value: string }>;
        settings: TConfigRecord;
      };

      expect(data.updatedFields).toHaveLength(1);
      expect(data.updatedFields[0]).toMatchObject({
        field: "timezone",
        key: EConfigKey.AiInstructionsTimezone,
        value: "America/New_York",
      });
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
        toolCall: createToolCall(
          "update-multi",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({
            timezone: "Asia/Tokyo",
            language: "English",
            assistantName: "Bella",
          }),
        ),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(true);

      const data = result.data as {
        updatedFields: Array<{ field: string; value: string }>;
        settings: TConfigRecord;
      };

      const fields = data.updatedFields.map((f) => f.field);
      expect(fields).toContain("timezone");
      expect(fields).toContain("language");
      expect(fields).toContain("assistantName");

      expect(data.settings[EConfigKey.AiInstructionsTimezone]).toBe("Asia/Tokyo");
      expect(data.settings[EConfigKey.AiInstructionsLanguage]).toBe("English");
      expect(data.settings[EConfigKey.AiInstructionsAssistantName]).toBe("Bella");
    });

    test("rejects empty args with at least-one-field requirement", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall("update-empty", UPDATE_SETTINGS_TOOL, "{}"),
        chatId: "settings-update-empty",
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("at least one field");
    });

    test("rejects unknown extra fields via strict schema", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall(
          "update-unknown",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({ timezone: "UTC", bogusKey: "value" }),
        ),
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
        toolCall: createToolCall(
          "update-bad-tz",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({ timezone: "Not/A_Real_Tz" }),
        ),
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
        toolCall: createToolCall(
          "update-bad-provider",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({ aiProvider: "invalid-provider" }),
        ),
        chatId: "settings-update-invalid-provider",
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
    });

    test("validates all fields before any write on multi-field invalid request", async () => {
      const chatId = "settings-update-partial-invalid";

      const result = await executeToolCall({
        toolCall: createToolCall(
          "update-partial-bad",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({
            timezone: "Not/A_Real_Tz",
            language: "English",
          }),
        ),
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

      const result = await executeToolCall({
        toolCall: createToolCall(
          "update-provider",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({ aiProvider: "openrouter" }),
        ),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(true);

      const readBack = await SettingsService.instance.get(chatId, EConfigKey.AiProvider);
      expect(readBack).toBe("openrouter");
    });

    test("updates ollamaChatModel and writes both chatAccurate and chat model keys", async () => {
      const chatId = "settings-update-ollama-model";

      const result = await executeToolCall({
        toolCall: createToolCall(
          "update-ollama-model",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({ ollamaChatModel: "glm-5:cloud" }),
        ),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(true);

      const data = result.data as {
        updatedFields: Array<{ field: string; key: string; value: string }>;
      };

      const keys = data.updatedFields.map((f) => f.key);
      expect(keys).toContain(EConfigKey.AiProvidersOllamaModelsChatAccurate);
      expect(keys).toContain(EConfigKey.AiProvidersOllamaModelsChat);

      const chatAccurate = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiProvidersOllamaModelsChatAccurate,
      );
      const chat = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiProvidersOllamaModelsChat,
      );

      expect(chatAccurate).toBe("glm-5:cloud");
      expect(chat).toBe("glm-5:cloud");
    });

    test("updates openrouterChatModel and writes both chatAccurate and chat model keys", async () => {
      const chatId = "settings-update-openrouter-model";

      const result = await executeToolCall({
        toolCall: createToolCall(
          "update-openrouter-model",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({ openrouterChatModel: "openai/gpt-5.4-mini" }),
        ),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(true);

      const chatAccurate = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiProvidersOpenrouterModelsChatAccurate,
      );
      const chat = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiProvidersOpenrouterModelsChat,
      );

      expect(chatAccurate).toBe("openai/gpt-5.4-mini");
      expect(chat).toBe("openai/gpt-5.4-mini");
    });

    test("updates opencodeGoChatModel and writes both chatAccurate and chat model keys", async () => {
      const chatId = "settings-update-opencodego-model";

      const result = await executeToolCall({
        toolCall: createToolCall(
          "update-opencodego-model",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({ opencodeGoChatModel: "glm-5.2" }),
        ),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(true);

      const chatAccurate = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiProvidersOpencodeGoModelsChatAccurate,
      );
      const chat = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiProvidersOpencodeGoModelsChat,
      );

      expect(chatAccurate).toBe("glm-5.2");
      expect(chat).toBe("glm-5.2");
    });

    test("does not update unrelated model-purpose keys when updating a chat model", async () => {
      const chatId = "settings-update-model-isolation";

      await executeToolCall({
        toolCall: createToolCall(
          "update-model-iso",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({ opencodeGoChatModel: "glm-5.2" }),
        ),
        chatId,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      const toolCheap = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiProvidersOpencodeGoModelsToolCheap,
      );
      const toolAccurate = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiProvidersOpencodeGoModelsToolAccurate,
      );
      const general = await SettingsService.instance.get(
        chatId,
        EConfigKey.AiProvidersOpencodeGoModelsGeneral,
      );

      expect(toolCheap).toBe(DefaultConfigRecord[EConfigKey.AiProvidersOpencodeGoModelsToolCheap]);
      expect(toolAccurate).toBe(
        DefaultConfigRecord[EConfigKey.AiProvidersOpencodeGoModelsToolAccurate],
      );
      expect(general).toBe(DefaultConfigRecord[EConfigKey.AiProvidersOpencodeGoModelsGeneral]);
    });

    test("fails when chatId is missing", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall(
          "update-no-chat",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({ timezone: "UTC" }),
        ),
        chatId: undefined,
        allowedToolNames: new Set([UPDATE_SETTINGS_TOOL]),
        settings: DefaultConfigRecord,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("chatId is required");
    });

    test("fails when not in allowedToolNames", async () => {
      const result = await executeToolCall({
        toolCall: createToolCall(
          "update-disallowed",
          UPDATE_SETTINGS_TOOL,
          JSON.stringify({ timezone: "UTC" }),
        ),
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
          toolCall: createToolCall(
            "update-invalidate",
            UPDATE_SETTINGS_TOOL,
            JSON.stringify({ assistantName: "Bella" }),
          ),
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
