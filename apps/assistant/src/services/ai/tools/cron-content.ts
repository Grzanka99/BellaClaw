import type { TOption } from "@bellaclaw/shared";

type TCronContentFields = {
  group?: TOption<string>;
  reminderText?: TOption<string>;
  reminderPromptData?: TOption<string>;
  reminderFallbackText?: TOption<string>;
  taskPrompt?: TOption<string>;
  taskFallbackText?: TOption<string>;
};

/**
 * Models routinely send "" for optional content fields they mean to omit.
 * Blank values must be treated as absent so they neither trip the
 * one-content-mode checks nor overwrite stored job content.
 */
export function normalizeCronContentFields(args: TCronContentFields): TCronContentFields {
  return {
    group: args.group || undefined,
    reminderText: args.reminderText || undefined,
    reminderPromptData: args.reminderPromptData || undefined,
    reminderFallbackText: args.reminderFallbackText || undefined,
    taskPrompt: args.taskPrompt || undefined,
    taskFallbackText: args.taskFallbackText || undefined,
  };
}
