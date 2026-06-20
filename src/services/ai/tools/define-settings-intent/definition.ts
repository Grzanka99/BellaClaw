import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const DEFINE_SETTINGS_INTENT_TOOL = "define-settings-intent" as const;

export const defineSettingsIntentTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: DEFINE_SETTINGS_INTENT_TOOL,
    description:
      "Classifies whether an incoming user message is a request to read or change assistant settings (intent=settings) or a normal conversational/task message (intent=normal). Returns the intent and a short reason. Call this tool exactly once for every incoming message.",
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          enum: ["settings", "normal"],
          description: "The classified intent of the message.",
        },
        reason: {
          type: "string",
          description: "Brief explanation in English of why this intent was chosen.",
        },
      },
      required: ["intent", "reason"],
    },
  },
};
