import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { ZodType } from "zod";
import type { TOption } from "../../../types";
import { createLogger } from "../../../utils/logger";
import { CronSingleton } from "../../cron";
import { Memory } from "../../memory";
import { sortByImportanceAndDates } from "../../memory/sort";
import { DEFINE_MESSAGE_IMPORTANCE_TOOL } from "../tools/define-message-importance/definition";
import {
  SDefineMessageImportance,
  type TDefineMessageImportance,
} from "../tools/define-message-importance/handler";
import { LIST_CRON_JOBS_TOOL } from "../tools/list-cron-jobs/definition";
import { SListCronJobsArgs } from "../tools/list-cron-jobs/handler";
import { SCHEDULE_RECURRING_TOOL } from "../tools/schedule-recurring/definition";
import {
  SScheduleRecurringArgs,
  type TScheduleRecurringArgs,
} from "../tools/schedule-recurring/handler";
import { SEARCH_MEMORY_TOOL } from "../tools/search-memory/definition";
import { SSearchMemoryArgs, type TSearchMemoryArgs } from "../tools/search-memory/handler";
import { UNSCHEDULE_RECURRING_TOOL } from "../tools/unschedule-recurring/definition";
import {
  SUnscheduleRecurringArgs,
  type TUnscheduleRecurringArgs,
} from "../tools/unschedule-recurring/handler";
import { normalizeError } from "./serialization";
import type { TNormalizedToolResult } from "./types";

const logger = createLogger("AI RUNTIME");

type TToolValidationResult<T> = { success: true; data: T } | { success: false; error: string };

function createSuccessfulToolResult(
  toolCall: ChatMessageToolCall,
  data: unknown,
): TNormalizedToolResult {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    success: true,
    data,
    error: undefined,
  };
}

function createFailedToolResult(
  toolCall: ChatMessageToolCall,
  error: string,
): TNormalizedToolResult {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    success: false,
    data: undefined,
    error,
  };
}

function parseAndValidateToolArgs<T>(
  toolCall: ChatMessageToolCall,
  schema: ZodType<T>,
): TToolValidationResult<T> {
  let argsJson: unknown;

  try {
    argsJson = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    return {
      success: false,
      error: `Invalid JSON arguments: ${normalizeError(error)}`,
    };
  }

  const parsed = schema.safeParse(argsJson);

  if (!parsed.success) {
    return {
      success: false,
      error: `Arguments validation failed: ${parsed.error.message}`,
    };
  }

  return {
    success: true,
    data: parsed.data,
  };
}

function requireChatId(toolCall: ChatMessageToolCall, chatId: TOption<string>): TOption<string> {
  if (chatId === undefined) {
    logger.warning(`chatId missing for tool ${toolCall.function.name}`);
    return undefined;
  }

  return chatId;
}

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
      const parsed = parseAndValidateToolArgs<TDefineMessageImportance>(
        toolCall,
        SDefineMessageImportance,
      );

      if (!parsed.success) {
        return createFailedToolResult(toolCall, parsed.error);
      }

      return createSuccessfulToolResult(toolCall, parsed.data);
    }
    case SEARCH_MEMORY_TOOL: {
      const resolvedChatId = requireChatId(toolCall, chatId);

      if (resolvedChatId === undefined) {
        return createFailedToolResult(toolCall, `chatId is required for tool: ${toolName}`);
      }

      const parsed = parseAndValidateToolArgs<TSearchMemoryArgs>(toolCall, SSearchMemoryArgs);

      if (!parsed.success) {
        return createFailedToolResult(toolCall, parsed.error);
      }

      const result = await Memory.instance.find({
        chatId: resolvedChatId,
        searchString: parsed.data.searchString,
        importance: parsed.data.importance,
        limit: parsed.data.limit,
        timeRange:
          parsed.data.timeRange === undefined
            ? undefined
            : {
                start: new Date(parsed.data.timeRange.start),
                end: new Date(parsed.data.timeRange.end),
              },
      });

      if ("operation" in result) {
        return createFailedToolResult(
          toolCall,
          `search-memory failed during ${result.operation}: ${normalizeError(result.error)}`,
        );
      }

      result.sort(sortByImportanceAndDates);

      return createSuccessfulToolResult(toolCall, { memories: result });
    }
    case LIST_CRON_JOBS_TOOL: {
      const resolvedChatId = requireChatId(toolCall, chatId);

      if (resolvedChatId === undefined) {
        return createFailedToolResult(toolCall, `chatId is required for tool: ${toolName}`);
      }

      const parsed = parseAndValidateToolArgs(toolCall, SListCronJobsArgs);

      if (!parsed.success) {
        return createFailedToolResult(toolCall, parsed.error);
      }

      const jobs = await CronSingleton.instance.getAllJobs(resolvedChatId);

      return createSuccessfulToolResult(toolCall, jobs);
    }
    case SCHEDULE_RECURRING_TOOL: {
      const resolvedChatId = requireChatId(toolCall, chatId);

      if (resolvedChatId === undefined) {
        return createFailedToolResult(toolCall, `chatId is required for tool: ${toolName}`);
      }

      const parsed = parseAndValidateToolArgs<TScheduleRecurringArgs>(
        toolCall,
        SScheduleRecurringArgs,
      );

      if (!parsed.success) {
        return createFailedToolResult(toolCall, parsed.error);
      }

      const result = await CronSingleton.instance.schedule({
        name: parsed.data.name,
        scope: resolvedChatId,
        pattern: parsed.data.pattern,
        group: parsed.data.group,
        overwrite: parsed.data.overwrite,
      });

      if ("error" in result) {
        return createFailedToolResult(
          toolCall,
          `schedule-recurring failed during ${result.operation}: ${normalizeError(result.error)}`,
        );
      }

      return createSuccessfulToolResult(toolCall, result);
    }
    case UNSCHEDULE_RECURRING_TOOL: {
      const resolvedChatId = requireChatId(toolCall, chatId);

      if (resolvedChatId === undefined) {
        return createFailedToolResult(toolCall, `chatId is required for tool: ${toolName}`);
      }

      const parsed = parseAndValidateToolArgs<TUnscheduleRecurringArgs>(
        toolCall,
        SUnscheduleRecurringArgs,
      );

      if (!parsed.success) {
        return createFailedToolResult(toolCall, parsed.error);
      }

      const result = await CronSingleton.instance.unschedule(parsed.data.name, resolvedChatId);

      if ("error" in result) {
        return createFailedToolResult(
          toolCall,
          `unschedule-recurring failed during ${result.operation}: ${normalizeError(result.error)}`,
        );
      }

      return createSuccessfulToolResult(toolCall, result);
    }
    default: {
      return createFailedToolResult(toolCall, `Unknown tool requested: ${toolName}`);
    }
  }
}
