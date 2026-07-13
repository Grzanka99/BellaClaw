import type { TOption } from "../../../../types";
import { createLogger } from "../../../../utils/logger";
import type { TToolCall } from "../../types";

const logger = createLogger("AI RUNTIME");

export function requireChatId(toolCall: TToolCall, chatId: TOption<string>): TOption<string> {
  if (chatId === undefined) {
    logger.warning(`chatId missing for tool ${toolCall.name}`);
    return undefined;
  }

  return chatId;
}
