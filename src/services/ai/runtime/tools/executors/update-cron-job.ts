import { ECronJobType } from "../../../../../lib/cron-engine";
import type { TOption } from "../../../../../types";
import { CronSingleton } from "../../../../cron";
import {
  SUpdateCronJobArgs,
  type TUpdateCronJobArgs,
} from "../../../tools/update-cron-job/handler";
import type { TToolCall } from "../../../types";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { requireChatId } from "../context";
import { serializeCronJobForModel } from "../cron-serialization";
import {
  createFailedToolResult,
  createInternalToolFailure,
  createSuccessfulToolResult,
} from "../results";

export async function executeUpdateCronJobTool(
  toolCall: TToolCall,
  chatId: TOption<string>,
): Promise<TNormalizedToolResult> {
  const resolvedChatId = requireChatId(toolCall, chatId);

  if (resolvedChatId === undefined) {
    return createFailedToolResult(toolCall, `chatId is required for tool: ${toolCall.name}`);
  }

  const parsed = parseAndValidateToolArgs<TUpdateCronJobArgs>(toolCall, SUpdateCronJobArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  const existing = await CronSingleton.instance.get(parsed.data.name, resolvedChatId);

  if (existing === undefined) {
    return createFailedToolResult(toolCall, `No job found with name: ${parsed.data.name}`);
  }

  let reminderText: TOption<string> = existing.reminderText;
  let reminderPromptData: TOption<string> = existing.reminderPromptData;
  let reminderFallbackText: TOption<string> = existing.reminderFallbackText;

  if (parsed.data.reminderText !== undefined) {
    reminderText = parsed.data.reminderText;
    reminderPromptData = undefined;
    reminderFallbackText = undefined;
  } else if (parsed.data.reminderPromptData !== undefined) {
    reminderText = undefined;
    reminderPromptData = parsed.data.reminderPromptData;
    reminderFallbackText = parsed.data.reminderFallbackText;
  }

  if (existing.type === ECronJobType.Recurring) {
    if (parsed.data.fireAt !== undefined) {
      return createFailedToolResult(
        toolCall,
        "fireAt can only update one-time reminders; use pattern for recurring reminders",
      );
    }

    const pattern = parsed.data.pattern ?? existing.pattern;

    if (pattern === undefined) {
      return createFailedToolResult(toolCall, "Existing recurring reminder has no pattern");
    }

    const result = await CronSingleton.instance.createRecurring({
      name: existing.name,
      scope: resolvedChatId,
      group: parsed.data.group ?? existing.group,
      pattern,
      reminderText,
      reminderPromptData,
      reminderFallbackText,
      overwrite: true,
      timezone: existing.timezone,
    });

    if ("error" in result) {
      return createInternalToolFailure(toolCall, result.operation, result.error);
    }

    return createSuccessfulToolResult(toolCall, serializeCronJobForModel(result));
  }

  if (parsed.data.pattern !== undefined) {
    return createFailedToolResult(
      toolCall,
      "pattern can only update recurring reminders; use fireAt for one-time reminders",
    );
  }

  const result = await CronSingleton.instance.createOnce({
    name: existing.name,
    scope: resolvedChatId,
    group: parsed.data.group ?? existing.group,
    fireAt: parsed.data.fireAt ?? existing.nextRunAt,
    reminderText,
    reminderPromptData,
    reminderFallbackText,
    overwrite: true,
    timezone: existing.timezone,
  });

  if ("error" in result) {
    return createInternalToolFailure(toolCall, result.operation, result.error);
  }

  return createSuccessfulToolResult(toolCall, serializeCronJobForModel(result));
}
