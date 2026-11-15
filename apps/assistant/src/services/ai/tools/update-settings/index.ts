import { EEventType } from "@bellaclaw/database";
import { bool, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import type { TConfigUpdate } from "../../../settings";
import { ConfigValidators, EConfigKey } from "../../../settings/schema";
import { EAiProvider, EModelPurpose } from "../../types";
import { defineTool, requireChatId } from "../define-tool";
import { createAiRuntime } from "../get-settings";
import { prepareAiSettingsUpdate, validateAiSettingsArgs } from "./ai-settings";
import instructions from "./instructions.xml" with { type: "text" };

const SUpdateSettingsArgs = {
  ...obj({
    timezone: opt(
      str({
        minLength: 1,
        description: "Valid IANA timezone, such as Europe/Warsaw, America/New_York, or UTC",
      }),
    ),
    language: opt(
      str({
        minLength: 1,
        description: "Conversation language for assistant replies, such as Polish or English",
      }),
    ),
    assistantName: opt(str({ minLength: 1, description: "The assistant's display name" })),
    addressStyle: opt(
      str({ minLength: 1, description: "How the assistant should address the user" }),
    ),
    preferredReplyLength: opt(
      str({
        minLength: 1,
        description: "Preferred reply length, such as 1-3 sentences, short, or detailed",
      }),
    ),
    aiProvider: opt(
      oneOf(Object.values(EAiProvider), {
        description: "Active AI provider: openai-codex, openrouter, ollama, or opencode-go",
      }),
    ),
    aiModel: opt(
      str({
        minLength: 1,
        description: "Exact Pi model ID from the active or simultaneously requested provider",
      }),
    ),
    aiModelPurpose: opt(
      oneOf(Object.values(EModelPurpose), {
        description: "Model purpose to change. Defaults to Main when omitted",
      }),
    ),
    aiReasoningEffort: opt(oneOf(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
    aiServiceTier: opt(
      oneOf(["default", "flex", "priority"], {
        description:
          "OpenAI processing tier: priority is fast mode, flex is cheaper and slower, default clears it",
      }),
    ),
    resetAiModel: opt(
      bool({ description: "Reset the selected purpose to the provider registry default" }),
    ),
    resetAiReasoningEffort: opt(
      bool({ description: "Reset reasoning effort while keeping the selected model" }),
    ),
  }),
  minProperties: 1,
};

type TUpdateSettingsArgs = Static<typeof SUpdateSettingsArgs>;

export const updateSettings = defineTool({
  name: "update-settings",
  label: "Update settings",
  description:
    "Updates the user's assistant settings, including provider, per-purpose model, reasoning effort, and service tier. Provide at least one field. Only provided fields change. For mixed settings and normal-task messages, apply the settings change and ask the user to resend the task separately.",
  schema: SUpdateSettingsArgs,
  instructions,
  mode: "sequential",
  logSafe: [["settings", "settingKeys"]],
  execute: async (context, parsedArgs) => {
    const chatId = requireChatId(context.chatId);
    const hasModelOperation = validateAiSettingsArgs(parsedArgs);

    const updates: TConfigUpdate[] = [];
    const fields: Array<{ field: keyof TUpdateSettingsArgs; key: EConfigKey }> = [
      { field: "timezone", key: EConfigKey.AiInstructionsTimezone },
      { field: "language", key: EConfigKey.AiInstructionsLanguage },
      { field: "assistantName", key: EConfigKey.AiInstructionsAssistantName },
      { field: "addressStyle", key: EConfigKey.AiInstructionsAddressStyle },
      { field: "preferredReplyLength", key: EConfigKey.AiInstructionsPreferredReplyLength },
    ];

    for (const field of fields) {
      const value = parsedArgs[field.field];

      if (value !== undefined) {
        const parsed = ConfigValidators[field.key].safeParse(value);

        if (!parsed.success) {
          throw new Error(`Invalid value for ${field.field}`);
        }

        updates.push({ key: field.key, value: parsed.data });
      }
    }

    const { settings, purpose, fallbacks } = await prepareAiSettingsUpdate(
      chatId,
      parsedArgs,
      hasModelOperation,
      updates,
      context.verifySettings,
    );

    let savedSettings = settings;

    if (updates.length > 0) {
      const changed = await context.events.request(
        EEventType.SettingsUpdateRequested,
        { ownerKey: chatId, updates },
        { outcome: EEventType.SettingsChanged, step: undefined, key: chatId, timeoutMs: undefined },
      );
      savedSettings = changed.payload.record;
    }

    return {
      settings: savedSettings,
      aiRuntime: createAiRuntime(savedSettings, false),
      change: {
        purpose,
        fallbacks,
        effectiveFrom: "next-message",
      },
    };
  },
});
