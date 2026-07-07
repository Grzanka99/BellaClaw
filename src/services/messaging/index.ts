import { generateReminderText } from "../../handlers/generate-reminder-text";
import type { TCronJobContext } from "../../lib/cron-engine";
import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";
import { AiConnector } from "../ai/api";
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
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "../message-handler";
import { attachMessageTrace } from "../message-handler/trace";
import type { TIncommingMessage } from "../message-handler/types";
import { SettingsIntentClassifier } from "../settings-intent-classifier";
import { SettingsMessageHandler } from "../settings-message-handler";
import { createCanonicalChatKey, parseCanonicalChatKey } from "./chat-key";
import type { EMessagePlatform, TMessageTransport, TPlatformMessage } from "./types";

export class MessagingAdapter {
  private static _instance: TOption<MessagingAdapter>;
  private logger: TLogger = createLogger("MESSAGING");
  private transports = new Map<EMessagePlatform, TMessageTransport>();
  private ai = AiConnector.instance;
  private cronListenerRegistered = false;

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
    const handlerStart = performance.now();
    const trace: TBehaviorTraceContext = {
      turnId: createMessageTurnId(),
      chatId: canonicalChatId,
      platform: message.platform,
    };
    logMessageReceived(trace, message);

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

    const classifier = SettingsIntentClassifier.instance;
    const intent = await classifier.classify(message.message.content, canonicalChatId, trace);

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

    let reply: string;

    if (intent === undefined) {
      this.logger.warning(
        `handleInboundMessage: settings-intent classifier returned no result; falling back to normal handler for platform ${message.platform}, raw chat ${message.chatId}, canonical chat ${canonicalChatId}, author ${message.author.id}, message type ${message.message.type}, content length ${message.message.content.length}`,
      );
      const handler = MessageHandler.getInstance(canonicalChatId);
      reply = await handler.handleMessage(incomingMessage);
    } else if (intent.intent === "settings") {
      const handler = SettingsMessageHandler.getInstance(canonicalChatId);
      reply = await handler.handleMessage(incomingMessage);
    } else {
      const handler = MessageHandler.getInstance(canonicalChatId);
      reply = await handler.handleMessage(incomingMessage);
    }

    if (reply.trim().length === 0) {
      logHandlerCompleted(trace, "messaging", handlerStart, true, 0, "empty reply", undefined);
      return;
    }

    const sendStart = performance.now();

    try {
      await transport.sendText(message.chatId, reply);
      logTransportSendCompleted(trace, sendStart, message.platform, true, reply.length, undefined);
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

    logHandlerCompleted(
      trace,
      "messaging",
      handlerStart,
      true,
      reply.length,
      "completed",
      undefined,
    );
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

    const text = await generateReminderText(ctx, this.ai, trace);
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
        message: `[CRON REMINDER ${ctx.name}]: ${text}`,
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
  result: unknown,
) {
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
