import { EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger, type TLogger } from "@bellaclaw/shared";
import { startSpan } from "../app-logger/span";
import { ESubscriptionMode, EventBus, type TEventContext } from "../events";
import { EEventType, type TDeliveryTranscript, type TEvent } from "../events/catalog";
import { parseCanonicalChatKey } from "./chat-key";
import type { EMessagePlatform, TAttachmentRef, TMessageTransport } from "./types";

export class MessagingAdapter {
  private static _instance: TOption<MessagingAdapter>;
  private logger: TLogger = createLogger("MESSAGING");
  private transports = new Map<EMessagePlatform, TMessageTransport>();
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

  public fetchAttachment(chatId: string, ref: TAttachmentRef): Promise<Uint8Array> {
    const owner = this.resolve(chatId);
    return owner.transport.fetchAttachment(owner.chatId, ref);
  }

  public deleteAttachment(chatId: string, ref: TAttachmentRef): Promise<void> {
    const owner = this.resolve(chatId);
    return owner.transport.deleteAttachment(owner.chatId, ref);
  }

  private resolve(chatId: string): { transport: TMessageTransport; chatId: string } {
    const owner = parseCanonicalChatKey(chatId);
    if (owner === undefined) {
      throw new Error("Unknown chat platform");
    }

    const transport = this.transports.get(owner.platform);
    if (transport === undefined) {
      throw new Error(`No ${owner.platform} transport`);
    }

    return { transport, chatId: owner.chatId };
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
