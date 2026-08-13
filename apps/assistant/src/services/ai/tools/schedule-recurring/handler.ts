import { type Static, Type } from "@earendil-works/pi-ai";
import type { TCronJob } from "../../../../lib/cron-engine";
import { normalizeCronContentFields } from "../cron-content";

export const SScheduleRecurringArgs = Type.Object(
  {
    name: Type.String({
      description: "Unique recurring job name used to reference, update, or cancel it",
    }),
    pattern: Type.String({ description: "Standard 5-field cron expression" }),
    group: Type.Optional(
      Type.String({ description: "Optional group label stored with the cron job" }),
    ),
    reminderText: Type.Optional(
      Type.String({ description: "Plain reminder text for a direct, non-generated reminder" }),
    ),
    reminderPromptData: Type.Optional(
      Type.String({ description: "Structured reminder prompt data serialized as JSON" }),
    ),
    reminderFallbackText: Type.Optional(
      Type.String({ description: "Fallback text required with reminderPromptData" }),
    ),
    taskPrompt: Type.Optional(
      Type.String({ description: "Autonomous objective to complete with fresh web information" }),
    ),
    taskFallbackText: Type.Optional(
      Type.String({ description: "Fallback text required with taskPrompt" }),
    ),
    overwrite: Type.Optional(
      Type.Boolean({ description: "Replace an existing recurring job with the same name" }),
    ),
  },
  { additionalProperties: false },
);

export type TScheduleRecurringArgs = Static<typeof SScheduleRecurringArgs>;
export type TScheduleRecurringResult = TCronJob;

export function validateScheduleRecurringArgs(
  args: TScheduleRecurringArgs,
): TScheduleRecurringArgs {
  const normalizedArgs = { ...args, ...normalizeCronContentFields(args) };
  const contentModeCount = [
    normalizedArgs.reminderText,
    normalizedArgs.reminderPromptData,
    normalizedArgs.taskPrompt,
  ].filter((field) => field !== undefined).length;

  if (contentModeCount === 0) {
    throw new Error("Provide reminderText, reminderPromptData, or taskPrompt");
  }

  if (contentModeCount > 1) {
    throw new Error("Provide only one of reminderText, reminderPromptData, or taskPrompt");
  }

  if (
    normalizedArgs.reminderPromptData !== undefined &&
    normalizedArgs.reminderFallbackText === undefined
  ) {
    throw new Error("reminderFallbackText is required when reminderPromptData is set");
  }

  if (
    normalizedArgs.reminderFallbackText !== undefined &&
    normalizedArgs.reminderText === undefined &&
    normalizedArgs.reminderPromptData === undefined
  ) {
    throw new Error("reminderFallbackText requires reminderText or reminderPromptData");
  }

  if (normalizedArgs.taskPrompt !== undefined && normalizedArgs.taskFallbackText === undefined) {
    throw new Error("taskFallbackText is required when taskPrompt is set");
  }

  if (normalizedArgs.taskFallbackText !== undefined && normalizedArgs.taskPrompt === undefined) {
    throw new Error("taskFallbackText requires taskPrompt");
  }

  return normalizedArgs;
}
