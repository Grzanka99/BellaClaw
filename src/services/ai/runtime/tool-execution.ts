import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../types";
import { logger } from "../../../utils/logger";
import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "../../app-logger";
import {
  sanitizeErrorMessage,
  sanitizeToolCallArguments,
  sanitizeToolResult,
  sanitizeToolResultError,
} from "../../app-logger/sanitizers";
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
  trace?: TBehaviorTraceContext;
}): Promise<TNormalizedToolResult> {
  const { toolCall, chatId, allowedToolNames, settings, trace } = args;
  const toolName = toolCall.function.name;
  const ownerTimezone = settings[EConfigKey.AiInstructionsTimezone];
  const startedAt = performance.now();

  logToolCallStarted(toolCall, trace);

  if (!allowedToolNames.has(toolName)) {
    const result = createFailedToolResult(toolCall, `Unknown tool requested: ${toolName}`);
    logToolCallCompleted(result, trace, performance.now() - startedAt);
    return result;
  }

  logger.info(`[TOOL CALL] calling: ${toolName}`);

  try {
    let result: TNormalizedToolResult;

    switch (toolName) {
      case DEFINE_MESSAGE_IMPORTANCE_TOOL: {
        result = await executeDefineMessageImportanceTool(toolCall);
        break;
      }
      case DEFINE_SETTINGS_INTENT_TOOL: {
        result = await executeDefineSettingsIntentTool(toolCall);
        break;
      }
      case SEARCH_MEMORY_TOOL: {
        result = await executeSearchMemoryTool(toolCall, chatId);
        break;
      }
      case LIST_CRON_JOBS_TOOL: {
        result = await executeListCronJobsTool(toolCall, chatId);
        break;
      }
      case SCHEDULE_ONCE_TOOL: {
        result = await executeScheduleOnceTool(toolCall, chatId, ownerTimezone);
        break;
      }
      case SCHEDULE_RECURRING_TOOL: {
        result = await executeScheduleRecurringTool(toolCall, chatId, ownerTimezone);
        break;
      }
      case UNSCHEDULE_CRON_JOB_TOOL: {
        result = await executeUnscheduleCronJobTool(toolCall, chatId);
        break;
      }
      case UPDATE_CRON_JOB_TOOL: {
        result = await executeUpdateCronJobTool(toolCall, chatId);
        break;
      }
      case WEB_SEARCH_TOOL: {
        result = await executeWebSearchTool(toolCall);
        break;
      }
      case WEB_FETCH_TOOL: {
        result = await executeWebFetchTool(toolCall);
        break;
      }
      case GET_SETTINGS_TOOL: {
        result = await executeGetSettingsTool(toolCall, chatId);
        break;
      }
      case UPDATE_SETTINGS_TOOL: {
        result = await executeUpdateSettingsTool(toolCall, chatId);
        break;
      }
      default: {
        result = createFailedToolResult(toolCall, `Unknown tool requested: ${toolName}`);
        break;
      }
    }

    logToolCallCompleted(result, trace, performance.now() - startedAt);
    return result;
  } catch (error) {
    logToolCallErrored(toolName, trace, performance.now() - startedAt, error);
    throw error;
  }
}

function logToolCallStarted(toolCall: ChatMessageToolCall, trace: TOption<TBehaviorTraceContext>) {
  if (trace === undefined) {
    return;
  }

  const details = sanitizeToolCallArguments(toolCall);

  AppLogger.instance.record({
    trace,
    event: "tool.call.started",
    component: "tool-execution",
    toolName: toolCall.function.name,
    summary: details.summary,
    metadata: details.metadata,
  });
}

function logToolCallCompleted(
  result: TNormalizedToolResult,
  trace: TOption<TBehaviorTraceContext>,
  durationMs: number,
) {
  if (trace === undefined) {
    return;
  }

  const details = sanitizeToolResult(result);
  const error = sanitizeToolResultError(result);
  let level = EBehaviorLogLevel.Info;

  if (!result.success) {
    level = EBehaviorLogLevel.Warning;
  }

  AppLogger.instance.record({
    trace,
    event: "tool.call.completed",
    component: "tool-execution",
    level,
    toolName: result.toolName,
    success: result.success,
    durationMs,
    summary: details.summary,
    metadata: details.metadata,
    error,
  });
}

function logToolCallErrored(
  toolName: string,
  trace: TOption<TBehaviorTraceContext>,
  durationMs: number,
  error: unknown,
) {
  if (trace === undefined) {
    return;
  }

  AppLogger.instance.record({
    trace,
    event: "tool.call.completed",
    component: "tool-execution",
    level: EBehaviorLogLevel.Error,
    toolName,
    success: false,
    durationMs,
    summary: `${toolName} threw`,
    metadata: {
      status: "errored",
    },
    error: sanitizeErrorMessage(String(error)),
  });
}
