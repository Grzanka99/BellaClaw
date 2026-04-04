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
import type { TIncommingMessage, TOutgoingMessage } from "./types";

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

    const last30 = await this.retrieveMemory(message.chatId);
    const byAiDecision = await this.searchMemories(message);

    this.saveMessageToDatabase(message, importance);

    const history: THistoryItem[] = [];

    for (const el of last30.toReversed()) {
      history.push({
        role: el.author,
        content: el.message,
      });
    }

    const foundHistory = [];

    for (const el of byAiDecision.toReversed()) {
      foundHistory.push({
        role: el.author,
        content: el.message,
      });
    }

    if (foundHistory.length) {
      history.push({
        role: ERole.System,
        content: `messages you asked to receive for context: ${foundHistory}`,
      });
    }

    const aiRes = await this.ai.chatWithTools(
      {
        role: ERole.User,
        content: [{ type: "text", text: message.message.content }],
      },
      history,
      {
        username: message.author.username,
        id: message.author.id,
        displayName: message.author.username,
      },
      [],
    );

    if (!aiRes) {
      return undefined;
    }

    const responseImportance = await this.defineMessageImportance(aiRes.response);

    this.saveMessageToDatabase(
      {
        chatId: message.chatId,
        message: {
          type: "text",
          content: aiRes.response,
        },
        author: {
          type: ERole.Assistant,
        },
      },
      responseImportance,
    );

    return aiRes.response;
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
    message: TIncommingMessage | TOutgoingMessage,
    importance: EMemoryImportance,
  ): Promise<boolean> {
    switch (message.author.type) {
      case ERole.User: {
        await this.memory.save({
          chatId: message.author.id,
          author: ERole.User,
          importance,
          message: message.message.content,
        });
        return true;
      }
      case ERole.Assistant: {
        await this.memory.save({
          chatId: message.chatId,
          author: ERole.Assistant,
          importance,
          message: message.message.content,
        });
        return true;
      }
    }
  }

  // NOTE: Ask proper LLM to call tool to read database for more memories,
  // Can be done with note that last 30 messages will be included regardless
  private async searchMemories(message: TIncommingMessage): Promise<TMemory[]> {
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
  private async retrieveMemory(chatId: string): Promise<TMemory[]> {
    const res = await this.memory.findRecent(chatId, 30);

    if (!res.success) {
      this.logger.error("Failed to retrieve last 30 memories from memory");
      return [];
    }

    return res.data;
  }

  // NOTE: tbd, I think tool calls would require another handler to generate response message
  private async generateResponseMessageFromToolCall() {
    throw "Not implemented";
  }
}
