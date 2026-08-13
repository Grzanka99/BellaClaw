import { type Static, Type } from "@earendil-works/pi-ai";
import type { TCronJob } from "../../../../lib/cron-engine";
import { normalizeCronContentFields } from "../cron-content";

export const SUpdateCronJobArgs = Type.Object(
  {
    name: Type.String({ description: "Unique name of the existing cron job to update" }),
    pattern: Type.Optional(
      Type.String({ description: "New 5-field cron expression for a recurring reminder" }),
    ),
    fireAt: Type.Optional(
      Type.String({ format: "date-time", description: "New future ISO 8601 date-time" }),
    ),
    group: Type.Optional(
      Type.String({ description: "New group label; omit to preserve the current group" }),
    ),
    reminderText: Type.Optional(Type.String({ description: "New plain reminder text" })),
    reminderPromptData: Type.Optional(
      Type.String({ description: "New structured reminder prompt data" }),
    ),
    reminderFallbackText: Type.Optional(
      Type.String({ description: "Fallback text required with reminderPromptData" }),
    ),
    taskPrompt: Type.Optional(Type.String({ description: "New autonomous web task objective" })),
    taskFallbackText: Type.Optional(
      Type.String({ description: "Fallback text required with taskPrompt" }),
    ),
  },
  { additionalProperties: false },
);

export type TUpdateCronJobArgs = Static<typeof SUpdateCronJobArgs>;
export type TUpdateCronJobResult = TCronJob;

type TValidatedUpdateCronJobArgs = Omit<TUpdateCronJobArgs, "fireAt"> & {
  fireAt?: Date;
};

export function validateUpdateCronJobArgs(args: TUpdateCronJobArgs): TValidatedUpdateCronJobArgs {
  if (args.pattern !== undefined && args.fireAt !== undefined) {
    throw new Error("Provide either pattern or fireAt, not both");
  }

  const normalizedArgs = { ...args, ...normalizeCronContentFields(args) };
  const contentModeCount = [
    normalizedArgs.reminderText,
    normalizedArgs.reminderPromptData,
    normalizedArgs.taskPrompt,
  ].filter((field) => field !== undefined).length;

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

  const { fireAt, ...rest } = normalizedArgs;

  if (fireAt === undefined) {
    return rest;
  }

  return {
    ...rest,
    fireAt: new Date(fireAt),
  };
}
