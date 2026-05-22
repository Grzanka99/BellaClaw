import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../types";
import { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "../tools/define-message-importance/definition";
import { LIST_CRON_JOBS_TOOL } from "../tools/list-cron-jobs/definition";
import { SCHEDULE_ONCE_TOOL } from "../tools/schedule-once/definition";
import { SCHEDULE_RECURRING_TOOL } from "../tools/schedule-recurring/definition";
import { SEARCH_MEMORY_TOOL } from "../tools/search-memory/definition";
import { UNSCHEDULE_CRON_JOB_TOOL } from "../tools/unschedule-cron-job/definition";
import { executeDefineMessageImportanceTool } from "./tools/executors/define-message-importance";
import { executeListCronJobsTool } from "./tools/executors/list-cron-jobs";
import { executeScheduleOnceTool } from "./tools/executors/schedule-once";
import { executeScheduleRecurringTool } from "./tools/executors/schedule-recurring";
import { executeSearchMemoryTool } from "./tools/executors/search-memory";
import { executeUnscheduleCronJobTool } from "./tools/executors/unschedule-cron-job";
import { createFailedToolResult } from "./tools/results";
import type { TNormalizedToolResult } from "./types";

export async function executeToolCall(args: {
  toolCall: ChatMessageToolCall;
  chatId: TOption<string>;
  allowedToolNames: Set<string>;
}): Promise<TNormalizedToolResult> {
  const { toolCall, chatId, allowedToolNames } = args;
  const toolName = toolCall.function.name;

  if (!allowedToolNames.has(toolName)) {
    return createFailedToolResult(toolCall, `Unknown tool requested: ${toolName}`);
  }

  switch (toolName) {
    case DEFINE_MESSAGE_IMPORTANCE_TOOL: {
      return executeDefineMessageImportanceTool(toolCall);
    }
    case SEARCH_MEMORY_TOOL: {
      return executeSearchMemoryTool(toolCall, chatId);
    }
    case LIST_CRON_JOBS_TOOL: {
      return executeListCronJobsTool(toolCall, chatId);
    }
    case SCHEDULE_ONCE_TOOL: {
      return executeScheduleOnceTool(toolCall, chatId);
    }
    case SCHEDULE_RECURRING_TOOL: {
      return executeScheduleRecurringTool(toolCall, chatId);
    }
    case UNSCHEDULE_CRON_JOB_TOOL: {
      return executeUnscheduleCronJobTool(toolCall, chatId);
    }
    default: {
      return createFailedToolResult(toolCall, `Unknown tool requested: ${toolName}`);
    }
  }
}
