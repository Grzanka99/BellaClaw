import { createToolDefinition } from "../definition";
import { SListCronJobsArgs } from "./handler";

export const LIST_CRON_JOBS_TOOL = "list-cron-jobs" as const;

export const listCronJobsTool = createToolDefinition(
  LIST_CRON_JOBS_TOOL,
  "List all currently scheduled cron jobs. Use this to check what reminders or recurring tasks exist, so you can inform the user or decide whether to unschedule any.",
  SListCronJobsArgs,
);
