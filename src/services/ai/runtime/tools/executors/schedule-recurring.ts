import type { TOption } from "../../../../../types";
import { CronSingleton } from "../../../../cron";
import {
  SScheduleRecurringArgs,
  type TScheduleRecurringArgs,
} from "../../../tools/schedule-recurring/handler";
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

export async function executeScheduleRecurringTool(
  toolCall: TToolCall,
  chatId: TOption<string>,
  ownerTimezone: string,
): Promise<TNormalizedToolResult> {
  const resolvedChatId = requireChatId(toolCall, chatId);

  if (resolvedChatId === undefined) {
    return createFailedToolResult(toolCall, `chatId is required for tool: ${toolCall.name}`);
  }

  const parsed = parseAndValidateToolArgs<TScheduleRecurringArgs>(toolCall, SScheduleRecurringArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  const result = await CronSingleton.instance.createRecurring({
    name: parsed.data.name,
    scope: resolvedChatId,
    pattern: parsed.data.pattern,
    group: parsed.data.group,
    reminderText: parsed.data.reminderText,
    reminderPromptData: parsed.data.reminderPromptData,
    reminderFallbackText: parsed.data.reminderFallbackText,
    taskPrompt: parsed.data.taskPrompt,
    taskFallbackText: parsed.data.taskFallbackText,
    overwrite: parsed.data.overwrite,
    timezone: ownerTimezone,
  });

  if ("error" in result) {
    return createInternalToolFailure(toolCall, result.operation, result.error);
  }

  return createSuccessfulToolResult(toolCall, serializeCronJobForModel(result));
}
