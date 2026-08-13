import type { TOption } from "@bellaclaw/shared";

type TCronContentFields = {
  group?: TOption<string>;
  reminderText?: TOption<string>;
  reminderPromptData?: TOption<string>;
  reminderFallbackText?: TOption<string>;
  taskPrompt?: TOption<string>;
  taskFallbackText?: TOption<string>;
};

function absentIfBlank(value: TOption<string>): TOption<string> {
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
