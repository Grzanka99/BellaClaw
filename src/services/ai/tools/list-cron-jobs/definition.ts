import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const LIST_CRON_JOBS_TOOL = "list-cron-jobs" as const;

export const listCronJobsTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: LIST_CRON_JOBS_TOOL,
    description:
      "List all currently scheduled cron jobs. Use this to check what reminders or recurring tasks exist, so you can inform the user or decide whether to unschedule any.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};
