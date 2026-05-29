import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { fetchWeb } from "../../../../../lib/web";
import { SWebFetchArgs, type TWebFetchArgs } from "../../../tools/web-fetch/handler";
import { normalizeError } from "../../serialization";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

export { fetchWeb } from "../../../../../lib/web";

export async function executeWebFetchTool(
  toolCall: ChatMessageToolCall,
): Promise<TNormalizedToolResult> {
  const parsed = parseAndValidateToolArgs<TWebFetchArgs>(toolCall, SWebFetchArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  try {
    const result = await fetchWeb(parsed.data);

    return createSuccessfulToolResult(toolCall, result);
  } catch (error) {
    return createFailedToolResult(toolCall, normalizeError(error));
  }
}
