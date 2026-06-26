import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const GET_SETTINGS_TOOL = "get-settings" as const;

export const getSettingsTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: GET_SETTINGS_TOOL,
    description:
      "Reads and returns the current effective assistant settings for the user. Takes no arguments; the owner is determined automatically from the chat. Use this when the user asks what timezone, language, AI provider, chat model, assistant name, address style, or reply length is currently configured.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};
