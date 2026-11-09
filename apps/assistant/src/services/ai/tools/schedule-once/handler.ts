import { bool, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import type { TCronJob } from "../../../../lib/cron-engine";
import {
  countCronContentModes,
  LOCAL_FIRE_AT_PATTERN,
  normalizeCronContentFields,
  parseLocalFireAt,
  validateCronFallbackPairing,
} from "../cron-content";

export const SScheduleOnceArgs = obj({
  name: str({
    description: "Unique one-time job name used to reference, update, or cancel it",
  }),
  fireAt: str({
    pattern: LOCAL_FIRE_AT_PATTERN,
    description: "Future local date-time in the owner's timezone, YYYY-MM-DDTHH:mm[:ss], no offset",
  }),
  group: opt(str({ description: "Optional group label stored with the cron job" })),
  reminderText: opt(
    str({ description: "Plain reminder text for a direct, non-generated reminder" }),
  ),
  reminderPromptData: opt(
    str({ description: "Structured reminder prompt data serialized as JSON" }),
  ),
  reminderFallbackText: opt(str({ description: "Fallback text required with reminderPromptData" })),
  taskPrompt: opt(str({ description: "Autonomous objective requiring tools at firing time" })),
  taskFallbackText: opt(str({ description: "Fallback text required with taskPrompt" })),
  overwrite: opt(bool({ description: "Replace an existing one-time job with the same name" })),
});

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
