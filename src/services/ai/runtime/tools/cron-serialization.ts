import { Config } from "../../../../config";
import type { TCronJob } from "../../../../lib/cron-engine";

function formatLocalDateTime(date: Date, timezone: string) {
  return date.toLocaleString("sv-SE-u-nu-latn", {
    timeZone: timezone,
    hourCycle: "h23",
  });
}

function formatLocalTime(date: Date, timezone: string) {
  return date.toLocaleTimeString("sv-SE-u-nu-latn", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function serializeCronJobForModel(job: TCronJob) {
  const timezone = job.timezone ?? Config.ai.instructions.timezone;
  let contentMode = "none";

  if (job.taskPrompt !== undefined) {
    contentMode = "scheduled-task";
  } else if (job.reminderPromptData !== undefined) {
    contentMode = "generated-reminder";
  } else if (job.reminderText !== undefined) {
    contentMode = "direct-reminder";
  }

  return {
    ...job,
    contentMode,
    taskPromptChars: job.taskPrompt?.length ?? 0,
    taskFallbackTextChars: job.taskFallbackText?.length ?? 0,
    timezone,
    nextRunAtLocal: formatLocalDateTime(job.nextRunAt, timezone),
    nextRunAtLocalTime: formatLocalTime(job.nextRunAt, timezone),
    lastRunAtLocal:
      job.lastRunAt === undefined ? undefined : formatLocalDateTime(job.lastRunAt, timezone),
    createdAtLocal: formatLocalDateTime(job.createdAt, timezone),
  };
}

export function serializeCronJobsForModel(jobs: TCronJob[]) {
  return jobs.map((job) => serializeCronJobForModel(job));
}
