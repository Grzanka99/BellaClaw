import type { TOption } from "../../../../../types";
import { CronSingleton } from "../../../../cron";
import {
  SUnscheduleCronJobArgs,
  type TUnscheduleCronJobArgs,
} from "../../../tools/unschedule-cron-job/handler";
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

export async function executeUnscheduleCronJobTool(
  toolCall: TToolCall,
  chatId: TOption<string>,
): Promise<TNormalizedToolResult> {
  const resolvedChatId = requireChatId(toolCall, chatId);

  if (resolvedChatId === undefined) {
    return createFailedToolResult(toolCall, `chatId is required for tool: ${toolCall.name}`);
  }

  const parsed = parseAndValidateToolArgs<TUnscheduleCronJobArgs>(toolCall, SUnscheduleCronJobArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  const result = await CronSingleton.instance.cancel(parsed.data.name, resolvedChatId);

  if ("error" in result) {
    return createInternalToolFailure(toolCall, result.operation, result.error);
  }

  return createSuccessfulToolResult(toolCall, serializeCronJobForModel(result));
}
