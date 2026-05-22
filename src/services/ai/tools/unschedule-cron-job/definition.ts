import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const UNSCHEDULE_CRON_JOB_TOOL = "unschedule-cron-job" as const;

export const unscheduleCronJobTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: UNSCHEDULE_CRON_JOB_TOOL,
    description:
      "Remove a previously scheduled cron job by name. Use this to cancel one-time reminders, recurring reminders, or periodic tasks that are no longer needed.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The unique name of the one-time or recurring cron job to remove.",
        },
      },
      required: ["name"],
    },
  },
};
