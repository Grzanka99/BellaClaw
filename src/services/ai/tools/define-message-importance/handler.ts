import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import z from "zod";
import type { TOption } from "../../../../types";
import { logger } from "../../../../utils/logger";
import { EMemoryImportance } from "../../../memory/types";

export const SDefineMessageImportance = z.object({
  reasoning: z.string(),
  importance: z.enum(EMemoryImportance),
});

export type TDefineMessageImportance = z.infer<typeof SDefineMessageImportance>;

export function handleDefineMessageImportance(
  toolCall: ChatMessageToolCall,
): TOption<TDefineMessageImportance> {
  let argsJson: unknown;
  try {
    argsJson = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    logger.error(`Failed to parse define-message-importance arguments: ${String(error)}`);
    return undefined;
  }

  const parsed = SDefineMessageImportance.safeParse(argsJson);

  if (!parsed.success) {
    logger.error("handleDefineMessageImportance: Zod validation failed");
    return undefined;
  }

  return parsed.data;
}
