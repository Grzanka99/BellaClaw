import { z } from "zod";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SUpdateCronJobArgs = z
  .object({
    name: z.string(),
    pattern: z.string().optional(),
    fireAt: z.coerce.date().optional(),
    group: z.string().optional(),
    reminderText: z.string().optional(),
    reminderPromptData: z.string().optional(),
    reminderFallbackText: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.pattern !== undefined && value.fireAt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either pattern or fireAt, not both",
        path: ["pattern"],
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

    if (value.reminderFallbackText !== undefined && value.reminderPromptData === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reminderFallbackText requires reminderPromptData",
        path: ["reminderFallbackText"],
      });
    }
  });

export type TUpdateCronJobArgs = z.infer<typeof SUpdateCronJobArgs>;

export type TUpdateCronJobResult = TCronJob;
