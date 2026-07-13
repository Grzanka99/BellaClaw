import type { TOption } from "../../../../../types";
import { Memory } from "../../../../memory";
import { sortByImportanceAndDates } from "../../../../memory/sort";
import { SSearchMemoryArgs, type TSearchMemoryArgs } from "../../../tools/search-memory/handler";
import type { TToolCall } from "../../../types";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { requireChatId } from "../context";
import {
  createFailedToolResult,
  createInternalToolFailure,
  createSuccessfulToolResult,
} from "../results";

export async function executeSearchMemoryTool(
  toolCall: TToolCall,
  chatId: TOption<string>,
): Promise<TNormalizedToolResult> {
  const resolvedChatId = requireChatId(toolCall, chatId);

  if (resolvedChatId === undefined) {
    return createFailedToolResult(toolCall, `chatId is required for tool: ${toolCall.name}`);
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
    timeRange: parsed.data.timeRange,
  });

  if ("operation" in result) {
    return createInternalToolFailure(toolCall, result.operation, result.error);
  }

  result.sort(sortByImportanceAndDates);

  return createSuccessfulToolResult(toolCall, { memories: result });
}
