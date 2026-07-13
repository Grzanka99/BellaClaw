import { z } from "zod";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SScheduleOnceArgs = z
  .object({
    name: z.string().describe("Unique one-time job name used to reference, update, or cancel it"),
    fireAt: z.iso
      .datetime({ offset: true })
      .describe("Future ISO 8601 date-time with an explicit Z or numeric timezone offset")
      .transform((value) => new Date(value)),
    group: z.string().describe("Optional group label stored with the cron job").optional(),
    reminderText: z
      .string()
      .describe("Plain reminder text for a direct, non-generated reminder")
      .optional(),
    reminderPromptData: z
      .string()
      .describe(
        "Structured prompt data serialized as JSON for a reminder generated later by the model",
      )
      .optional(),
    reminderFallbackText: z
      .string()
      .describe("Fallback text required when reminderPromptData is provided")
      .optional(),
    overwrite: z
      .boolean()
      .describe("Replace an existing one-time job with the same name; defaults to false")
      .optional(),
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

export type TScheduleOnceResult = TCronJob;
