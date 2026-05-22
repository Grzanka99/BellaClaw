import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import {
  SDefineMessageImportance,
  type TDefineMessageImportance,
} from "../../../tools/define-message-importance/handler";
import type { TNormalizedToolResult } from "../../types";
import { parseAndValidateToolArgs } from "../args";
import { createFailedToolResult, createSuccessfulToolResult } from "../results";

export async function executeDefineMessageImportanceTool(
  toolCall: ChatMessageToolCall,
): Promise<TNormalizedToolResult> {
  const parsed = parseAndValidateToolArgs<TDefineMessageImportance>(
    toolCall,
    SDefineMessageImportance,
  );

  if (!parsed.success) {
    return createFailedToolResult(toolCall, parsed.error);
  }

  return createSuccessfulToolResult(toolCall, parsed.data);
}
