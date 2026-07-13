import { searchWeb } from "../../../../../lib/web";
import { SWebSearchArgs, type TWebSearchArgs } from "../../../tools/web-search/handler";
import type { TToolCall } from "../../../types";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import {
  createFailedToolResult,
  createInternalToolFailure,
  createSuccessfulToolResult,
} from "../results";

export async function executeWebSearchTool(toolCall: TToolCall): Promise<TNormalizedToolResult> {
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
    return createInternalToolFailure(toolCall, "request", error);
  }
}
