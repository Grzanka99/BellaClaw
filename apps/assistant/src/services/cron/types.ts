import type { cronEngineJobsTable } from "../database/schema";
import type { TCronJobRecord } from "../events/catalog";

export enum ECronJobType {
  Recurring = "recurring",
  OneTime = "onetime",
}

export enum ECronJobStatus {
  Active = "active",
  Completed = "completed",
  Cancelled = "cancelled",
}

export enum ECronFinishedReason {
  Fired = "fired",
  Unscheduled = "unscheduled",
  Overwritten = "overwritten",
}

export type TJobContent =
  | { kind: "text"; text: string }
  | { kind: "generated"; promptData: string; fallback: string }
  | { kind: "task"; prompt: string; fallback: string }
  /** The job only sends the text outputs of its automations. */
  | { kind: "automations" };

type TCronJobRow = typeof cronEngineJobsTable.$inferSelect;

export type TCronJob = Omit<
  TCronJobRow,
  "contentKind" | "contentBody" | "contentFallback" | "automationIds"
> & {
  content: TJobContent;
  /** Automations run in this order before the job's message is produced. */
  automationIds: number[];
};

type TCreateJobArgs = {
  name: string;
  scope: string;
  content: TJobContent;
  automationIds?: number[];
  overwrite?: boolean;
  timezone?: string;
};

export type TCreateRecurringArgs = TCreateJobArgs & { pattern: string };
export type TCreateOnceArgs = TCreateJobArgs & { fireAt: Date };

export type TCronSchedulerErrorCode =
  | "job-already-exists"
  | "fire-at-in-past"
  | "unschedulable-pattern"
  | "job-not-found"
  | "create-failed"
  | "cancel-failed"
  | "automations-without-task"
  | "missing-automations";

/** A scheduler failure with a stable code; the message is safe to show the model. */
export class CronSchedulerError extends Error {
  public readonly code: TCronSchedulerErrorCode;
  public readonly operation: "create" | "cancel";

  constructor(code: TCronSchedulerErrorCode, operation: "create" | "cancel", message: string) {
    super(message);
    this.code = code;
    this.operation = operation;
  }
}

export type TCronSchedulerOptions = {
  timezone?: string;
};

export function toCronJobRecord(job: TCronJob): TCronJobRecord {
  return {
    id: job.id,
    name: job.name,
    scope: job.scope,
    type: job.type,
    pattern: job.pattern ?? undefined,
    content: job.content,
    automationIds: job.automationIds,
    nextRunAt: job.nextRunAt.getTime(),
    lastRunAt: job.lastRunAt?.getTime(),
    createdAt: job.createdAt.getTime(),
    status: job.status,
    finishedAt: job.finishedAt?.getTime(),
    finishedReason: job.finishedReason ?? undefined,
    timezone: job.timezone ?? undefined,
  };
}

export function fromCronJobRecord(record: TCronJobRecord): TCronJob {
  let lastRunAt: Date | null = null;
  let finishedAt: Date | null = null;

  if (record.lastRunAt !== undefined) {
    lastRunAt = new Date(record.lastRunAt);
  }

  if (record.finishedAt !== undefined) {
    finishedAt = new Date(record.finishedAt);
  }

  return {
    ...record,
    pattern: record.pattern ?? null,
    nextRunAt: new Date(record.nextRunAt),
    lastRunAt,
    createdAt: new Date(record.createdAt),
    finishedAt,
    finishedReason: record.finishedReason ?? null,
    timezone: record.timezone ?? null,
  };
}
