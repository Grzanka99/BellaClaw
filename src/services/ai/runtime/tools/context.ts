import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../../types";
import { createLogger } from "../../../../utils/logger";

const logger = createLogger("AI RUNTIME");

export function requireChatId(
  toolCall: ChatMessageToolCall,
  chatId: TOption<string>,
): TOption<string> {
  if (chatId === undefined) {
    logger.warning(`chatId missing for tool ${toolCall.function.name}`);
    return undefined;
  }

  return chatId;
}
