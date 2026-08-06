import { createToolDefinition } from "../definition";
import { SUpdateCronJobArgs } from "./handler";

export const UPDATE_CRON_JOB_TOOL = "update-cron-job" as const;

export const updateCronJobTool = createToolDefinition(
  UPDATE_CRON_JOB_TOOL,
  "Update an existing reminder or scheduled task by name. Use pattern only for recurring jobs and fireAt only for one-time jobs. A supplied content mode replaces the previous mode.",
  SUpdateCronJobArgs,
);
