import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../../../types";
import { CronSingleton } from "../../../../cron";
import {
  SUnscheduleCronJobArgs,
  type TUnscheduleCronJobArgs,
} from "../../../tools/unschedule-cron-job/handler";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { requireChatId } from "../context";
import { serializeCronJobForModel } from "../cron-serialization";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

export async function executeUnscheduleCronJobTool(
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

  const parsed = parseAndValidateToolArgs<TUnscheduleCronJobArgs>(toolCall, SUnscheduleCronJobArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  const result = await CronSingleton.instance.unschedule(parsed.data.name, resolvedChatId);

  if ("error" in result) {
    return createFailedToolResult(
      toolCall,
      `unschedule-cron-job failed during ${result.operation}: ${normalizeError(result.error)}`,
    );
  }

  return createSuccessfulToolResult(toolCall, serializeCronJobForModel(result));
}
