import { createToolDefinition } from "../definition";
import { SScheduleOnceArgs } from "./handler";

export const SCHEDULE_ONCE_TOOL = "schedule-once" as const;

export const scheduleOnceTool = createToolDefinition(
  SCHEDULE_ONCE_TOOL,
  "Schedule a one-time reminder or autonomous task requiring tools. Provide exactly one content mode: reminderText; reminderPromptData with reminderFallbackText; or taskPrompt with taskFallbackText.",
  SScheduleOnceArgs,
);
