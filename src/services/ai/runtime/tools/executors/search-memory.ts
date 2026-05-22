import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../../../types";
import { Memory } from "../../../../memory";
import { sortByImportanceAndDates } from "../../../../memory/sort";
import { SSearchMemoryArgs, type TSearchMemoryArgs } from "../../../tools/search-memory/handler";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { requireChatId } from "../context";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

export async function executeSearchMemoryTool(
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
