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
    const trace = getMessageTrace(message);
    const handleMessageStart = performance.now();
    this.logger.info("handleMessage: start");
    logHandlerStarted(trace, "message-handler");

    try {
      const settings = await SettingsService.instance.getAll(message.chatId);
      const last30 = await this.retrieveMemory(message.chatId, trace);

      const savedMessage = await this.queue.enqueue(() =>
        this.saveMessageToDatabase(message, EMemoryImportance.Medium, trace),
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

      const finalResponse = aiRes.text;

      void this.queue
        .enqueue(async () => {
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
            EMemoryImportance.Medium,
            trace,
          );

          void this.factQueue
            .enqueue(() => this.drainLiveFactWindows(message.chatId, settings, trace))
            .catch((error) => {
              this.logger.error(`handleMessage: fact drain failed: ${String(error)}`);
            });
        })
        .catch((error) => {
          this.logger.error(`handleMessage: assistant transcript save failed: ${String(error)}`);
        });

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
  ): Promise<Omit<TMemory, "id">> {
    const start = performance.now();
    let failure: TOption<string>;
    try {
      return await this.memory.save({
        chatId: message.chatId,
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
  ): Promise<TMemory[]> {
    const start = performance.now();

    try {
      const memories = await this.memory.findRecent(chatId, 30);
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
