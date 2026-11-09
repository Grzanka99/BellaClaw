import { bool, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import type { TCronJob } from "../../../../lib/cron-engine";
import {
  countCronContentModes,
  normalizeCronContentFields,
  validateCronFallbackPairing,
} from "../cron-content";

export const SScheduleRecurringArgs = obj({
  name: str({
    description: "Unique recurring job name used to reference, update, or cancel it",
  }),
  pattern: str({ description: "Standard 5-field cron expression" }),
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
  overwrite: opt(bool({ description: "Replace an existing recurring job with the same name" })),
});

export type TScheduleRecurringArgs = Static<typeof SScheduleRecurringArgs>;
export type TScheduleRecurringResult = TCronJob;

export function validateScheduleRecurringArgs(
  rawArgs: TScheduleRecurringArgs,
): TScheduleRecurringArgs {
  const args = { ...rawArgs, ...normalizeCronContentFields(rawArgs) };
  const contentModeCount = countCronContentModes(args);

  if (contentModeCount === 0) {
    throw new Error("Provide reminderText, reminderPromptData, or taskPrompt");
  }

  if (contentModeCount > 1) {
    throw new Error("Provide only one of reminderText, reminderPromptData, or taskPrompt");
  }

  validateCronFallbackPairing(args);

  return args;
}
