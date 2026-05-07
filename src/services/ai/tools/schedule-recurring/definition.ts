import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export const SCHEDULE_RECURRING_TOOL = "schedule-recurring" as const;

export const scheduleRecurringTool: ToolDefinitionJson = {
  type: "function",
  function: {
    name: SCHEDULE_RECURRING_TOOL,
    description:
      "Schedule a recurring cron job that fires at regular intervals defined by a 5-field cron pattern (minute hour day-of-month month day-of-week). Use this to set up reminders, periodic check-ins, or any task that should repeat on a schedule.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "A unique identifier for this cron job. Used to reference the job when unscheduling or updating.",
        },
        pattern: {
          type: "string",
          description:
            "A standard 5-field cron expression: minute hour day-of-month month day-of-week (e.g. '0 9 * * *' for every day at 9:00, '*/30 * * * *' for every 30 minutes).",
        },
        group: {
          type: "string",
          description: "Optional group name for organizing related cron jobs.",
        },
        overwrite: {
          type: "boolean",
          description: "If true, replace an existing job with the same name. Defaults to false.",
        },
      },
      required: ["name", "pattern"],
    },
  },
};
