import { type Static, Type } from "@earendil-works/pi-ai";
import type { TCronJob } from "../../../../lib/cron-engine";
import {
  countCronContentModes,
  LOCAL_FIRE_AT_PATTERN,
  normalizeCronContentFields,
  parseLocalFireAt,
  validateCronFallbackPairing,
} from "../cron-content";

export const SScheduleOnceArgs = Type.Object(
  {
    name: Type.String({
      description: "Unique one-time job name used to reference, update, or cancel it",
    }),
    fireAt: Type.String({
      pattern: LOCAL_FIRE_AT_PATTERN,
      description:
        "Future local date-time in the owner's timezone, YYYY-MM-DDTHH:mm[:ss], no offset",
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
      Type.String({ description: "Autonomous objective requiring tools at firing time" }),
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

export function validateScheduleOnceArgs(rawArgs: TScheduleOnceArgs, timezone: string) {
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
    fireAt: parseLocalFireAt(args.fireAt, timezone),
  };
}
