import type { cronEngineJobsTable } from "../database/schema";

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
