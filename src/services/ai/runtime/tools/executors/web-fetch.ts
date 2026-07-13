import { fetchWeb } from "../../../../../lib/web";
import { SWebFetchArgs, type TWebFetchArgs } from "../../../tools/web-fetch/handler";
import type { TToolCall } from "../../../types";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import {
  createFailedToolResult,
  createInternalToolFailure,
  createSuccessfulToolResult,
} from "../results";

export { fetchWeb } from "../../../../../lib/web";

export async function executeWebFetchTool(toolCall: TToolCall): Promise<TNormalizedToolResult> {
  const parsed = parseAndValidateToolArgs<TWebFetchArgs>(toolCall, SWebFetchArgs);

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  try {
    const result = await fetchWeb(parsed.data);

    return createSuccessfulToolResult(toolCall, result);
  } catch (error) {
    return createInternalToolFailure(toolCall, "request", error);
  }
}
