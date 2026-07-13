import { createToolDefinition } from "../definition";
import { SUpdateCronJobArgs } from "./handler";

export const UPDATE_CRON_JOB_TOOL = "update-cron-job" as const;

export const updateCronJobTool = createToolDefinition(
  UPDATE_CRON_JOB_TOOL,
  "Update an existing reminder by name. Use pattern only for recurring reminders and fireAt only for one-time reminders. reminderPromptData requires reminderFallbackText.",
  SUpdateCronJobArgs,
);
