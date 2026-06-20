import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../types";
import { logger } from "../../../utils/logger";
import { EConfigKey, type TConfigRecord } from "../../settings/schema";
import { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "../tools/define-message-importance/definition";
import { DEFINE_SETTINGS_INTENT_TOOL } from "../tools/define-settings-intent/definition";
import { GET_SETTINGS_TOOL } from "../tools/get-settings/definition";
import { LIST_CRON_JOBS_TOOL } from "../tools/list-cron-jobs/definition";
import { SCHEDULE_ONCE_TOOL } from "../tools/schedule-once/definition";
import { SCHEDULE_RECURRING_TOOL } from "../tools/schedule-recurring/definition";
import { SEARCH_MEMORY_TOOL } from "../tools/search-memory/definition";
import { UNSCHEDULE_CRON_JOB_TOOL } from "../tools/unschedule-cron-job/definition";
import { UPDATE_CRON_JOB_TOOL } from "../tools/update-cron-job/definition";
import { UPDATE_SETTINGS_TOOL } from "../tools/update-settings/definition";
import { WEB_FETCH_TOOL } from "../tools/web-fetch/definition";
import { WEB_SEARCH_TOOL } from "../tools/web-search/definition";
import { executeDefineMessageImportanceTool } from "./tools/executors/define-message-importance";
import { executeDefineSettingsIntentTool } from "./tools/executors/define-settings-intent";
import { executeGetSettingsTool } from "./tools/executors/get-settings";
import { executeListCronJobsTool } from "./tools/executors/list-cron-jobs";
import { executeScheduleOnceTool } from "./tools/executors/schedule-once";
import { executeScheduleRecurringTool } from "./tools/executors/schedule-recurring";
import { executeSearchMemoryTool } from "./tools/executors/search-memory";
import { executeUnscheduleCronJobTool } from "./tools/executors/unschedule-cron-job";
import { executeUpdateCronJobTool } from "./tools/executors/update-cron-job";
import { executeUpdateSettingsTool } from "./tools/executors/update-settings";
import { executeWebFetchTool } from "./tools/executors/web-fetch";
import { executeWebSearchTool } from "./tools/executors/web-search";
import { createFailedToolResult } from "./tools/results";
import type { TNormalizedToolResult } from "./types";

export async function executeToolCall(args: {
  toolCall: ChatMessageToolCall;
  chatId: TOption<string>;
  allowedToolNames: Set<string>;
  settings: TConfigRecord;
}): Promise<TNormalizedToolResult> {
  const { toolCall, chatId, allowedToolNames, settings } = args;
  const toolName = toolCall.function.name;
  const ownerTimezone = settings[EConfigKey.AiInstructionsTimezone];

  if (!allowedToolNames.has(toolName)) {
    return createFailedToolResult(toolCall, `Unknown tool requested: ${toolName}`);
  }

  logger.info(`[TOOL CALL] calling: ${toolName}`);

  switch (toolName) {
    case DEFINE_MESSAGE_IMPORTANCE_TOOL: {
      return executeDefineMessageImportanceTool(toolCall);
    }
    case DEFINE_SETTINGS_INTENT_TOOL: {
      return executeDefineSettingsIntentTool(toolCall);
    }
    case SEARCH_MEMORY_TOOL: {
      return executeSearchMemoryTool(toolCall, chatId);
    }
    case LIST_CRON_JOBS_TOOL: {
      return executeListCronJobsTool(toolCall, chatId, ownerTimezone);
    }
    case SCHEDULE_ONCE_TOOL: {
      return executeScheduleOnceTool(toolCall, chatId, ownerTimezone);
    }
    case SCHEDULE_RECURRING_TOOL: {
      return executeScheduleRecurringTool(toolCall, chatId, ownerTimezone);
    }
    case UNSCHEDULE_CRON_JOB_TOOL: {
      return executeUnscheduleCronJobTool(toolCall, chatId, ownerTimezone);
    }
    case UPDATE_CRON_JOB_TOOL: {
      return executeUpdateCronJobTool(toolCall, chatId, ownerTimezone);
    }
    case WEB_SEARCH_TOOL: {
      return executeWebSearchTool(toolCall);
    }
    case WEB_FETCH_TOOL: {
      return executeWebFetchTool(toolCall);
    }
    case GET_SETTINGS_TOOL: {
      return executeGetSettingsTool(toolCall, chatId);
    }
    case UPDATE_SETTINGS_TOOL: {
      return executeUpdateSettingsTool(toolCall, chatId);
    }
    default: {
      return createFailedToolResult(toolCall, `Unknown tool requested: ${toolName}`);
    }
  }
}
