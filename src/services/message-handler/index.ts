import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger, type TLogger } from "../../utils/logger";
import { AgentHarness } from "../ai/agent-harness";
import { EModelPurpose, ERole, type THistoryItem } from "../ai/types";
import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "../app-logger";
import { resolveAiBehaviorFields } from "../app-logger/ai";
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import { Memory } from "../memory";
import { EMemoryImportance, type TMemory } from "../memory/types";
import type { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { EConfigKey, type TConfigRecord } from "../settings/schema";
import { getMessageTrace } from "./trace";
import type { TIncommingMessage, TOutgoingMessage } from "./types";

type TMemorySaveResult = Awaited<ReturnType<Memory["save"]>>;

export class MessageHandler {
  private static _instances = new Map<string, MessageHandler>();
  private logger: TLogger;
  private ai = AgentHarness.instance;
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
      const parallelStart = performance.now();
      const [importance, last30] = await Promise.all([
        this.defineMessageImportance(message.message.content, settings, trace, ERole.User),
        this.retrieveMemory(message.chatId, trace),
      ]);
      this.logger.info(
        `handleMessage: parallel ops completed (${(performance.now() - parallelStart).toFixed(0)}ms) — importance: ${importance}, recent: ${last30.length}`,
      );

      this.queue.enqueue(() => this.saveMessageToDatabase(message, importance, trace));

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

  public async saveAssistantMessage(message: TIncommingMessage, response: string): Promise<void> {
    const trace = getMessageTrace(message);
    const settings = structuredClone(await SettingsService.instance.getAll(message.chatId));
    const respImpStart = performance.now();
    const responseImportance = await this.defineMessageImportance(
      response,
      settings,
      trace,
      ERole.Assistant,
    );
    this.logger.info(
      `saveAssistantMessage: response importance: ${responseImportance} (${(performance.now() - respImpStart).toFixed(0)}ms)`,
    );

    await this.queue.enqueue(() =>
      this.saveMessageToDatabase(
        {
          chatId: message.chatId,
          message: {
            type: "text",
            content: response,
          },
          author: {
            type: ERole.Assistant,
          },
        },
        responseImportance,
        trace,
      ),
    );
  }

  private async defineMessageImportance(
    message: string,
    settings: TConfigRecord,
    trace: TOption<TBehaviorTraceContext>,
    author: ERole,
  ): Promise<EMemoryImportance> {
    const start = performance.now();

    const response = await this.ai.completeText({
      prompt: `Classify this ${author} message as low, medium, or high importance. Reply with only one word.\n\n${message}`,
      instructions:
        "Classify message importance for conversational memory. Reply only with low, medium, or high.",
      purpose: EModelPurpose.Utility,
      settings,
      trace,
    });

    if (response === undefined) {
      this.logger.error(
        `defineMessageImportance: failed, defaulting to low (${(performance.now() - start).toFixed(0)}ms)`,
      );
      logImportanceCompleted(trace, settings, start, false, author, EMemoryImportance.Low);
      return EMemoryImportance.Low;
    }

    const importance = response.trim().toLowerCase();

    if (
      importance !== EMemoryImportance.Low &&
      importance !== EMemoryImportance.Medium &&
      importance !== EMemoryImportance.High
    ) {
      this.logger.error(
        `defineMessageImportance: invalid tool result, defaulting to low (${(performance.now() - start).toFixed(0)}ms)`,
      );
      logImportanceCompleted(trace, settings, start, false, author, EMemoryImportance.Low);
      return EMemoryImportance.Low;
    }

    this.logger.info(`defineMessageImportance: done (${(performance.now() - start).toFixed(0)}ms)`);
    logImportanceCompleted(trace, settings, start, true, author, importance);
    return importance;
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
        return !("operation" in result);
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
        return !("operation" in result);
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

function logImportanceCompleted(
  trace: TOption<TBehaviorTraceContext>,
  settings: TConfigRecord,
  start: number,
  success: boolean,
  author: ERole,
  importance: EMemoryImportance,
) {
  if (trace === undefined) {
    return;
  }

  const fields = resolveAiBehaviorFields(settings, EModelPurpose.Utility);
  let level = EBehaviorLogLevel.Info;

  if (!success) {
    level = EBehaviorLogLevel.Warning;
  }

  AppLogger.instance.record({
    trace,
    event: "importance.completed",
    component: "message-handler",
    level,
    provider: fields?.provider,
    model: fields?.model,
    purpose: EModelPurpose.Utility,
    success,
    durationMs: performance.now() - start,
    summary: `importance completed author=${author} importance=${importance}`,
    metadata: {
      author,
      importance,
    },
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
  result: TMemorySaveResult,
) {
  if (trace === undefined) {
    return;
  }

  let success = true;
  let level = EBehaviorLogLevel.Info;
  let error: TOption<string>;

  if ("operation" in result) {
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
