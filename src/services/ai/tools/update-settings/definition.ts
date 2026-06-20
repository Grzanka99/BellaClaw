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
      properties: {
        timezone: {
          type: "string",
          description:
            "IANA timezone (e.g. Europe/Warsaw, America/New_York, UTC). Must be a valid Intl-supported timezone.",
        },
        language: {
          type: "string",
          description:
            "Conversation language for assistant replies (e.g. Polish, English, Spanish).",
        },
        assistantName: {
          type: "string",
          description: "The assistant's display name (e.g. Bellatrix, Bella).",
        },
        addressStyle: {
          type: "string",
          description:
            "How the assistant should address the user (e.g. 'informal but respectful address (per ty, not pan/pani)').",
        },
        preferredReplyLength: {
          type: "string",
          description: "Preferred reply length (e.g. '1-3 sentences', 'short', 'detailed').",
        },
        aiProvider: {
          type: "string",
          enum: ["openrouter", "ollama", "opencode-go"],
          description: "Active AI provider. Determines which provider's chat model is used.",
        },
        ollamaChatModel: {
          type: "string",
          description:
            "Chat model for the ollama provider. Updates both the chat and chatAccurate model keys for ollama, so it affects the next normal assistant turn when aiProvider is ollama.",
        },
        openrouterChatModel: {
          type: "string",
          description:
            "Chat model for the openrouter provider. Updates both the chat and chatAccurate model keys for openrouter, so it affects the next normal assistant turn when aiProvider is openrouter.",
        },
        opencodeGoChatModel: {
          type: "string",
          description:
            "Chat model for the opencode-go provider. Updates both the chat and chatAccurate model keys for opencode-go, so it affects the next normal assistant turn when aiProvider is opencode-go.",
        },
      },
    },
  },
};
