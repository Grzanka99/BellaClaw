import type { TOption } from "../../types";

export enum ECronJobType {
  Recurring = "recurring",
  OneTime = "onetime",
}

export type TJobContext = {
  name: string;
  userId: string;
  group: TOption<string>;
  type: ECronJobType;
  pattern: TOption<string>;
  lastRunAt: TOption<Date>;
  nextRunAt: Date;
};

export type TCronJob = {
  id: number;
  name: string;
  userId: string;
  group: TOption<string>;
  type: ECronJobType;
  pattern: string | null;
  nextRunAt: Date;
  lastRunAt: Date | null;
  createdAt: Date;
};

export type TScheduleArgs = {
  name: string;
  userId: string;
  pattern: string;
  group?: string;
  overwrite?: boolean;
};

export type TScheduleOnceArgs = {
  name: string;
  userId: string;
  fireAt: Date;
  group?: string;
  overwrite?: boolean;
};

export type TCronError = {
  operation: "schedule" | "unschedule" | "read" | "tick";
  error: unknown;
};
