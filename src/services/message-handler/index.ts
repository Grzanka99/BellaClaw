import { resourceLimits } from "node:worker_threads";
import { MODEL_GEMINI_3_FLASH_PREVIEW } from "../../models";
import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";
import { OpenrouterAiProvider } from "../ai-providers/openrouter";
import {
  DEFINE_MESSAGE_IMPORTANCE_TOOL,
  defineMessageImportanceTool,
} from "../ai-providers/tools/define-message-importance/definition";
import type { TDefineMessageImportance } from "../ai-providers/tools/define-message-importance/handler";
import {
  SEARCH_MEMORY_TOOL,
  searchMemoryTool,
} from "../ai-providers/tools/search-memory/definition";
import type { TSearchMemory } from "../ai-providers/tools/search-memory/handler";
import type { THistoryItem, TPrompt } from "../ai-providers/types";
import { ERole } from "../ai-providers/types";
import { Memory } from "../memory";
import { EMemoryImportance, type TMemory } from "../memory/types";
import type { TIncommingMessage, TOutcommingMessage } from "./types";

export class MessageHandler {
  private static _instances = new Map<string, MessageHandler>();
  private logger: TLogger;
  private ai = OpenrouterAiProvider.instance;
  private memory = Memory.instance;

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

  public async handleMessage(message: TIncommingMessage): Promise<TOption<string>> {
    const importance = await this.defineMessageImportance(message.message.content);
    this.saveMessageToDatabase(message, importance);
    console.log(importance);
    return "";
  }

  private async defineMessageImportance(message: string): Promise<EMemoryImportance> {
    const INSTRUCTIONS = await Bun.file(
      "./src/services/ai-providers/tools/define-message-importance/instructions.xml",
    ).text();

    const system: THistoryItem = {
      role: ERole.System,
      content: INSTRUCTIONS,
    };

    const uMessage: TPrompt = {
      role: ERole.User,
      content: [{ type: "text", text: message }],
    };

    const res = await this.ai.toolCall<TDefineMessageImportance>(
      uMessage,
      [system],
      [defineMessageImportanceTool],
      MODEL_GEMINI_3_FLASH_PREVIEW,
    );

    if (!res) {
      this.logger.error("Failed to determine message importance, defaulting to low");
      return EMemoryImportance.Low;
    }

    const realRes = res.toolCallsResults.find((el) => el.tool === DEFINE_MESSAGE_IMPORTANCE_TOOL);

    if (!realRes) {
      this.logger.error(
        "Cannot find correct tool call result for message importance, defaulting to low",
      );
      return EMemoryImportance.Low;
    }

    return realRes.data.importance;
  }

  private async saveMessageToDatabase(
    message: TIncommingMessage | TOutcommingMessage,
    importance: EMemoryImportance,
  ): Promise<boolean> {
    switch (message.author.type) {
      case ERole.User: {
        const res = await this.memory.save({
          chatId: message.author.id,
          author: ERole.User,
          importance,
          message: message.message.content,
        });
        console.log(res);
        return true;
      }
      case ERole.Assistant: {
        const res = await this.memory.save({
          chatId: message.chatId,
          author: ERole.Assistant,
          importance,
          message: message.message.content,
        });
        console.log(res);
        return true;
      }
    }
  }

  // NOTE: Ask proper LLM to call tool to read database for more memories,
  // Can be done with note that last 30 messages will be included regardless
  private async searchMemories(message: TIncommingMessage): unknown[] {
    if (message.author.type !== ERole.User) {
      return [];
    }

    const INSTRUCTIONS = await Bun.file(
      "./src/services/ai-providers/tools/search-memory/instructions.xml",
    ).text();

    const system: THistoryItem = {
      role: ERole.System,
      content: INSTRUCTIONS,
    };

    const uMessage: TPrompt = {
      role: ERole.User,
      content: [{ type: "text", text: message.message.content }],
    };

    const res = await this.ai.toolCall<TSearchMemory>(
      uMessage,
      [system],
      [searchMemoryTool],
      MODEL_GEMINI_3_FLASH_PREVIEW,
      message.chatId,
    );

    if (!res) {
      this.logger.error("Failed to determine if memory should be searched");
      return [];
    }

    const filtered = res.toolCallsResults.filter((el) => el.tool === SEARCH_MEMORY_TOOL);
    const allFound: TMemory[] = [];

    const seen = new Set<number>();
    for (const f of filtered) {
      for (const m of f.data.memories) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          allFound.push(m);
        }
      }
    }

    return allFound;
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

const ai = MessageHandler.getInstance("test");
ai.searchMemories({
  author: {
    type: ERole.User,
    id: "123",
    username: "test",
  },
  chatId: "test-chat",
  message: {
    type: "text",
    content: "co lubię jeść na obiad?",
  },
});
