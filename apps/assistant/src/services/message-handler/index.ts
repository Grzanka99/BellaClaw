import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { AsyncQueue, createLogger, logger, type TLogger } from "@bellaclaw/shared";
import { AgentHarness } from "../ai/agent-harness";
import { ERole, type THistoryItem } from "../ai/types";
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
      const settings = structuredClone(await SettingsService.instance.getAll(message.chatId));
      const last30 = await this.retrieveMemory(message.chatId, trace);

      const userSaved = await this.queue.enqueue(() =>
        this.saveMessageToDatabase(message, EMemoryImportance.Medium, trace),
      );
      if (!userSaved) {
        this.logger.error("handleMessage: user transcript save failed");
        throw new Error("Failed to save user transcript");
      }

      const history: THistoryItem[] = [];

      for (const el of last30.toReversed()) {
        history.push({
          role: el.author,
          content: el.message,
        });
      }

      const chatStart = performance.now();
      const aiRes = await this.ai.runMain({
        prompt: message.message.content,
        history,
        currentTimeContext: createCurrentTimeContext(settings),
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
          const saved = await this.saveMessageToDatabase(
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

          if (!saved) {
            this.logger.error("handleMessage: assistant transcript save failed");
            return;
          }

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

  private async drainLiveFactWindows(
    chatId: string,
    settings: TConfigRecord,
    trace: TOption<TBehaviorTraceContext>,
  ): Promise<void> {
    while (true) {
      const window = await this.memory.loadLiveFactWindow(chatId);
      if (window.messages.length === 0) {
        return;
      }

      const result = await this.factDistiller.processWindow({ window, settings, trace });

      if (!result.success) {
        this.logger.error(`drainLiveFactWindows: stopped after ${result.reason} failure`);
        return;
      }
    }
  }

  private async saveMessageToDatabase(
    message: TIncommingMessage | TOutgoingMessage,
    importance: EMemoryImportance,
    trace: TOption<TBehaviorTraceContext>,
  ): Promise<boolean> {
    const start = performance.now();

    switch (message.author.type) {
      case ERole.User: {
        const result = await this.memory.save({
          chatId: message.chatId,
          author: ERole.User,
          importance,
          message: message.message.content,
        });
        logMemorySaveCompleted(
          trace,
          start,
          ERole.User,
          importance,
          message.message.content.length,
          result,
        );
        return !isRecord(result) || !("operation" in result);
      }
      case ERole.Assistant: {
        const result = await this.memory.save({
          chatId: message.chatId,
          author: ERole.Assistant,
          importance,
          message: message.message.content,
        });
        logMemorySaveCompleted(
          trace,
          start,
          ERole.Assistant,
          importance,
          message.message.content.length,
          result,
        );
        return !isRecord(result) || !("operation" in result);
      }
    }
  }

  // NOTE: Retrieve memory based on tool call response, always retrieve last 30 messages
  private async retrieveMemory(
    chatId: string,
    trace: TOption<TBehaviorTraceContext>,
  ): Promise<TMemory[]> {
    const start = performance.now();

    const res = await this.memory.findRecent(chatId, 30);

    if (!res.success) {
      this.logger.error(
        `retrieveMemory: failed to retrieve last 30 memories (${(performance.now() - start).toFixed(0)}ms)`,
      );
      logMemoryRecentCompleted(trace, start, false, 0, 30, "Failed to retrieve recent memory");
      return [];
    }

    this.logger.info(`retrieveMemory: done (${(performance.now() - start).toFixed(0)}ms)`);
    logMemoryRecentCompleted(trace, start, true, res.data.length, 30, undefined);
    return res.data;
  }
}

function logHandlerStarted(trace: TOption<TBehaviorTraceContext>, handler: string) {
  if (trace === undefined) {
    return;
  }

  AppLogger.instance.record({
    trace,
    event: "handler.started",
    component: handler,
    summary: `${handler} started`,
    metadata: {
      handler,
    },
  });
}

function logHandlerCompleted(
  trace: TOption<TBehaviorTraceContext>,
  handler: string,
  start: number,
  success: boolean,
  replyChars: number,
  summary: string,
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
    event: "handler.completed",
    component: handler,
    level,
    success,
    durationMs: performance.now() - start,
    summary: `${handler} ${summary}`,
    metadata: {
      handler,
      replyChars,
    },
    error: sanitizeErrorMessage(error),
  });
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

function logMemorySaveCompleted(
  trace: TOption<TBehaviorTraceContext>,
  start: number,
  author: ERole,
  importance: EMemoryImportance,
  messageChars: number,
  result: unknown,
) {
  if (trace === undefined) {
    return;
  }

  let success = true;
  let level = EBehaviorLogLevel.Info;
  let error: TOption<string>;

  if (isRecord(result) && "operation" in result) {
    success = false;
    level = EBehaviorLogLevel.Warning;
    error = String(result.error);
  }

  AppLogger.instance.record({
    trace,
    event: "memory.save.completed",
    component: "memory",
    level,
    success,
    durationMs: performance.now() - start,
    summary: `memory save completed author=${author} importance=${importance}`,
    metadata: {
      author,
      importance,
      messageChars,
    },
    error: sanitizeErrorMessage(error),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createCurrentTimeContext(settings: TConfigRecord) {
  const now = new Date();
  const timezone = settings[EConfigKey.AiInstructionsTimezone];

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
