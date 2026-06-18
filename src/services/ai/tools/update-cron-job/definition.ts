import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const UPDATE_CRON_JOB_TOOL = "update-cron-job" as const;

export const updateCronJobTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: UPDATE_CRON_JOB_TOOL,
    description:
      "Update an existing one-time or recurring reminder by name. Use this after listing or identifying an existing scheduled job.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The unique name of the existing one-time or recurring cron job to update.",
        },
        pattern: {
          type: "string",
          description:
            "New 5-field cron expression for an existing recurring reminder. Do not use this for one-time reminders.",
        },
        fireAt: {
          type: "string",
          description:
            "New future ISO 8601 timestamp for an existing one-time reminder. Do not use this for recurring reminders.",
        },
        group: {
          type: "string",
          description: "New optional group label. Omit this to keep the existing group.",
        },
        reminderText: {
          type: "string",
          description:
            "New plain text reminder content. Omit this to keep existing reminder content.",
        },
        reminderPromptData: {
          type: "string",
          description:
            "New structured prompt data serialized as a JSON string. Requires reminderFallbackText.",
        },
        reminderFallbackText: {
          type: "string",
          description:
            "Fallback reminder text to use with reminderPromptData. Required when reminderPromptData is set.",
        },
      },
      required: ["name"],
    },
  },
};
