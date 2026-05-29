import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { searchWeb } from "../../../../../lib/web";
import { SWebSearchArgs, type TWebSearchArgs } from "../../../tools/web-search/handler";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

export async function executeWebSearchTool(
  toolCall: ChatMessageToolCall,
): Promise<TNormalizedToolResult> {
  const parsed = parseAndValidateToolArgs<TWebSearchArgs>(toolCall, SWebSearchArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  try {
    const results = await searchWeb(parsed.data);

    return createSuccessfulToolResult(toolCall, {
      query: parsed.data.query,
      results,
    });
  } catch (error) {
    return createFailedToolResult(toolCall, normalizeError(error));
  }
}
