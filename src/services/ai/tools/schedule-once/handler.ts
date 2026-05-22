import { z } from "zod";
import type { TCronEngineJob } from "../../../../lib/cron-engine";

export const SScheduleOnceArgs = z
  .object({
    name: z.string(),
    fireAt: z.coerce.date(),
    group: z.string().optional(),
    reminderText: z.string().optional(),
    reminderPromptData: z.string().optional(),
    reminderFallbackText: z.string().optional(),
    overwrite: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.reminderText === undefined && value.reminderPromptData === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide reminderText or reminderPromptData",
        path: ["reminderText"],
      });
    }

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
  });

export type TScheduleOnceArgs = z.infer<typeof SScheduleOnceArgs>;

export type TScheduleOnceResult = TCronEngineJob;
