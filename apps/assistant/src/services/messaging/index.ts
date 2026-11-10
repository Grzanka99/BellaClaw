import {
  AppLogger,
  createMessageTurnId,
  EBehaviorLogLevel,
  type TBehaviorTraceContext,
} from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger, type TLogger } from "@bellaclaw/shared";
import { ERole } from "../ai/types";
import { logHandlerCompleted } from "../app-logger/operations";
import { sanitizeErrorMessage } from "../app-logger/sanitizers";
import {
  AuthorizationService,
  EAuthorizationDecision,
  type TAuthorizationResult,
} from "../authorization";
import { MessageHandler } from "../message-handler";
import { attachMessageTrace } from "../message-handler/trace";
import type { TIncommingMessage } from "../message-handler/types";
import { createCanonicalChatKey, parseCanonicalChatKey } from "./chat-key";
import { formatCommandList, runCommand } from "./commands";
import type { EMessagePlatform, TMessageTransport, TPlatformMessage } from "./types";

export class MessagingAdapter {
  private static _instance: TOption<MessagingAdapter>;
  private logger: TLogger = createLogger("MESSAGING");
  private transports = new Map<EMessagePlatform, TMessageTransport>();
  private authorization = AuthorizationService.instance;
  private transportWaitAttempts = 60;
  private transportWaitIntervalMs = 1000;

  private constructor() {}

  public static get instance() {
    if (!MessagingAdapter._instance) {
      MessagingAdapter._instance = new MessagingAdapter();
    }

    return MessagingAdapter._instance;
  }

  public registerTransport(transport: TMessageTransport) {
    this.transports.set(transport.platform, transport);
  }

  public async sendMcpConnectedMessage(chatId: string, profileId: string): Promise<void> {
    await this.sendNotice(chatId, `Connected MCP profile ${profileId}.`);
  }

  public async sendNotice(chatId: string, text: string): Promise<void> {
    const owner = parseCanonicalChatKey(chatId);
    if (owner === undefined) {
      throw new Error("Unknown chat platform for notice");
    }
    const transport = this.transports.get(owner.platform);
    if (transport === undefined) {
      throw new Error("Chat transport is unavailable for notice");
    }
    await transport.sendText(owner.chatId, text);
  }

  public async handleInboundMessage(message: TPlatformMessage) {
    const receivedAt = new Date();
    const canonicalChatId = createCanonicalChatKey(message.platform, message.chatId);
    const handlerStart = performance.now();
    const trace: TBehaviorTraceContext = {
      turnId: createMessageTurnId(),
      chatId: canonicalChatId,
      platform: message.platform,
    };

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

      const authorizationResult = await this.authorization.authorize(
        canonicalChatId,
        message.message.content,
      );

      if (authorizationResult.decision !== EAuthorizationDecision.Allow) {
        logAuthorizationDecision(trace, authorizationResult);
      }

      if (
        authorizationResult.decision === EAuthorizationDecision.FailedAttempt ||
        authorizationResult.decision === EAuthorizationDecision.Locked
      ) {
        return;
      }

      let authorizationReply: TOption<string>;

      if (authorizationResult.decision === EAuthorizationDecision.Activated) {
        authorizationReply = "Activated.";
      } else if (authorizationResult.decision === EAuthorizationDecision.AlreadyActivated) {
        authorizationReply = "Already activated.";
      }

      if (authorizationReply !== undefined) {
        await this.sendText(transport, message.chatId, authorizationReply, trace);
        return;
      }

      logMessageReceived(trace, message);

      const commandReply = await runCommand(canonicalChatId, message.message.content);

      if (typeof commandReply === "string") {
        await this.sendText(transport, message.chatId, commandReply, trace);
        return;
      }

      const incomingMessage: TIncommingMessage = {
        chatId: canonicalChatId,
        receivedAt,
        author: {
          type: ERole.User,
        },
        message: { ...message.message },
      };
      if (commandReply !== undefined) {
        incomingMessage.message.content = commandReply.prompt;
      }
      attachMessageTrace(incomingMessage, trace);

      const handler = MessageHandler.getInstance(canonicalChatId);
      const reply = await handler.handleMessage(
        incomingMessage,
        formatCommandList(),
        message.platform,
      );

      if (reply.trim().length === 0) {
        logHandlerCompleted(trace, "messaging", handlerStart, true, 0, "empty reply", undefined);
        return;
      }

      const sendError = await this.sendText(transport, message.chatId, reply, trace);
      if (sendError !== undefined) {
        logHandlerCompleted(
          trace,
          "messaging",
          handlerStart,
          false,
          reply.length,
          "send failed",
          sendError,
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
    } catch (error) {
      logHandlerCompleted(trace, "messaging", handlerStart, false, 0, "failed", String(error));
      throw error;
    }
  }

  public async sendText(
    transport: TMessageTransport,
    chatId: string,
    text: string,
    trace: TBehaviorTraceContext,
  ): Promise<TOption<string>> {
    const start = performance.now();
    let failure: TOption<string>;
    try {
      await transport.sendText(chatId, text);
    } catch (error) {
      failure = String(error);
      this.logger.error(
        `sendText: failed to send to ${transport.platform} chat ${chatId}: ${failure}`,
      );
    }
    logTransportSendCompleted(
      trace,
      start,
      transport.platform,
      failure === undefined,
      text.length,
      failure,
    );
    return failure;
  }

  public async waitForTransport(platform: EMessagePlatform): Promise<TOption<TMessageTransport>> {
    for (let attempt = 0; attempt < this.transportWaitAttempts; attempt += 1) {
      const transport = this.transports.get(platform);

      if (transport !== undefined) {
        return transport;
      }

      await Bun.sleep(this.transportWaitIntervalMs);
    }

    return this.transports.get(platform);
  }
}

function logAuthorizationDecision(trace: TBehaviorTraceContext, result: TAuthorizationResult) {
  let level = EBehaviorLogLevel.Info;

  if (
    result.decision === EAuthorizationDecision.FailedAttempt ||
    result.decision === EAuthorizationDecision.Locked
  ) {
    level = EBehaviorLogLevel.Warning;
  }

  AppLogger.instance.record({
    trace,
    event: `authorization.${result.decision}`,
    component: "authorization",
    level,
    success:
      result.decision === EAuthorizationDecision.Activated ||
      result.decision === EAuthorizationDecision.AlreadyActivated,
    summary: `authorization ${result.decision}`,
    metadata: {
      decision: result.decision,
      failedAttempts: result.failedAttempts,
    },
  });
}

function logMessageReceived(trace: TBehaviorTraceContext, message: TPlatformMessage) {
  AppLogger.instance.record({
    trace,
    event: "message.received",
    component: "messaging",
    summary: `message received platform=${message.platform}`,
    metadata: {
      platform: message.platform,
      messageChars: message.message.content.length,
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
