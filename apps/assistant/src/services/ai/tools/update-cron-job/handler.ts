import { arr, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import type { TCronJob } from "../../../../lib/cron-engine";
import { ECronJobType } from "../../../../lib/cron-engine";
import { AutomationService } from "../../../automation";
import { CronSingleton } from "../../../cron";
import {
  absentIfBlank,
  countCronContentModes,
  normalizeCronContentFields,
  parseLocalFireAt,
  validateCronAutomationsPairing,
  validateCronFallbackPairing,
} from "../cron-content";

export const SUpdateCronJobArgs = obj({
  name: str({ description: "Unique name of the existing cron job to update" }),
  pattern: opt(
    str({
      description:
        "New 5-field cron expression for a recurring job; omit to keep the current schedule",
    }),
  ),
  fireAt: opt(
    str({
      description:
        "New future local date-time for a one-time job in the owner's timezone, YYYY-MM-DDTHH:mm[:ss]; omit for recurring jobs and to keep the current time",
    }),
  ),
  group: opt(str({ description: "New group label; omit to preserve the current group" })),
  reminderText: opt(str({ description: "New plain reminder text" })),
  reminderPromptData: opt(str({ description: "New structured reminder prompt data" })),
  reminderFallbackText: opt(str({ description: "Fallback text required with reminderPromptData" })),
  taskPrompt: opt(str({ description: "New autonomous web task objective" })),
  taskFallbackText: opt(str({ description: "Fallback text required with taskPrompt" })),
  automations: opt(
    arr(str(), {
      description:
        "New ordered list of saved automation names; replaces the current list, an empty list removes all automations; omit to keep them",
    }),
  ),
});

export type TUpdateCronJobArgs = Static<typeof SUpdateCronJobArgs>;
export type TUpdateCronJobResult = TCronJob;

export function validateUpdateCronJobArgs(rawArgs: TUpdateCronJobArgs): TUpdateCronJobArgs {
  const args = {
    ...rawArgs,
    ...normalizeCronContentFields(rawArgs),
    pattern: absentIfBlank(rawArgs.pattern),
    fireAt: absentIfBlank(rawArgs.fireAt),
  };

  if (args.pattern !== undefined && args.fireAt !== undefined) {
    throw new Error("Provide either pattern or fireAt, not both");
  }

  if (countCronContentModes(args) > 1) {
    throw new Error("Provide only one of reminderText, reminderPromptData, or taskPrompt");
  }

  validateCronFallbackPairing(args);
  validateCronAutomationsPairing(args);

  return args;
}

export async function handleUpdateCronJob(
  chatId: string,
  parsedArgs: TUpdateCronJobArgs,
  timezone: string,
) {
  const validatedArgs = validateUpdateCronJobArgs(parsedArgs);
  const existing = await CronSingleton.instance.get(validatedArgs.name, chatId);

  if (existing === undefined) {
    throw new Error(`No job found with name: ${validatedArgs.name}`);
  }

  let reminderText = existing.reminderText;
  let reminderPromptData = existing.reminderPromptData;
  let reminderFallbackText = existing.reminderFallbackText;
  let taskPrompt = existing.taskPrompt;
  let taskFallbackText = existing.taskFallbackText;
  let automationIds = existing.automationIds;

  if (validatedArgs.automations !== undefined) {
    automationIds = await AutomationService.instance.resolveNames(
      chatId,
      validatedArgs.automations,
    );
  }

  if (validatedArgs.reminderText !== undefined) {
    reminderText = validatedArgs.reminderText;
    reminderPromptData = undefined;
    reminderFallbackText = validatedArgs.reminderFallbackText ?? existing.reminderFallbackText;
    taskPrompt = undefined;
    taskFallbackText = undefined;
  } else if (validatedArgs.reminderPromptData !== undefined) {
    reminderText = undefined;
    reminderPromptData = validatedArgs.reminderPromptData;
    reminderFallbackText = validatedArgs.reminderFallbackText ?? existing.reminderFallbackText;
    taskPrompt = undefined;
    taskFallbackText = undefined;
  } else if (validatedArgs.taskPrompt !== undefined) {
    reminderText = undefined;
    reminderPromptData = undefined;
    reminderFallbackText = undefined;
    taskPrompt = validatedArgs.taskPrompt;
    taskFallbackText = validatedArgs.taskFallbackText ?? existing.taskFallbackText;
  }

  if (
    automationIds.length > 0 &&
    (reminderText !== undefined || reminderPromptData !== undefined)
  ) {
    throw new Error(
      "automations can only be combined with taskPrompt, not with reminders; to turn this job into a reminder also pass automations: [] to remove its automations",
    );
  }

  if (
    reminderText === undefined &&
    reminderPromptData === undefined &&
    taskPrompt === undefined &&
    automationIds.length === 0
  ) {
    throw new Error(
      "Provide reminderText, reminderPromptData, or taskPrompt, or attach automations; removing all automations would leave this job without content",
    );
  }

  if (existing.type === ECronJobType.Recurring) {
    if (validatedArgs.fireAt !== undefined) {
      throw new Error(
        "fireAt can only update one-time reminders; omit fireAt for this recurring reminder and use pattern only to change its schedule",
      );
    }

    const pattern = validatedArgs.pattern ?? existing.pattern;

    if (pattern === undefined) {
      throw new Error("Existing recurring reminder has no pattern");
    }

    const result = await CronSingleton.instance.createRecurring({
      name: existing.name,
      scope: chatId,
      group: validatedArgs.group ?? existing.group,
      pattern,
      reminderText,
      reminderPromptData,
      reminderFallbackText,
      taskPrompt,
      taskFallbackText,
      automationIds,
      overwrite: true,
      timezone: existing.timezone,
    });

    if ("error" in result) {
      throw new Error(`${result.operation} failed: ${String(result.error)}`);
    }

    return result;
  }

  if (validatedArgs.pattern !== undefined) {
    throw new Error(
      "pattern can only update recurring reminders; omit pattern for this one-time reminder and use fireAt only to change its time",
    );
  }

  let fireAt = existing.nextRunAt;

  if (validatedArgs.fireAt !== undefined) {
    fireAt = parseLocalFireAt(validatedArgs.fireAt, timezone);
  }

  const result = await CronSingleton.instance.createOnce({
    name: existing.name,
    scope: chatId,
    group: validatedArgs.group ?? existing.group,
    fireAt,
    reminderText,
    reminderPromptData,
    reminderFallbackText,
    taskPrompt,
    taskFallbackText,
    automationIds,
    overwrite: true,
    timezone: existing.timezone,
  });

  if ("error" in result) {
    throw new Error(`${result.operation} failed: ${String(result.error)}`);
  }

  return result;
}
