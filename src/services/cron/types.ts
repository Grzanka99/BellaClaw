import { z } from "zod";
import type { TOption } from "../../types";

export enum ECronJobType {
  Recurring = "recurring",
  OneTime = "onetime",
}

export const SCronJob = z.object({
  id: z.number(),
  name: z.string(),
  group: z
    .string()
    .nullable()
    .transform((v) => v ?? undefined),
  type: z.enum(ECronJobType),
  pattern: z.string().nullable(),
  nextRunAt: z.number().transform((v) => new Date(v)),
  lastRunAt: z
    .number()
    .nullable()
    .transform((v) => (v !== null ? new Date(v) : null)),
  createdAt: z.number().transform((v) => new Date(v)),
});

export const SScheduleArgs = z.object({
  name: z.string(),
  pattern: z.string(),
  group: z.string().optional(),
  overwrite: z.boolean().optional(),
});

export const SScheduleOnceArgs = z.object({
  name: z.string(),
  fireAt: z.coerce.date(),
  group: z.string().optional(),
  overwrite: z.boolean().optional(),
});

export type TJobContext = {
  name: string;
  group: TOption<string>;
  type: ECronJobType;
  pattern: TOption<string>;
  lastRunAt: TOption<Date>;
  nextRunAt: Date;
};

export type TCronJob = z.infer<typeof SCronJob>;
export type TScheduleArgs = z.infer<typeof SScheduleArgs>;
export type TScheduleOnceArgs = z.infer<typeof SScheduleOnceArgs>;

export type TCronError = {
  operation: "schedule" | "unschedule" | "read" | "tick";
  error: unknown;
};
