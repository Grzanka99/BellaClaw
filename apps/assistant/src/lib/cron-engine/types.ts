import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";

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
  taskPrompt: z
    .string()
    .nullable()
    .transform((value) => value ?? undefined),
  taskFallbackText: z
    .string()
    .nullable()
    .transform((value) => value ?? undefined),
});

const SReminderContentArgsBase = z.object({
  reminderText: z.string().optional(),
  reminderPromptData: z.string().optional(),
  reminderFallbackText: z.string().optional(),
  taskPrompt: z.string().optional(),
  taskFallbackText: z.string().optional(),
});

function validateReminderContentArgs(
  value: z.infer<typeof SReminderContentArgsBase>,
  ctx: z.RefinementCtx,
) {
  const contentModeCount = [value.reminderText, value.reminderPromptData, value.taskPrompt].filter(
    (field) => field !== undefined,
  ).length;

  if (contentModeCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide only one of reminderText, reminderPromptData, or taskPrompt",
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

  if (value.taskPrompt !== undefined && value.taskFallbackText === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "taskFallbackText is required when taskPrompt is set",
      path: ["taskFallbackText"],
    });
  }

  if (value.taskFallbackText !== undefined && value.taskPrompt === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "taskFallbackText requires taskPrompt",
      path: ["taskFallbackText"],
    });
  }
}

export const SCronJob = z
  .object({
    id: z.number(),
    name: z.string(),
    scope: z.string().transform((value) => {
      if (value.length > 0) {
        return value;
      }

      return undefined;
    }),
    group: z
      .string()
      .nullable()
      .transform((value) => value ?? undefined),
    type: z.enum(ECronJobType),
    pattern: z
      .string()
      .nullable()
      .transform((value) => value ?? undefined),
    nextRunAt: z.number().transform((value) => new Date(value)),
    lastRunAt: z
      .number()
      .nullable()
      .transform((value) => {
        if (value !== null) {
          return new Date(value);
        }

        return undefined;
      }),
    createdAt: z.number().transform((value) => new Date(value)),
    status: z.enum(ECronJobStatus),
    finishedAt: z
      .number()
      .nullable()
      .transform((value) => {
        if (value !== null) {
          return new Date(value);
        }

        return undefined;
      }),
    finishedReason: z
      .enum(ECronFinishedReason)
      .nullable()
      .transform((value) => {
        if (value !== null) {
          return value;
        }

        return undefined;
      }),
    timezone: z
      .string()
      .nullable()
      .transform((value) => value ?? undefined),
  })
  .extend(SReminderContentJobFields.shape)
  .superRefine(validateReminderContentArgs);

export const SCreateRecurringArgs = z
  .object({
    name: z.string(),
    scope: z.string().optional(),
    group: z.string().optional(),
    pattern: z.string(),
    overwrite: z.boolean().optional(),
    timezone: z.string().optional(),
  })
  .extend(SReminderContentArgsBase.shape)
  .superRefine(validateReminderContentArgs);

export const SCreateOnceArgs = z
  .object({
    name: z.string(),
    scope: z.string().optional(),
    group: z.string().optional(),
    fireAt: z.coerce.date(),
    overwrite: z.boolean().optional(),
    timezone: z.string().optional(),
  })
  .extend(SReminderContentArgsBase.shape)
  .superRefine(validateReminderContentArgs);

export type TCronJobContext = {
  name: string;
  scope: TOption<string>;
  group: TOption<string>;
  type: ECronJobType;
  pattern: TOption<string>;
  reminderText: TOption<string>;
  reminderPromptData: TOption<string>;
  reminderFallbackText: TOption<string>;
  taskPrompt: TOption<string>;
  taskFallbackText: TOption<string>;
  lastRunAt: TOption<Date>;
  nextRunAt: Date;
  createdAt: Date;
  timezone: TOption<string>;
};

export type TCronJob = z.infer<typeof SCronJob>;
export type TCreateRecurringArgs = z.infer<typeof SCreateRecurringArgs>;
export type TCreateOnceArgs = z.infer<typeof SCreateOnceArgs>;

export type TCronSchedulerError = {
  operation: "create" | "cancel";
  error: unknown;
};

export type TCronSchedulerOptions = {
  timezone?: string;
};
