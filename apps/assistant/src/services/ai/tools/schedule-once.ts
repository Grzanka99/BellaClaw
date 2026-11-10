import { bool, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { CronSingleton } from "../../cron";
import { EConfigKey } from "../../settings/schema";
import {
  countCronContentModes,
  LOCAL_FIRE_AT_PATTERN,
  normalizeCronContentFields,
  parseLocalFireAt,
  validateCronFallbackPairing,
} from "./cron-content";
import { defineTool, requireChatId, ToolError } from "./define-tool";
import instructions from "./schedule-once.xml" with { type: "text" };

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

export function validateScheduleOnceArgs(
  rawArgs: Static<typeof SScheduleOnceArgs>,
  timezone: string,
) {
  const args = { ...rawArgs, ...normalizeCronContentFields(rawArgs) };
  const contentModeCount = countCronContentModes(args);

  if (contentModeCount === 0) {
    throw new ToolError(
      "missing-content",
      "Provide reminderText, reminderPromptData, or taskPrompt",
    );
  }

  if (contentModeCount > 1) {
    throw new ToolError(
      "conflicting-content-modes",
      "Provide only one of reminderText, reminderPromptData, or taskPrompt",
    );
  }

  validateCronFallbackPairing(args);

  return {
    ...args,
    fireAt: parseLocalFireAt(args.fireAt, timezone),
  };
}

export const scheduleOnce = defineTool({
  name: "schedule-once",
  label: "Schedule one-time job",
  description:
    "Schedule a one-time reminder or autonomous task requiring tools. Provide exactly one content mode: reminderText; reminderPromptData with reminderFallbackText; or taskPrompt with taskFallbackText.",
  schema: SScheduleOnceArgs,
  instructions,
  mode: "sequential",
  logSafe: [
    "fireAt",
    "overwrite",
    "type",
    ["pattern", "cronPattern"],
    "nextRunAt",
    "timezone",
    "status",
  ],
  privateErrors: true,
  execute: async (context, args) => {
    const ownerTimezone = context.settings[EConfigKey.AiInstructionsTimezone];
    const validatedArgs = validateScheduleOnceArgs(args, ownerTimezone);
    const result = await CronSingleton.instance.createOnce({
      ...validatedArgs,
      scope: requireChatId(context.chatId),
      timezone: ownerTimezone,
    });

    if ("error" in result) {
      throw new ToolError(
        `${result.operation}-failed`,
        `${result.operation} failed: ${String(result.error)}`,
      );
    }

    return result;
  },
});
