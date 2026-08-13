import { type Static, Type } from "@earendil-works/pi-ai";
import type { TCronJob } from "../../../../lib/cron-engine";

export const SScheduleOnceArgs = Type.Object(
  {
    name: Type.String({
      description: "Unique one-time job name used to reference, update, or cancel it",
    }),
    fireAt: Type.String({
      format: "date-time",
      description: "Future ISO 8601 date-time with an explicit timezone",
    }),
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
      Type.Boolean({ description: "Replace an existing one-time job with the same name" }),
    ),
  },
  { additionalProperties: false },
);

export type TScheduleOnceArgs = Static<typeof SScheduleOnceArgs>;
export type TScheduleOnceResult = TCronJob;

export function validateScheduleOnceArgs(args: TScheduleOnceArgs) {
  const normalizedArgs = {
    ...args,
    reminderText: args.reminderText || undefined,
    reminderPromptData: args.reminderPromptData || undefined,
    reminderFallbackText: args.reminderFallbackText || undefined,
    taskPrompt: args.taskPrompt || undefined,
    taskFallbackText: args.taskFallbackText || undefined,
  };
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

  validateFallbackPairing(normalizedArgs);

  return {
    ...normalizedArgs,
    fireAt: new Date(args.fireAt),
  };
}

function validateFallbackPairing(args: TScheduleOnceArgs): void {
  if (args.reminderPromptData !== undefined && args.reminderFallbackText === undefined) {
    throw new Error("reminderFallbackText is required when reminderPromptData is set");
  }

  if (
    args.reminderFallbackText !== undefined &&
    args.reminderText === undefined &&
    args.reminderPromptData === undefined
  ) {
    throw new Error("reminderFallbackText requires reminderText or reminderPromptData");
  }

  if (args.taskPrompt !== undefined && args.taskFallbackText === undefined) {
    throw new Error("taskFallbackText is required when taskPrompt is set");
  }

  if (args.taskFallbackText !== undefined && args.taskPrompt === undefined) {
    throw new Error("taskFallbackText requires taskPrompt");
  }
}
