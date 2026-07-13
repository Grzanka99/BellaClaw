import type { ZodType } from "zod";
import type { TToolCall } from "../../types";

export type TToolValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export function parseAndValidateToolArgs<T>(
  toolCall: TToolCall,
  schema: ZodType<T>,
): TToolValidationResult<T> {
  const parsed = schema.safeParse(toolCall.arguments);

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
