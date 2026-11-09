import { createToolDefinition } from "../definition";
import { SPreviewCronJobArgs } from "./handler";

export const PREVIEW_CRON_JOB_TOOL = "preview-cron-job" as const;

export const previewCronJobTool = createToolDefinition(
  PREVIEW_CRON_JOB_TOOL,
  "Dry-run a job with automations as if it fired now and return the exact message it would send. Nothing is delivered or saved and automation state is not changed. Base it on an existing job by name; taskPrompt and automations override the job's values.",
  SPreviewCronJobArgs,
);
