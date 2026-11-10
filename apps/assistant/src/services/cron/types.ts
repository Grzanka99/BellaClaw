import type { TOption } from "@bellaclaw/shared";
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
  | { kind: "task"; prompt: string; fallback: string };

type TCronJobRow = typeof cronEngineJobsTable.$inferSelect;

export type TCronJob = Omit<TCronJobRow, "contentKind" | "contentBody" | "contentFallback"> & {
  content: TJobContent;
};

export type TCronJobContext = {
  name: string;
  scope: string;
  type: ECronJobType;
  pattern: TOption<string>;
  content: TJobContent;
  lastRunAt: TOption<Date>;
  nextRunAt: Date;
  createdAt: Date;
  timezone: TOption<string>;
};

type TCreateJobArgs = {
  name: string;
  scope: string;
  content: TJobContent;
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
  | "cancel-failed";

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
