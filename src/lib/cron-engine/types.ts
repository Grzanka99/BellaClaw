import { z } from "zod";
import type { TOption } from "../../types";

export enum ECronEngineJobType {
  Recurring = "recurring",
  OneTime = "onetime",
}

export const SCronEngineJob = z.object({
  id: z.number(),
  name: z.string(),
  scope: z.string().transform((value) => (value.length > 0 ? value : undefined)),
  data: z
    .string()
    .nullable()
    .transform((value) => value ?? undefined),
  type: z.enum(ECronEngineJobType),
  pattern: z
    .string()
    .nullable()
    .transform((value) => value ?? undefined),
  nextRunAt: z.number().transform((value) => new Date(value)),
  lastRunAt: z
    .number()
    .nullable()
    .transform((value) => (value !== null ? new Date(value) : undefined)),
  createdAt: z.number().transform((value) => new Date(value)),
});

export const SScheduleRecurringArgs = z.object({
  name: z.string(),
  scope: z.string().optional(),
  data: z.string().optional(),
  pattern: z.string(),
  overwrite: z.boolean().optional(),
});

export const SScheduleOnceArgs = z.object({
  name: z.string(),
  scope: z.string().optional(),
  data: z.string().optional(),
  fireAt: z.coerce.date(),
  overwrite: z.boolean().optional(),
});

export type TCronEngineJobContext = {
  name: string;
  scope: TOption<string>;
  data: TOption<string>;
  type: ECronEngineJobType;
  pattern: TOption<string>;
  lastRunAt: TOption<Date>;
  nextRunAt: Date;
  createdAt: Date;
};

export type TCronEngineJob = z.infer<typeof SCronEngineJob>;
export type TScheduleRecurringArgs = z.infer<typeof SScheduleRecurringArgs>;
export type TScheduleOnceArgs = z.infer<typeof SScheduleOnceArgs>;

export type TCronEngineError = {
  operation: "schedule" | "unschedule" | "read" | "tick";
  error: unknown;
};

export type TCronEngineLogger = {
  info: (msg: string) => void;
  warning: (msg: string) => void;
  error: (msg: string) => void;
  message: (msg: string) => void;
};

export type TCronEngineOptions = {
  dbFile: string;
  tableName?: string;
  logger?: TCronEngineLogger;
};
