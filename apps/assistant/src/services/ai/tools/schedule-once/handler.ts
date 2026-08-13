import { type Static, Type } from "@earendil-works/pi-ai";
import type { TCronJob } from "../../../../lib/cron-engine";
import {
  countCronContentModes,
  normalizeCronContentFields,
  validateCronFallbackPairing,
} from "../cron-content";

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

export function validateScheduleOnceArgs(rawArgs: TScheduleOnceArgs) {
  const args = { ...rawArgs, ...normalizeCronContentFields(rawArgs) };
  const contentModeCount = countCronContentModes(args);

  if (contentModeCount === 0) {
    throw new Error("Provide reminderText, reminderPromptData, or taskPrompt");
  }

  if (contentModeCount > 1) {
    throw new Error("Provide only one of reminderText, reminderPromptData, or taskPrompt");
  }

  validateCronFallbackPairing(args);

  return {
    ...args,
    fireAt: new Date(args.fireAt),
  };
}
