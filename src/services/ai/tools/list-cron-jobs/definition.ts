import { createToolDefinition } from "../definition";
import { SListCronJobsArgs } from "./handler";

export const LIST_CRON_JOBS_TOOL = "list-cron-jobs" as const;

export const listCronJobsTool = createToolDefinition(
  LIST_CRON_JOBS_TOOL,
  "List all currently scheduled cron jobs to inspect reminders and recurring tasks or get exact names before unscheduling them.",
  SListCronJobsArgs,
);
