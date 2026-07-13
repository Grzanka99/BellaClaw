import { logger } from "../../../../utils/logger";
import { sanitizeErrorMessage } from "../../../app-logger/sanitizers";
import type { TToolCall } from "../../types";
import { normalizeError } from "../serialization";
import type { TNormalizedToolResult } from "../types";

export function createSuccessfulToolResult(
  toolCall: TToolCall,
  data: unknown,
): TNormalizedToolResult {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    success: true,
    data,
    error: undefined,
  };
}

export function createFailedToolResult(toolCall: TToolCall, error: string): TNormalizedToolResult {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    success: false,
    data: undefined,
    error,
  };
}

export function createInternalToolFailure(
  toolCall: TToolCall,
  operation: string,
  error: unknown,
): TNormalizedToolResult {
  let diagnostic = sanitizeErrorMessage(normalizeError(error));

  if (diagnostic === undefined) {
    diagnostic = "unknown error";
  }

  logger.error(
    `[TOOL CALL] internal failure tool=${toolCall.name} operation=${operation}: ${diagnostic}`,
  );

  return createFailedToolResult(toolCall, `${toolCall.name} failed during ${operation}`);
}
