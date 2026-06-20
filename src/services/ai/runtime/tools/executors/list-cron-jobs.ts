import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../../../types";
import { CronSingleton } from "../../../../cron";
import { SListCronJobsArgs } from "../../../tools/list-cron-jobs/handler";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { requireChatId } from "../context";
import { serializeCronJobsForModel } from "../cron-serialization";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

export async function executeListCronJobsTool(
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

  const parsed = parseAndValidateToolArgs(toolCall, SListCronJobsArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  const jobs = await CronSingleton.instance.getAllJobs(resolvedChatId);

  return createSuccessfulToolResult(toolCall, serializeCronJobsForModel(jobs));
}
