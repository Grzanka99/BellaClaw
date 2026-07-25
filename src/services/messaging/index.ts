import {
  generateReminderText,
  generateScheduledTaskText,
  type TScheduledTaskResult,
} from "../../handlers/generate-reminder-text";
import type { TCronJobContext } from "../../lib/cron-engine";
import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger, type TLogger } from "../../utils/logger";
import { AgentHarness } from "../ai/agent-harness";
import { ERole } from "../ai/types";
import {
  AppLogger,
  createCronTurnId,
  createMessageTurnId,
  EBehaviorLogLevel,
  type TBehaviorTraceContext,
} from "../app-logger";
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import { CronSingleton } from "../cron";
import { Memory, type TMemorySaveResult } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "../message-handler";
import { attachMessageTrace } from "../message-handler/trace";
import type { TIncommingMessage } from "../message-handler/types";
import { createCanonicalChatKey, parseCanonicalChatKey } from "./chat-key";
import type { EMessagePlatform, TMessageTransport, TPlatformMessage } from "./types";

type TInboundChatQueue = {
  queue: AsyncQueue;
  pending: number;
};

export class MessagingAdapter {
  private static _instance: TOption<MessagingAdapter>;
  private logger: TLogger = createLogger("MESSAGING");
  private transports = new Map<EMessagePlatform, TMessageTransport>();
  private ai = AgentHarness.instance;
  private cronListenerRegistered = false;
  private runningCronTaskKeys = new Set<string>();
  private inboundChatQueues = new Map<string, TInboundChatQueue>();

  private constructor() {}

  public static get instance() {
    if (!MessagingAdapter._instance) {
      MessagingAdapter._instance = new MessagingAdapter();
    }

    return MessagingAdapter._instance;
  }

  public registerTransport(transport: TMessageTransport) {
    this.transports.set(transport.platform, transport);
    this.ensureCronListener();
  }

  public async setup() {
    this.ensureCronListener();
    await CronSingleton.instance.setup();
  }

  public async handleInboundMessage(message: TPlatformMessage) {
    const canonicalChatId = createCanonicalChatKey(message.platform, message.chatId);
    let chatQueue = this.inboundChatQueues.get(canonicalChatId);

    if (chatQueue === undefined) {
      chatQueue = {
        queue: new AsyncQueue(),
        pending: 0,
      };
      this.inboundChatQueues.set(canonicalChatId, chatQueue);
    }

    chatQueue.pending += 1;

    try {
      await chatQueue.queue.enqueue(() =>
        this.handleInboundMessageForChat(message, canonicalChatId),
      );
    } finally {
      chatQueue.pending -= 1;

      if (chatQueue.pending === 0 && this.inboundChatQueues.get(canonicalChatId) === chatQueue) {
        this.inboundChatQueues.delete(canonicalChatId);
      }
    }
  }

  private async handleInboundMessageForChat(
    message: TPlatformMessage,
    canonicalChatId: string,
  ): Promise<void> {
    const handlerStart = performance.now();
    const trace: TBehaviorTraceContext = {
      turnId: createMessageTurnId(),
      chatId: canonicalChatId,
      platform: message.platform,
    };
    logMessageReceived(trace, message);

    try {
      const transport = this.transports.get(message.platform);
      if (transport === undefined) {
        this.logger.error(`handleInboundMessage: no transport for platform ${message.platform}`);
        logHandlerCompleted(
          trace,
          "messaging",
          handlerStart,
          false,
          0,
          "missing transport",
          undefined,
        );
        return;
      }

      const incomingMessage: TIncommingMessage = {
        chatId: canonicalChatId,
        author: {
          type: ERole.User,
          username: message.author.username,
          id: message.author.id,
        },
        message: message.message,
      };
      attachMessageTrace(incomingMessage, trace);

      const handler = MessageHandler.getInstance(canonicalChatId);
      const reply = await handler.handleMessage(incomingMessage, message.platform);

      if (reply.trim().length === 0) {
        logHandlerCompleted(trace, "messaging", handlerStart, true, 0, "empty reply", undefined);
        return;
      }

      const sendStart = performance.now();

      try {
        await transport.sendText(message.chatId, reply);
        logTransportSendCompleted(
          trace,
          sendStart,
          message.platform,
          true,
          reply.length,
          undefined,
        );
      } catch (error) {
        this.logger.error(
          `handleInboundMessage: failed to send message to ${message.platform} chat ${message.chatId}: ${String(error)}`,
        );
        logTransportSendCompleted(
          trace,
          sendStart,
          message.platform,
          false,
          reply.length,
          String(error),
        );
        logHandlerCompleted(
          trace,
          "messaging",
          handlerStart,
          false,
          reply.length,
          "send failed",
          String(error),
        );
        return;
      }

      await handler.saveAssistantMessage(incomingMessage, reply);

      logHandlerCompleted(
        trace,
        "messaging",
        handlerStart,
        true,
        reply.length,
        "completed",
        undefined,
      );
    } catch (error) {
      logHandlerCompleted(trace, "messaging", handlerStart, false, 0, "failed", String(error));
      throw error;
    }
  }

  private ensureCronListener() {
    if (this.cronListenerRegistered) {
      return;
    }

    CronSingleton.instance.onFire(this.handleCronFire.bind(this));
    this.cronListenerRegistered = true;
  }

  private async handleCronFire(ctx: TCronJobContext) {
    const trace: TBehaviorTraceContext = {
      turnId: createCronTurnId(),
      chatId: ctx.scope,
      platform: undefined,
    };
    const handlerStart = performance.now();
    logHandlerStarted(trace, "cron-fire");

    const canonicalChatId = ctx.scope;
    if (canonicalChatId === undefined) {
      this.logger.warning(`handleCronFire: job "${ctx.name}" has no scope, skipping delivery`);
      logHandlerCompleted(trace, "cron-fire", handlerStart, false, 0, "missing scope", undefined);
      return;
    }

    const parsedScope = parseCanonicalChatKey(canonicalChatId);
    if (parsedScope === undefined) {
      this.logger.warning(
        `handleCronFire: job "${ctx.name}" has invalid scope "${canonicalChatId}", skipping delivery`,
      );
      logHandlerCompleted(trace, "cron-fire", handlerStart, false, 0, "invalid scope", undefined);
      return;
    }

    trace.platform = parsedScope.platform;

    const transport = this.transports.get(parsedScope.platform);
    if (transport === undefined) {
      this.logger.warning(
        `handleCronFire: no ${parsedScope.platform} transport for reminder "${ctx.name}", skipping delivery`,
      );
      logHandlerCompleted(
        trace,
        "cron-fire",
        handlerStart,
        false,
        0,
        "missing transport",
        undefined,
      );
      return;
    }

    if (ctx.taskPrompt !== undefined) {
      const taskKey = JSON.stringify([canonicalChatId, ctx.name]);

      if (this.runningCronTaskKeys.has(taskKey)) {
        this.logger.warning(`handleCronFire: task "${ctx.name}" is already running, skipping`);
        logHandlerCompleted(
          trace,
          "cron-fire",
          handlerStart,
          true,
          0,
          "task overlap skipped",
          undefined,
        );
        return;
      }

      this.runningCronTaskKeys.add(taskKey);

      try {
        await this.handleCronDelivery(
          ctx,
          canonicalChatId,
          parsedScope,
          transport,
          trace,
          handlerStart,
        );
      } finally {
        this.runningCronTaskKeys.delete(taskKey);
      }

      return;
    }

    await this.handleCronDelivery(
      ctx,
      canonicalChatId,
      parsedScope,
      transport,
      trace,
      handlerStart,
    );
  }

  private async handleCronDelivery(
    ctx: TCronJobContext,
    canonicalChatId: string,
    parsedScope: { platform: EMessagePlatform; chatId: string },
    transport: TMessageTransport,
    trace: TBehaviorTraceContext,
    handlerStart: number,
  ) {
    let text: TOption<string>;
    let memoryPrefix = "CRON REMINDER";

    if (ctx.taskPrompt !== undefined) {
      const taskResult = await generateScheduledTaskText(ctx, this.ai, trace);
      text = taskResult.text;
      memoryPrefix = "CRON TASK";
      logCronTaskCompleted(trace, taskResult);
    } else {
      text = await generateReminderText(ctx, this.ai, trace);
    }

    if (text === undefined) {
      this.logger.info(`handleCronFire: job "${ctx.name}" has no reminder text, skipping delivery`);
      logHandlerCompleted(
        trace,
        "cron-fire",
        handlerStart,
        false,
        0,
        "missing reminder text",
        undefined,
      );
      return;
    }

    if (text.trim().length === 0) {
      this.logger.info(
        `handleCronFire: job "${ctx.name}" has blank reminder text, skipping delivery`,
      );
      logHandlerCompleted(
        trace,
        "cron-fire",
        handlerStart,
        false,
        0,
        "blank reminder text",
        undefined,
      );
      return;
    }

    const sendStart = performance.now();

    try {
      await transport.sendText(parsedScope.chatId, text);
      logTransportSendCompleted(
        trace,
        sendStart,
        parsedScope.platform,
        true,
        text.length,
        undefined,
      );
    } catch (error) {
      this.logger.error(
        `handleCronFire: failed to deliver reminder "${ctx.name}" to ${parsedScope.platform} chat ${parsedScope.chatId}: ${String(error)}`,
      );
      logTransportSendCompleted(
        trace,
        sendStart,
        parsedScope.platform,
        false,
        text.length,
        String(error),
      );
      logHandlerCompleted(
        trace,
        "cron-fire",
        handlerStart,
        false,
        text.length,
        "send failed",
        String(error),
      );
      return;
    }

    const saveStart = performance.now();

    try {
      const saveResult = await Memory.instance.save({
        chatId: canonicalChatId,
        author: ERole.Assistant,
        importance: EMemoryImportance.Low,
        message: `[${memoryPrefix} ${ctx.name}]: ${text}`,
      });
      logMemorySaveCompleted(
        trace,
        saveStart,
        ERole.Assistant,
        EMemoryImportance.Low,
        text.length,
        saveResult,
      );

      if ("operation" in saveResult) {
        this.logger.error(
          `handleCronFire: failed to save reminder "${ctx.name}" to memory for chat ${canonicalChatId}: ${String(saveResult.error)}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `handleCronFire: failed to save reminder "${ctx.name}" to memory for chat ${canonicalChatId}: ${String(error)}`,
      );
      logMemorySaveCompleted(
        trace,
        saveStart,
        ERole.Assistant,
        EMemoryImportance.Low,
        text.length,
        { operation: "write", error: String(error) },
      );
    }

    logHandlerCompleted(
      trace,
      "cron-fire",
      handlerStart,
      true,
      text.length,
      "completed",
      undefined,
    );
  }
}

function logMessageReceived(trace: TBehaviorTraceContext, message: TPlatformMessage) {
  AppLogger.instance.record({
    trace,
    event: "message.received",
    component: "messaging",
    summary: `message received platform=${message.platform} type=${message.message.type}`,
    metadata: {
      platform: message.platform,
      messageType: message.message.type,
      messageChars: message.message.content.length,
      attachmentCount: 0,
      attachmentKinds: [],
    },
  });
}

function logHandlerStarted(trace: TBehaviorTraceContext, handler: string) {
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
  trace: TBehaviorTraceContext,
  handler: string,
  start: number,
  success: boolean,
  replyChars: number,
  summary: string,
  error: TOption<string>,
) {
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

function logCronTaskCompleted(trace: TBehaviorTraceContext, result: TScheduledTaskResult) {
  AppLogger.instance.record({
    trace,
    event: "cron.task.completed",
    component: "messaging",
    success: result.text !== undefined && result.text.trim().length > 0,
    durationMs: result.durationMs,
    summary: "scheduled task completed",
    metadata: {
      mode: "task",
      iterations: result.iterations,
      toolCallCount: result.toolCallCount,
      stopReason: result.stopReason ?? "threw",
      deliveredTextChars: result.text?.length ?? 0,
    },
  });
}

function logTransportSendCompleted(
  trace: TBehaviorTraceContext,
  start: number,
  platform: string,
  success: boolean,
  replyChars: number,
  error: TOption<string>,
) {
  let level = EBehaviorLogLevel.Info;

  if (!success) {
    level = EBehaviorLogLevel.Error;
  }

  AppLogger.instance.record({
    trace,
    event: "transport.send.completed",
    component: "messaging",
    level,
    success,
    durationMs: performance.now() - start,
    summary: `transport send completed platform=${platform}`,
    metadata: {
      platform,
      replyChars,
    },
    error: sanitizeErrorMessage(error),
  });
}

function logMemorySaveCompleted(
  trace: TBehaviorTraceContext,
  start: number,
  author: ERole,
  importance: EMemoryImportance,
  messageChars: number,
  result: TMemorySaveResult,
) {
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
