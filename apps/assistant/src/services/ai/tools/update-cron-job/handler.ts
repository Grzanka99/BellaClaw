import { type Static, Type } from "@earendil-works/pi-ai";
import type { TCronJob } from "../../../../lib/cron-engine";
import { ECronJobType } from "../../../../lib/cron-engine";
import { CronSingleton } from "../../../cron";
import {
  countCronContentModes,
  normalizeCronContentFields,
  validateCronFallbackPairing,
} from "../cron-content";

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

export function validateUpdateCronJobArgs(
  rawArgs: TUpdateCronJobArgs,
): TValidatedUpdateCronJobArgs {
  const args = { ...rawArgs, ...normalizeCronContentFields(rawArgs) };

  if (args.pattern !== undefined && args.fireAt !== undefined) {
    throw new Error("Provide either pattern or fireAt, not both");
  }

  if (countCronContentModes(args) > 1) {
    throw new Error("Provide only one of reminderText, reminderPromptData, or taskPrompt");
  }

  validateCronFallbackPairing(args);

  const { fireAt, ...rest } = args;

  if (fireAt === undefined) {
    return rest;
  }

  return {
    ...rest,
    fireAt: new Date(fireAt),
  };
}

export async function handleUpdateCronJob(chatId: string, parsedArgs: TUpdateCronJobArgs) {
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

  if (existing.type === ECronJobType.Recurring) {
    if (validatedArgs.fireAt !== undefined) {
      throw new Error(
        "fireAt can only update one-time reminders; use pattern for recurring reminders",
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
      "pattern can only update recurring reminders; use fireAt for one-time reminders",
    );
  }

  const result = await CronSingleton.instance.createOnce({
    name: existing.name,
    scope: chatId,
    group: validatedArgs.group ?? existing.group,
    fireAt: validatedArgs.fireAt ?? existing.nextRunAt,
    reminderText,
    reminderPromptData,
    reminderFallbackText,
    taskPrompt,
    taskFallbackText,
    overwrite: true,
    timezone: existing.timezone,
  });

  if ("error" in result) {
    throw new Error(`${result.operation} failed: ${String(result.error)}`);
  }

  return result;
}
