import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { AsyncQueue, createLogger, logger, type TLogger } from "@bellaclaw/shared";
import { AgentHarness } from "../ai/agent-harness";
import { ERole, type THistoryItem } from "../ai/types";
import {
  logHandlerCompleted,
  logHandlerStarted,
  logMemorySaveCompleted,
} from "../app-logger/operations";
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import { ConversationStore } from "../conversation";
import type { TConversation } from "../conversation/types";
import { Memory } from "../memory";
import { FactDistiller } from "../memory/distill";
import { EMemoryImportance, type TMemory } from "../memory/types";
import type { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { EConfigKey, type TConfigRecord } from "../settings/schema";
import { getMessageTrace } from "./trace";
import type { TIncommingMessage, TOutgoingMessage } from "./types";

export class MessageHandler {
  private static _instances = new Map<string, MessageHandler>();
  private logger: TLogger;
  private ai = AgentHarness.instance;
  private queue = new AsyncQueue();
  private turnQueue = new AsyncQueue();
  private conversations = ConversationStore.instance;
  // NOTE: fact drains get their own queue so a slow distillation run never delays the
  // transcript saves that the reply path awaits on this.queue
  private factQueue = new AsyncQueue();
  private memory = Memory.instance;
  private factDistiller = FactDistiller.instance;

  constructor(private chatId: string) {
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

  public async handleMessage(
    message: TIncommingMessage,
    platform?: EMessagePlatform,
  ): Promise<string> {
    return this.turnQueue.enqueue(() => this.handleTurn(message, platform));
  }

  private async handleTurn(
    message: TIncommingMessage,
    platform: TOption<EMessagePlatform>,
  ): Promise<string> {
    const trace = getMessageTrace(message);
    const handleMessageStart = performance.now();
    this.logger.info("handleMessage: start");
    logHandlerStarted(trace, "message-handler");

    try {
      const settings = await SettingsService.instance.getAll(message.chatId);
      await this.queue.enqueue(async () => undefined);
      let conversation = await this.conversations.load(message.chatId, platform ?? "unknown");
      if (conversation !== undefined) {
        conversation = await this.compact(conversation, settings, platform, trace);
      }
      let last30: TMemory[] = [];
      if (conversation === undefined) {
        last30 = await this.retrieveMemory(message.chatId, trace, platform);
      }

      const savedMessage = await this.queue.enqueue(() =>
        this.saveMessageToDatabase(message, EMemoryImportance.Medium, trace, platform),
      );

      const history: THistoryItem[] = [];

      for (const el of last30.toReversed()) {
        let content = el.message;
        if (el.author === ERole.User) {
          content = `${createCurrentTimeContext(settings, el.createdAt)}\n\n${content}`;
        }
        history.push({
          role: el.author,
          content,
        });
      }

      const chatStart = performance.now();
      const aiRes = await this.ai.runMain({
        prompt: message.message.content,
        history,
        conversation,
        currentTimeContext: createCurrentTimeContext(settings, savedMessage.createdAt),
        chatId: message.chatId,
        settings,
        platform,
        trace,
        signal: undefined,
      });
      this.logger.info(
        `handleMessage: AI chat completed (${(performance.now() - chatStart).toFixed(0)}ms)`,
      );

      if (aiRes.text === undefined) {
        this.logger.warning("handleMessage: AI returned no final response");
        logHandlerCompleted(
          trace,
          "message-handler",
          handleMessageStart,
          false,
          "Something went wrong.".length,
          "missing final response",
          undefined,
        );
        return "Something went wrong.";
      }

      const saveStartedAt = performance.now();
      let persisted: TConversation;
      let saveError: TOption<string>;
      try {
        persisted = await this.conversations.saveTurn(
          message.chatId,
          platform ?? "unknown",
          aiRes.messages,
          savedMessage.id,
          conversation,
          last30
            .toReversed()
            .filter((item) => item.author !== ERole.System)
            .map((item) => item.id),
        );
      } catch (error) {
        saveError = String(error);
        throw error;
      } finally {
        logMemorySaveCompleted(
          trace,
          saveStartedAt,
          ERole.Assistant,
          EMemoryImportance.Medium,
          aiRes.text.length,
          saveError,
        );
      }

      const finalResponse = aiRes.text;

      void this.factQueue
        .enqueue(() => this.drainLiveFactWindows(message.chatId, settings, trace))
        .catch((error) => this.logger.error(`handleMessage: fact drain failed: ${String(error)}`));
      void this.queue
        .enqueue(async () => {
          await this.compact(persisted, settings, platform, trace);
        })
        .catch((error) => this.logger.error(`handleMessage: compaction failed: ${String(error)}`));

      this.logger.info(
        `handleMessage: done (${(performance.now() - handleMessageStart).toFixed(0)}ms)`,
      );
      logHandlerCompleted(
        trace,
        "message-handler",
        handleMessageStart,
        true,
        finalResponse.length,
        "completed",
        undefined,
      );
      return finalResponse;
    } catch (error) {
      logHandlerCompleted(
        trace,
        "message-handler",
        handleMessageStart,
        false,
        0,
        "failed",
        String(error),
      );
      throw error;
    }
  }

  private async compact(
    state: TConversation,
    settings: TConfigRecord,
    platform: TOption<EMessagePlatform>,
    trace: TOption<TBehaviorTraceContext>,
  ): Promise<TConversation> {
    const startedAt = performance.now();
    try {
      const result = await this.ai.compactConversation(
        state,
        settings,
        this.chatId,
        platform,
        trace,
      );
      if (result === undefined) {
        return state;
      }
      await this.conversations.saveSummary(this.chatId, platform ?? "unknown", result.state);
      if (trace !== undefined) {
        AppLogger.instance.record({
          trace,
          event: "conversation.compaction.completed",
          component: "message-handler",
          success: true,
          durationMs: performance.now() - startedAt,
          summary: "Conversation compacted",
          metadata: {
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            ...result.usage,
          },
        });
      }
      return result.state;
    } catch (error) {
      this.logger.error(`Conversation compaction failed: ${String(error)}`);
      if (trace !== undefined) {
        AppLogger.instance.record({
          trace,
          event: "conversation.compaction.failed",
          component: "message-handler",
          level: EBehaviorLogLevel.Warning,
          success: false,
          durationMs: performance.now() - startedAt,
          summary: "Kept original conversation; retry next turn",
          error: sanitizeErrorMessage(String(error)),
        });
      }
      return state;
    }
  }

  // NOTE: without this, facts stay empty until the first inbound message of the process, so the
  // very first recall after a deploy answers from an unpopulated store. Catching up is best-effort
  // and must never fail boot — messaging works fine against a partially distilled store.
  public static async scheduleFactDrainForAllChats(turnId: string): Promise<void> {
    try {
      const chatIds = await Memory.instance.findChatIds();

      for (const chatId of chatIds) {
        MessageHandler.getInstance(chatId).scheduleFactDrain({
          turnId,
          chatId,
          platform: undefined,
        });
      }
    } catch (error) {
      logger.error(`scheduleFactDrainForAllChats: boot fact drain failed: ${String(error)}`);
    }
  }

  public scheduleFactDrain(trace: TOption<TBehaviorTraceContext>): void {
    void this.factQueue
      .enqueue(async () => {
        const settings = await SettingsService.instance.getAll(this.chatId);
        await this.drainLiveFactWindows(this.chatId, settings, trace);
      })
      .catch((error) => {
        this.logger.error(`scheduleFactDrain: fact drain failed: ${String(error)}`);
      });
  }

  public async ensureFactsCurrent(): Promise<void> {
    const settings = await SettingsService.instance.getAll(this.chatId);
    const success = await this.factQueue.enqueue(() =>
      this.drainLiveFactWindows(this.chatId, settings, undefined),
    );
    if (!success) {
      throw new Error("Pending fact distillation failed");
    }
  }

  private async drainLiveFactWindows(
    chatId: string,
    settings: TConfigRecord,
    trace: TOption<TBehaviorTraceContext>,
  ): Promise<boolean> {
    while (true) {
      const window = await this.memory.loadLiveFactWindow(chatId);
      if (window.messages.length === 0) {
        return true;
      }

      const result = await this.factDistiller.processWindow({ window, settings, trace });

      if (!result.success) {
        this.logger.error(`drainLiveFactWindows: stopped after ${result.reason} failure`);
        return false;
      }
    }
  }

  private async saveMessageToDatabase(
    message: TIncommingMessage | TOutgoingMessage,
    importance: EMemoryImportance,
    trace: TOption<TBehaviorTraceContext>,
    platform: TOption<EMessagePlatform>,
  ): Promise<TMemory> {
    const start = performance.now();
    let failure: TOption<string>;
    try {
      return await this.memory.save({
        chatId: message.chatId,
        platform,
        author: message.author.type,
        importance,
        message: message.message.content,
      });
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      logMemorySaveCompleted(
        trace,
        start,
        message.author.type,
        importance,
        message.message.content.length,
        failure,
      );
    }
  }

  private async retrieveMemory(
    chatId: string,
    trace: TOption<TBehaviorTraceContext>,
    platform: TOption<EMessagePlatform>,
  ): Promise<TMemory[]> {
    const start = performance.now();

    try {
      const memories = await this.memory.findRecent(chatId, 30, platform);
      logMemoryRecentCompleted(trace, start, true, memories.length, 30, undefined);
      return memories;
    } catch (error) {
      this.logger.error(`retrieveMemory: failed to retrieve recent memory: ${String(error)}`);
      logMemoryRecentCompleted(trace, start, false, 0, 30, String(error));
      return [];
    }
  }
}

function logMemoryRecentCompleted(
  trace: TOption<TBehaviorTraceContext>,
  start: number,
  success: boolean,
  count: number,
  limit: number,
  error: TOption<string>,
) {
  if (trace === undefined) {
    return;
  }

  let level = EBehaviorLogLevel.Info;

  if (!success) {
    level = EBehaviorLogLevel.Warning;
  }

  AppLogger.instance.record({
    trace,
    event: "memory.recent.completed",
    component: "memory",
    level,
    success,
    durationMs: performance.now() - start,
    summary: `recent memory completed count=${count} limit=${limit}`,
    metadata: {
      count,
      limit,
    },
    error: sanitizeErrorMessage(error),
  });
}

function createCurrentTimeContext(settings: TConfigRecord, now: Date) {
  const timezone = settings[EConfigKey.AiInstructionsTimezone];

  return [
    "Message received at:",
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
