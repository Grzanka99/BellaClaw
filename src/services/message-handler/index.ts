import { MODEL_GEMINI_3_FLASH_PREVIEW } from "../../models";
import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";
import { OpenrouterAiProvider } from "../ai-providers/openrouter";
import {
  DEFINE_MESSAGE_IMPORTANCE_TOOL,
  defineMessageImportanceTool,
} from "../ai-providers/tools/define-message-importance/definition";
import type { THistoryItem, TPrompt } from "../ai-providers/types";

export class MessageHandler {
  private static _instances = new Map<string, MessageHandler>();
  private logger: TLogger;
  private ai = OpenrouterAiProvider.instance;

  constructor(chatId: string) {
    this.logger = createLogger(`AbstractMessageHandler (cid: ${chatId})`);
    this.logger.info("created abstract message handler");
    this.logger.info("handler is up");
  }

  public static getInstance(chatId: string): MessageHandler {
    const instance = MessageHandler._instances.get(chatId);

    if (instance) {
      return instance;
    }

    const newInstance = new MessageHandler(chatId);
    MessageHandler._instances.set(chatId, newInstance);

    return newInstance;
  }

  public async handleMessage(): Promise<TOption<string>> {
    return "";
  }

  // NOTE: Define how important is message, maybe with llm or some alg,
  // I think llm like gemini 3.1 flash or something small
  private async defineMessageImportance(message: string) {
    const INSTRUCTIONS = await Bun.file(
      "./src/services/ai-providers/tools/define-message-importance/instructions.xml",
    ).text();

    const system: THistoryItem = {
      role: "system",
      content: INSTRUCTIONS,
    };

    const uMessage: TPrompt = {
      role: "user",
      content: [{ type: "text", text: message }],
    };

    const res = await this.ai.toolCall(
      uMessage,
      [system],
      [defineMessageImportanceTool],
      MODEL_GEMINI_3_FLASH_PREVIEW,
    );

    if (!res) {
      this.logger.error("Failed to define message importance, defaulting to low");
      return "low";
    }

    const realRes =
      res.toolCallsResults[0]?.tool === DEFINE_MESSAGE_IMPORTANCE_TOOL
        ? res.toolCallsResults[0]
        : undefined;

    if (!realRes) {
      this.logger.error(
        "Result from tool call invalid for defining message importance, defaulting to low",
      );
      return "low";
    }

    return realRes?.data;
  }

  private async saveMessageToDatabase() {
    throw "Not implemented";
  }

  // NOTE: Ask proper LLM to call tool to read database for more memories,
  // Can be done with not that last 30 messages will be included regardless
  private async checkForMemoryFetch() {
    throw "Not implemented";
  }

  // NOTE: Retrieve memory based on tool call response, always retrieve last 30 messages
  private async retrieveMemory() {
    throw "Not implemented";
  }

  // NOTE: tbd, I think tool calls would require another handler to generate response message
  private async generateResponseMessageFromToolCall() {
    throw "Not implemented";
  }
}

const handler = MessageHandler.getInstance("123");
console.log(await handler.defineMessageImportance("test"));
