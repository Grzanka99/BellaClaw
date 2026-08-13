import type { TOption } from "@bellaclaw/shared";

type TCronContentFields = {
  group?: string;
  reminderText?: string;
  reminderPromptData?: string;
  reminderFallbackText?: string;
  taskPrompt?: string;
  taskFallbackText?: string;
};

function absentIfBlank(value?: string): TOption<string> {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value;
}

/**
 * Models routinely send "" or whitespace for optional content fields they mean
 * to omit. Blank values must be treated as absent so they neither trip the
 * one-content-mode checks nor overwrite stored job content.
 */
export function normalizeCronContentFields(args: TCronContentFields): TCronContentFields {
  return {
    group: absentIfBlank(args.group),
    reminderText: absentIfBlank(args.reminderText),
    reminderPromptData: absentIfBlank(args.reminderPromptData),
    reminderFallbackText: absentIfBlank(args.reminderFallbackText),
    taskPrompt: absentIfBlank(args.taskPrompt),
    taskFallbackText: absentIfBlank(args.taskFallbackText),
  };
}

export function countCronContentModes(args: TCronContentFields): number {
  return [args.reminderText, args.reminderPromptData, args.taskPrompt].filter(
    (field) => field !== undefined,
  ).length;
}

export function validateCronFallbackPairing(args: TCronContentFields): void {
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
