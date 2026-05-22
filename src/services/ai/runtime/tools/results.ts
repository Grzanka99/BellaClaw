import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TNormalizedToolResult } from "../types";

export function createSuccessfulToolResult(
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

export function createFailedToolResult(
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
