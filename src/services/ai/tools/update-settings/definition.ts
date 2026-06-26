import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const UPDATE_SETTINGS_TOOL = "update-settings" as const;

export const updateSettingsTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: UPDATE_SETTINGS_TOOL,
    description:
      "Updates the user's assistant settings. Provide at least one field to update. Only the provided fields are changed; omitted fields keep their current value. After a successful update, the new effective settings are returned and the assistant's instruction cache is invalidated so the next normal assistant turn uses the new values. For mixed messages that also contain a normal task, apply the settings change here and then ask the user to resend the normal task separately — never attempt to execute the normal task from this tool.",
    parameters: {
      type: "object",
      minProperties: 1,
      properties: {
        timezone: {
          type: "string",
          minLength: 1,
          description:
            "IANA timezone (e.g. Europe/Warsaw, America/New_York, UTC). Must be a valid Intl-supported timezone.",
        },
        language: {
          type: "string",
          minLength: 1,
          description:
            "Conversation language for assistant replies (e.g. Polish, English, Spanish).",
        },
        assistantName: {
          type: "string",
          minLength: 1,
          description: "The assistant's display name (e.g. Bellatrix, Bella).",
        },
        addressStyle: {
          type: "string",
          minLength: 1,
          description:
            "How the assistant should address the user (e.g. 'informal but respectful address (per ty, not pan/pani)').",
        },
        platform: {
          type: "string",
          minLength: 1,
          description:
            "Platform context the assistant should reference in its instructions (e.g. Discord direct messages, Signal messages). This does not switch the actual transport.",
        },
        preferredReplyLength: {
          type: "string",
          minLength: 1,
          description: "Preferred reply length (e.g. '1-3 sentences', 'short', 'detailed').",
        },
        aiProvider: {
          type: "string",
          enum: ["openrouter", "ollama", "opencode-go"],
          minLength: 1,
          description: "Active AI provider. Determines which provider's chat model is used.",
        },
      },
      additionalProperties: false,
    },
  },
};
