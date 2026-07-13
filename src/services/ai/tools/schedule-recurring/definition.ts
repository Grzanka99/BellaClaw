import { createToolDefinition } from "../definition";
import { SScheduleRecurringArgs } from "./handler";

export const SCHEDULE_RECURRING_TOOL = "schedule-recurring" as const;

export const scheduleRecurringTool = createToolDefinition(
  SCHEDULE_RECURRING_TOOL,
  "Schedule a recurring cron job using a 5-field cron pattern. Provide reminderText, or reminderPromptData together with reminderFallbackText, but not both reminderText and reminderPromptData.",
  SScheduleRecurringArgs,
);
