import { createToolDefinition } from "../definition";
import { SScheduleRecurringArgs } from "./handler";

export const SCHEDULE_RECURRING_TOOL = "schedule-recurring" as const;

export const scheduleRecurringTool = createToolDefinition(
  SCHEDULE_RECURRING_TOOL,
  "Schedule a recurring reminder or autonomous web task using a 5-field cron pattern. Provide exactly one content mode: reminderText; reminderPromptData with reminderFallbackText; or taskPrompt with taskFallbackText.",
  SScheduleRecurringArgs,
);
