import { z } from "zod";
import type { TOption } from "../../types";

export enum ECronEngineJobType {
  Recurring = "recurring",
  OneTime = "onetime",
}

const SReminderContentJobFields = z.object({
  reminderText: z
    .string()
    .nullable()
    .transform((value) => value ?? undefined),
  reminderPromptData: z
    .string()
    .nullable()
    .transform((value) => value ?? undefined),
  reminderFallbackText: z
    .string()
    .nullable()
    .transform((value) => value ?? undefined),
});

const SReminderContentArgsBase = z.object({
  reminderText: z.string().optional(),
  reminderPromptData: z.string().optional(),
  reminderFallbackText: z.string().optional(),
});

function validateReminderContentArgs(
  value: z.infer<typeof SReminderContentArgsBase>,
  ctx: z.RefinementCtx,
) {
  if (value.reminderText !== undefined && value.reminderPromptData !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either reminderText or reminderPromptData, not both",
      path: ["reminderText"],
    });
  }

  if (value.reminderPromptData !== undefined && value.reminderFallbackText === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reminderFallbackText is required when reminderPromptData is set",
      path: ["reminderFallbackText"],
    });
  }

  if (
    value.reminderFallbackText !== undefined &&
    value.reminderText === undefined &&
    value.reminderPromptData === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reminderFallbackText requires reminderText or reminderPromptData",
      path: ["reminderFallbackText"],
    });
  }
}

export const SCronEngineJob = z
  .object({
    id: z.number(),
    name: z.string(),
    scope: z.string().transform((value) => (value.length > 0 ? value : undefined)),
    group: z
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
  })
  .extend(SReminderContentJobFields.shape);

export const SScheduleRecurringArgs = z
  .object({
    name: z.string(),
    scope: z.string().optional(),
    group: z.string().optional(),
    pattern: z.string(),
    overwrite: z.boolean().optional(),
  })
  .extend(SReminderContentArgsBase.shape)
  .superRefine(validateReminderContentArgs);

export const SScheduleOnceArgs = z
  .object({
    name: z.string(),
    scope: z.string().optional(),
    group: z.string().optional(),
    fireAt: z.coerce.date(),
    overwrite: z.boolean().optional(),
  })
  .extend(SReminderContentArgsBase.shape)
  .superRefine(validateReminderContentArgs);

export type TCronEngineJobContext = {
  name: string;
  scope: TOption<string>;
  group: TOption<string>;
  type: ECronEngineJobType;
  pattern: TOption<string>;
  reminderText: TOption<string>;
  reminderPromptData: TOption<string>;
  reminderFallbackText: TOption<string>;
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

export type TCronEngineOptions = {
  dbFile: string;
  tableName?: string;
};
