import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const UNSCHEDULE_RECURRING_TOOL = "unschedule-recurring" as const;

export const unscheduleRecurringTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: UNSCHEDULE_RECURRING_TOOL,
    description:
      "Remove a previously scheduled recurring cron job by name. Use this to cancel reminders or periodic tasks that are no longer needed.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The unique name of the cron job to remove.",
        },
      },
      required: ["name"],
    },
  },
};
