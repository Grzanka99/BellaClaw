import { z } from "zod";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SUpdateCronJobArgs = z
  .object({
    name: z.string().describe("Unique name of the existing cron job to update"),
    pattern: z
      .string()
      .describe("New 5-field cron expression for an existing recurring reminder")
      .optional(),
    fireAt: z.iso
      .datetime({ offset: true })
      .describe("New future ISO 8601 date-time with an explicit Z or numeric timezone offset")
      .transform((value) => new Date(value))
      .optional(),
    group: z.string().describe("New group label; omit to preserve the current group").optional(),
    reminderText: z
      .string()
      .describe("New plain reminder text; omit to preserve the current content")
      .optional(),
    reminderPromptData: z
      .string()
      .describe("New structured prompt data serialized as JSON; requires reminderFallbackText")
      .optional(),
    reminderFallbackText: z
      .string()
      .describe("Fallback text required when reminderPromptData is provided")
      .optional(),
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
