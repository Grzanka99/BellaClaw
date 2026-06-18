import { Config } from "../../config";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger, type TLogger } from "../../utils/logger";
import {
  AiConnector,
  DEFINE_MESSAGE_IMPORTANCE_TOOL,
  defineMessageImportanceTool,
  EModelPurpose,
  ERole,
  searchMemoryTool,
  type THistoryItem,
  type TPrompt,
  webFetchTool,
  webSearchTool,
} from "../ai/api";
import { SDefineMessageImportance } from "../ai/tools/define-message-importance/handler";
import { listCronJobsTool } from "../ai/tools/list-cron-jobs/definition";
import { scheduleOnceTool } from "../ai/tools/schedule-once/definition";
import { scheduleRecurringTool } from "../ai/tools/schedule-recurring/definition";
import { unscheduleCronJobTool } from "../ai/tools/unschedule-cron-job/definition";
import { updateCronJobTool } from "../ai/tools/update-cron-job/definition";
import { Memory } from "../memory";
import { EMemoryImportance, type TMemory } from "../memory/types";
import { MessageHandlerInstructions } from "./instructions";
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

  public async handleMessage(message: TIncommingMessage): Promise<string> {
    const handleMessageStart = performance.now();
    this.logger.info("handleMessage: start");

    const parallelStart = performance.now();
    const [importance, last30] = await Promise.all([
      this.defineMessageImportance(message.message.content),
      this.retrieveMemory(message.chatId),
    ]);
    this.logger.info(
      `handleMessage: parallel ops completed (${(performance.now() - parallelStart).toFixed(0)}ms) — importance: ${importance}, recent: ${last30.length}`,
    );

    this.queue.enqueue(() => this.saveMessageToDatabase(message, importance));

    const history: THistoryItem[] = [];

    for (const el of last30.toReversed()) {
      history.push({
        role: el.author,
        content: el.message,
      });
    }

    history.push({
      role: ERole.System,
      content: createCurrentTimeContext(),
    });

    const tools = [
      { definition: searchMemoryTool, instructions: MessageHandlerInstructions.searchMemory },
      { definition: listCronJobsTool, instructions: MessageHandlerInstructions.listCronJobs },
      { definition: scheduleOnceTool, instructions: MessageHandlerInstructions.scheduleOnce },
      {
        definition: scheduleRecurringTool,
        instructions: MessageHandlerInstructions.scheduleRecurring,
      },
      {
        definition: unscheduleCronJobTool,
        instructions: MessageHandlerInstructions.unscheduleCronJob,
      },
      {
        definition: updateCronJobTool,
        instructions: MessageHandlerInstructions.updateCronJob,
      },
      { definition: webSearchTool, instructions: MessageHandlerInstructions.webSearch },
      { definition: webFetchTool, instructions: MessageHandlerInstructions.webFetch },
    ];

    const chatStart = performance.now();
    const aiRes = await this.ai.runAssistantToolLoop({
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
      tools,
      chatId: message.chatId,
    });
    this.logger.info(
      `handleMessage: AI chat completed (${(performance.now() - chatStart).toFixed(0)}ms)`,
    );

    if (aiRes.finalResponse === undefined) {
      this.logger.warning("handleMessage: AI returned no final response");
      return "Something went wrong.";
    }

    const finalResponse = aiRes.finalResponse;

    this.queue.enqueue(async () => {
      const respImpStart = performance.now();
      const responseImportance = await this.defineMessageImportance(finalResponse);
      this.logger.info(
        `handleMessage: response importance: ${responseImportance} (${(performance.now() - respImpStart).toFixed(0)}ms)`,
      );

      await this.saveMessageToDatabase(
        {
          chatId: message.chatId,
          message: {
            type: "text",
            content: finalResponse,
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
    return finalResponse;
  }

  private async defineMessageImportance(message: string): Promise<EMemoryImportance> {
    const start = performance.now();

    const system: THistoryItem = {
      role: ERole.System,
      content: MessageHandlerInstructions.defineMessageImportance,
    };

    const uMessage: TPrompt = {
      role: ERole.User,
      content: [{ type: "text", text: message }],
    };

    const res = await this.ai.runToolTask({
      prompt: uMessage,
      history: [system],
      tools: [{ definition: defineMessageImportanceTool }],
      purpose: EModelPurpose.ToolCheap,
      chatId: undefined,
      user: undefined,
    });

    const realRes = res.toolResults.find(
      (toolResult) => toolResult.toolName === DEFINE_MESSAGE_IMPORTANCE_TOOL && toolResult.success,
    );

    if (realRes === undefined) {
      this.logger.error(
        `defineMessageImportance: failed, defaulting to low (${(performance.now() - start).toFixed(0)}ms)`,
      );
      return EMemoryImportance.Low;
    }

    const parsed = SDefineMessageImportance.safeParse(realRes.data);

    if (!parsed.success) {
      this.logger.error(
        `defineMessageImportance: invalid tool result, defaulting to low (${(performance.now() - start).toFixed(0)}ms)`,
      );
      return EMemoryImportance.Low;
    }

    this.logger.info(`defineMessageImportance: done (${(performance.now() - start).toFixed(0)}ms)`);
    return parsed.data.importance;
  }

  private async saveMessageToDatabase(
    message: TIncommingMessage | TOutgoingMessage,
    importance: EMemoryImportance,
  ): Promise<boolean> {
    switch (message.author.type) {
      case ERole.User: {
        await this.memory.save({
          chatId: message.chatId,
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

function createCurrentTimeContext() {
  const now = new Date();
  const timezone = Config.ai.instructions.timezone;

  return [
    "Current time context:",
    `UTC: ${now.toISOString()}`,
    `Timezone: ${timezone}`,
    `Local: ${now.toLocaleString("sv-SE-u-nu-latn", {
      timeZone: timezone,
      hourCycle: "h23",
    })}`,
    `Weekday: ${now.toLocaleString("en-US-u-nu-latn", {
      timeZone: timezone,
      weekday: "long",
    })}`,
  ].join("\n");
}
