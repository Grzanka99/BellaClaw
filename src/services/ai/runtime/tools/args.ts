import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { ZodType } from "zod";
import { normalizeError } from "../serialization";

export type TToolValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export function parseAndValidateToolArgs<T>(
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
