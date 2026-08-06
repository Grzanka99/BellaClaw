import { createToolDefinition } from "../definition";
import { SUnscheduleCronJobArgs } from "./handler";

export const UNSCHEDULE_CRON_JOB_TOOL = "unschedule-cron-job" as const;

export const unscheduleCronJobTool = createToolDefinition(
  UNSCHEDULE_CRON_JOB_TOOL,
  "Cancel a previously scheduled one-time or recurring cron job by name.",
  SUnscheduleCronJobArgs,
);
