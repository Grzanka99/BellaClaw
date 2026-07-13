import { createToolDefinition } from "../definition";
import { SScheduleOnceArgs } from "./handler";

export const SCHEDULE_ONCE_TOOL = "schedule-once" as const;

export const scheduleOnceTool = createToolDefinition(
  SCHEDULE_ONCE_TOOL,
  "Schedule a one-time reminder that fires once at a specific future date and time, then removes itself. Provide reminderText, or reminderPromptData together with reminderFallbackText, but not both reminderText and reminderPromptData.",
  SScheduleOnceArgs,
);
