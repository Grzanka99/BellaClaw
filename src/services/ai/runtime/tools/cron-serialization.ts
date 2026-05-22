import { Config } from "../../../../config";
import type { TCronEngineJob } from "../../../../lib/cron-engine";

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

export function serializeCronJobForModel(job: TCronEngineJob) {
  const timezone = Config.ai.instructions.timezone;

  return {
    ...job,
    timezone,
    nextRunAtLocal: formatLocalDateTime(job.nextRunAt, timezone),
    nextRunAtLocalTime: formatLocalTime(job.nextRunAt, timezone),
    lastRunAtLocal:
      job.lastRunAt === undefined ? undefined : formatLocalDateTime(job.lastRunAt, timezone),
    createdAtLocal: formatLocalDateTime(job.createdAt, timezone),
  };
}

export function serializeCronJobsForModel(jobs: TCronEngineJob[]) {
  return jobs.map((job) => serializeCronJobForModel(job));
}
