import {
  AppLogger,
  createMessageTurnId,
  EBehaviorLogLevel,
  type TBehaviorTraceContext,
} from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger, type TLogger } from "@bellaclaw/shared";
import { ERole } from "../ai/types";
import { startHandlerSpan } from "../app-logger/operations";
import { startSpan } from "../app-logger/span";
import {
  AuthorizationService,
  EAuthorizationDecision,
  type TAuthorizationResult,
} from "../authorization";
import { runCommand } from "../commands";
import { ESubscriptionMode, EventBus, type TEventContext } from "../events";
import { EEventType, type TDeliveryTranscript, type TEvent } from "../events/catalog";
import { MessageHandler } from "../message-handler";
import type { TIncommingMessage } from "../message-handler/types";
import { createCanonicalChatKey, parseCanonicalChatKey } from "./chat-key";
import type { EMessagePlatform, TMessageTransport, TPlatformMessage } from "./types";

export class MessagingAdapter {
  private static _instance: TOption<MessagingAdapter>;
  private logger: TLogger = createLogger("MESSAGING");
  private transports = new Map<EMessagePlatform, TMessageTransport>();
  private authorization = AuthorizationService.instance;
  private outboundBackoffMs = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000];

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

  public setup(): void {
    const bus = EventBus.instance;

    bus.subscribe({
      consumer: "outbound",
      type: EEventType.ReplyReady,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.outboundBackoffMs,
      handler: (event, ctx) =>
        this.send(event.payload.chatId, event.payload.text, event.payload.transcript, event, ctx),
    });
    bus.subscribe({
      consumer: "outbound",
      type: EEventType.DeliveryReady,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.outboundBackoffMs,
      handler: (event, ctx) =>
        this.send(event.payload.chatId, event.payload.text, event.payload.transcript, event, ctx),
    });
    bus.subscribe({
      consumer: "outbound",
      type: EEventType.NoticeReady,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.outboundBackoffMs,
      handler: (event, ctx) =>
        this.send(event.payload.chatId, event.payload.text, undefined, event, ctx),
    });
  }

  public async handleInboundMessage(message: TPlatformMessage) {
    const receivedAt = new Date();
    const canonicalChatId = createCanonicalChatKey(message.platform, message.chatId);
    const trace: TBehaviorTraceContext = {
      turnId: createMessageTurnId(),
      chatId: canonicalChatId,
      platform: message.platform,
    };
    const span = startHandlerSpan(trace, "messaging");

    try {
      const transport = this.transports.get(message.platform);
      if (transport === undefined) {
        this.logger.error(`handleInboundMessage: no transport for platform ${message.platform}`);
        span.fail("missing transport", 0);
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

      const handler = MessageHandler.getInstance(canonicalChatId);
      const reply = await handler.handleMessage(incomingMessage, trace, message.platform);

      if (reply.trim().length === 0) {
        span.ok("empty reply", 0);
        return;
      }

      const sendError = await this.sendText(transport, message.chatId, reply, trace);
      if (sendError !== undefined) {
        span.fail("send failed", reply.length, sendError);
        return;
      }

      span.ok("completed", reply.length);
    } catch (error) {
      span.fail("failed", 0, String(error));
      throw error;
    }
  }

  private async send(
    chatId: string,
    text: string,
    transcript: TOption<TDeliveryTranscript>,
    event: TEvent,
    ctx: TEventContext,
  ): Promise<void> {
    const owner = parseCanonicalChatKey(chatId);
    if (owner === undefined) {
      throw new Error("Unknown chat platform");
    }

    const transport = this.transports.get(owner.platform);
    if (transport === undefined) {
      // retried with the outbound backoff until the transport registers
      throw new Error(`No ${owner.platform} transport`);
    }

    const failure = await this.sendText(transport, owner.chatId, text, event.trace);
    if (failure !== undefined) {
      throw new Error(failure);
    }

    await ctx.complete(async (_tx, emit) => {
      emit(
        EEventType.MessageSent,
        { chatId, sourceType: event.type, chars: text.length, sentAt: Date.now(), transcript },
        undefined,
        undefined,
      );
    });
  }

  public async sendText(
    transport: TMessageTransport,
    chatId: string,
    text: string,
    trace: TBehaviorTraceContext,
  ): Promise<TOption<string>> {
    const span = startSpan(trace, "transport.send.completed", "messaging", {
      summary: `transport send completed platform=${transport.platform}`,
      metadata: {
        platform: transport.platform,
        replyChars: text.length,
      },
    });
    try {
      await transport.sendText(chatId, text);
    } catch (error) {
      const failure = String(error);
      this.logger.error(
        `sendText: failed to send to ${transport.platform} chat ${chatId}: ${failure}`,
      );
      span.fail(failure, { level: EBehaviorLogLevel.Error });
      return failure;
    }
    span.ok();
    return undefined;
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
