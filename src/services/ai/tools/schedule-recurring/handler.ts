import { z } from "zod";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SScheduleRecurringArgs = z
  .object({
    name: z.string().describe("Unique recurring job name used to reference, update, or cancel it"),
    pattern: z
      .string()
      .describe("Standard 5-field cron expression: minute hour day-of-month month day-of-week"),
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
    taskPrompt: z
      .string()
      .describe("Autonomous objective to complete with fresh web information when the job fires")
      .optional(),
    taskFallbackText: z
      .string()
      .describe("Fallback text required when taskPrompt is provided")
      .optional(),
    overwrite: z
      .boolean()
      .describe("Replace an existing recurring job with the same name; defaults to false")
      .optional(),
  })
  .superRefine((value, ctx) => {
    const contentModeCount = [
      value.reminderText,
      value.reminderPromptData,
      value.taskPrompt,
    ].filter((field) => field !== undefined).length;

    if (contentModeCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide reminderText, reminderPromptData, or taskPrompt",
        path: ["reminderText"],
      });
    }

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
  });

export type TScheduleRecurringArgs = z.infer<typeof SScheduleRecurringArgs>;

export type TScheduleRecurringResult = TCronJob;
