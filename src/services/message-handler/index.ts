import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";

export class MessageHandler {
  private static _instances = new Map<string, MessageHandler>();
  private logger: TLogger;

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
  private async defineMessageImportance() {
    throw "Not implemented";
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
