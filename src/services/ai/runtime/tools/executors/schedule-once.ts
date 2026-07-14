import type { TOption } from "../../../../../types";
import { CronSingleton } from "../../../../cron";
import { SScheduleOnceArgs, type TScheduleOnceArgs } from "../../../tools/schedule-once/handler";
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

export async function executeScheduleOnceTool(
  toolCall: TToolCall,
  chatId: TOption<string>,
  ownerTimezone: string,
): Promise<TNormalizedToolResult> {
  const resolvedChatId = requireChatId(toolCall, chatId);

  if (resolvedChatId === undefined) {
    return createFailedToolResult(toolCall, `chatId is required for tool: ${toolCall.name}`);
  }

  const parsed = parseAndValidateToolArgs<TScheduleOnceArgs>(toolCall, SScheduleOnceArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  const result = await CronSingleton.instance.createOnce({
    name: parsed.data.name,
    scope: resolvedChatId,
    fireAt: parsed.data.fireAt,
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
    if (result.error === "fireAt must be in the future") {
      return createFailedToolResult(toolCall, result.error);
    }

    return createInternalToolFailure(toolCall, result.operation, result.error);
  }

  return createSuccessfulToolResult(toolCall, serializeCronJobForModel(result));
}
