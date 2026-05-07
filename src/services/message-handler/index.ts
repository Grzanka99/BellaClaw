import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger, type TLogger } from "../../utils/logger";
import {
  AiConnector,
  DEFINE_MESSAGE_IMPORTANCE_TOOL,
  defineMessageImportanceTool,
  EModelPurpose,
  ERole,
  SEARCH_MEMORY_TOOL,
  searchMemoryTool,
  type TDefineMessageImportance,
  type THistoryItem,
  type TPrompt,
  type TSearchMemory,
} from "../ai/api";
import { Memory } from "../memory";
import { EMemoryImportance, type TMemory } from "../memory/types";
import type { TIncommingMessage, TOutgoingMessage } from "./types";

export class MessageHandler {
  private static _instances = new Map<string, MessageHandler>();
  private logger: TLogger;
  private ai = AiConnector.instance;
  private queue = new AsyncQueue();
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
    const handleMessageStart = performance.now();
    this.logger.info("handleMessage: start");

    const parallelStart = performance.now();
    const [importance, last30, byAiDecision] = await Promise.all([
      this.defineMessageImportance(message.message.content),
      this.retrieveMemory(message.chatId),
      this.searchMemories(message),
    ]);
    this.logger.info(
      `handleMessage: parallel ops completed (${(performance.now() - parallelStart).toFixed(0)}ms) — importance: ${importance}, recent: ${last30.length}, search: ${byAiDecision.length}`,
    );

    this.queue.enqueue(() => this.saveMessageToDatabase(message, importance));

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

    const chatStart = performance.now();
    const aiRes = await this.ai.chatWithTools({
      prompt: {
        role: ERole.User,
        content: [{ type: "text", text: message.message.content }],
      },
      history,
      purpose: EModelPurpose.ChatAccurate,
      user: {
        username: message.author.username,
        id: message.author.id,
        displayName: message.author.username,
      },
      tools: [],
    });
    this.logger.info(
      `handleMessage: AI chat completed (${(performance.now() - chatStart).toFixed(0)}ms)`,
    );

    if (!aiRes) {
      this.logger.warning("handleMessage: AI returned undefined, aborting");
      return undefined;
    }

    this.queue.enqueue(async () => {
      const respImpStart = performance.now();
      const responseImportance = await this.defineMessageImportance(aiRes.response);
      this.logger.info(
        `handleMessage: response importance: ${responseImportance} (${(performance.now() - respImpStart).toFixed(0)}ms)`,
      );

      await this.saveMessageToDatabase(
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
    });

    this.logger.info(
      `handleMessage: done (${(performance.now() - handleMessageStart).toFixed(0)}ms)`,
    );
    return aiRes.response;
  }

  private async defineMessageImportance(message: string): Promise<EMemoryImportance> {
    const start = performance.now();

    const INSTRUCTIONS = await Bun.file(
      "./src/services/ai/tools/define-message-importance/instructions.xml",
    ).text();

    const system: THistoryItem = {
      role: ERole.System,
      content: INSTRUCTIONS,
    };

    const uMessage: TPrompt = {
      role: ERole.User,
      content: [{ type: "text", text: message }],
    };

    const res = await this.ai.toolCall<TDefineMessageImportance>({
      prompt: uMessage,
      instructions: [system],
      tools: [defineMessageImportanceTool],
      purpose: EModelPurpose.ToolCheap,
    });

    if (!res) {
      this.logger.error(
        `defineMessageImportance: failed, defaulting to low (${(performance.now() - start).toFixed(0)}ms)`,
      );
      return EMemoryImportance.Low;
    }

    const realRes = res.toolCallsResults.find((el) => el.tool === DEFINE_MESSAGE_IMPORTANCE_TOOL);

    if (!realRes) {
      this.logger.error(
        `defineMessageImportance: no tool call result found, defaulting to low (${(performance.now() - start).toFixed(0)}ms)`,
      );
      return EMemoryImportance.Low;
    }

    this.logger.info(`defineMessageImportance: done (${(performance.now() - start).toFixed(0)}ms)`);
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
    const start = performance.now();

    if (message.author.type !== ERole.User) {
      this.logger.info(
        `searchMemories: done (${(performance.now() - start).toFixed(0)}ms) — skipped, not a user message`,
      );
      return [];
    }

    const INSTRUCTIONS = await Bun.file(
      "./src/services/ai/tools/search-memory/instructions.xml",
    ).text();

    const system: THistoryItem = {
      role: ERole.System,
      content: INSTRUCTIONS,
    };

    const uMessage: TPrompt = {
      role: ERole.User,
      content: [{ type: "text", text: message.message.content }],
    };

    const res = await this.ai.toolCall<TSearchMemory>({
      prompt: uMessage,
      instructions: [system],
      tools: [searchMemoryTool],
      purpose: EModelPurpose.ToolCheap,
      chatId: message.chatId,
    });

    if (!res) {
      this.logger.error(
        `searchMemories: failed to determine if memory should be searched (${(performance.now() - start).toFixed(0)}ms)`,
      );
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

    this.logger.info(`searchMemories: done (${(performance.now() - start).toFixed(0)}ms)`);
    return allFound;
  }

  // NOTE: Retrieve memory based on tool call response, always retrieve last 30 messages
  private async retrieveMemory(chatId: string): Promise<TMemory[]> {
    const start = performance.now();

    const res = await this.memory.findRecent(chatId, 30);

    if (!res.success) {
      this.logger.error(
        `retrieveMemory: failed to retrieve last 30 memories (${(performance.now() - start).toFixed(0)}ms)`,
      );
      return [];
    }

    this.logger.info(`retrieveMemory: done (${(performance.now() - start).toFixed(0)}ms)`);
    return res.data;
  }

  // NOTE: tbd, I think tool calls would require another handler to generate response message
  private async generateResponseMessageFromToolCall() {
    throw "Not implemented";
  }
}
