import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../../../types";
import { CronSingleton } from "../../../../cron";
import { SScheduleOnceArgs, type TScheduleOnceArgs } from "../../../tools/schedule-once/handler";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { requireChatId } from "../context";
import { serializeCronJobForModel } from "../cron-serialization";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

export async function executeScheduleOnceTool(
  toolCall: ChatMessageToolCall,
  chatId: TOption<string>,
): Promise<TNormalizedToolResult> {
  const resolvedChatId = requireChatId(toolCall, chatId);

  if (resolvedChatId === undefined) {
    return createFailedToolResult(
      toolCall,
      `chatId is required for tool: ${toolCall.function.name}`,
    );
  }

  const parsed = parseAndValidateToolArgs<TScheduleOnceArgs>(toolCall, SScheduleOnceArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  const result = await CronSingleton.instance.scheduleOnce({
    name: parsed.data.name,
    scope: resolvedChatId,
    fireAt: parsed.data.fireAt,
    group: parsed.data.group,
    reminderText: parsed.data.reminderText,
    reminderPromptData: parsed.data.reminderPromptData,
    reminderFallbackText: parsed.data.reminderFallbackText,
    overwrite: parsed.data.overwrite,
  });

  if ("error" in result) {
    return createFailedToolResult(
      toolCall,
      `schedule-once failed during ${result.operation}: ${normalizeError(result.error)}`,
    );
  }

  return createSuccessfulToolResult(toolCall, serializeCronJobForModel(result));
}
