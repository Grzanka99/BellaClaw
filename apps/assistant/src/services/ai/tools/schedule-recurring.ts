import { bool, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { CronSingleton } from "../../cron";
import { EConfigKey } from "../../settings/schema";
import {
  countCronContentModes,
  normalizeCronContentFields,
  validateCronFallbackPairing,
} from "./cron-content";
import { defineTool, requireChatId, ToolError } from "./define-tool";
import instructions from "./schedule-recurring.xml" with { type: "text" };

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

export function validateScheduleRecurringArgs(
  rawArgs: Static<typeof SScheduleRecurringArgs>,
): Static<typeof SScheduleRecurringArgs> {
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

  return args;
}

export const scheduleRecurring = defineTool({
  name: "schedule-recurring",
  label: "Schedule recurring job",
  description:
    "Schedule a recurring reminder or autonomous task requiring tools using a 5-field cron pattern. Provide exactly one content mode: reminderText; reminderPromptData with reminderFallbackText; or taskPrompt with taskFallbackText.",
  schema: SScheduleRecurringArgs,
  instructions,
  mode: "sequential",
  logSafe: ["overwrite", "type", ["pattern", "cronPattern"], "nextRunAt", "timezone", "status"],
  privateErrors: true,
  execute: async (context, args) => {
    const validatedArgs = validateScheduleRecurringArgs(args);
    const result = await CronSingleton.instance.createRecurring({
      ...validatedArgs,
      scope: requireChatId(context.chatId),
      timezone: context.settings[EConfigKey.AiInstructionsTimezone],
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
