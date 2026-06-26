import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../../../types";
import { CronSingleton } from "../../../../cron";
import {
  SScheduleRecurringArgs,
  type TScheduleRecurringArgs,
} from "../../../tools/schedule-recurring/handler";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { requireChatId } from "../context";
import { serializeCronJobForModel } from "../cron-serialization";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

export async function executeScheduleRecurringTool(
  toolCall: ChatMessageToolCall,
  chatId: TOption<string>,
  ownerTimezone: string,
): Promise<TNormalizedToolResult> {
  const resolvedChatId = requireChatId(toolCall, chatId);

  if (resolvedChatId === undefined) {
    return createFailedToolResult(
      toolCall,
      `chatId is required for tool: ${toolCall.function.name}`,
    );
  }

  const parsed = parseAndValidateToolArgs<TScheduleRecurringArgs>(toolCall, SScheduleRecurringArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  const result = await CronSingleton.instance.schedule({
    name: parsed.data.name,
    scope: resolvedChatId,
    pattern: parsed.data.pattern,
    group: parsed.data.group,
    reminderText: parsed.data.reminderText,
    reminderPromptData: parsed.data.reminderPromptData,
    reminderFallbackText: parsed.data.reminderFallbackText,
    overwrite: parsed.data.overwrite,
    timezone: ownerTimezone,
  });

  if ("error" in result) {
    return createFailedToolResult(
      toolCall,
      `schedule-recurring failed during ${result.operation}: ${normalizeError(result.error)}`,
    );
  }

  return createSuccessfulToolResult(toolCall, serializeCronJobForModel(result));
}
