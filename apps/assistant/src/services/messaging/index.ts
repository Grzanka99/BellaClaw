import { EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { EEventType } from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { createLogger, type TLogger } from "@bellaclaw/shared";
import { AppChannel } from "../app";
import { startSpan } from "../app-logger/span";
import { ESubscriptionMode, EventBus, type TEventContext } from "../events";
import type { TDeliveryTranscript, TDisplay, TEvent } from "../events/catalog";
import { IdentityService, type TChatAddress } from "../identity";
import {
  EMessagePlatform,
  type TAttachmentRef,
  type TAttachmentStore,
  type TMessageTransport,
} from "./types";

export class MessagingAdapter {
  private static _instance: TOption<MessagingAdapter>;
  private logger: TLogger = createLogger("MESSAGING");
  private transports = new Map<EMessagePlatform, TMessageTransport>();
  private attachmentStores = new Map<EMessagePlatform, TAttachmentStore>();
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
    this.attachmentStores.set(transport.platform, transport);
  }

  // NOTE: the app sends nothing (see send), so it registers only where its files are kept
  public registerAttachmentStore(store: TAttachmentStore) {
    this.attachmentStores.set(store.platform, store);
  }

  public fetchAttachment(ref: TAttachmentRef, maxBytes: number): Promise<TOption<Uint8Array>> {
    return this.registered(this.attachmentStores, ref.channel).fetchAttachment(ref, maxBytes);
  }

  public deleteAttachment(ref: TAttachmentRef): Promise<void> {
    return this.registered(this.attachmentStores, ref.channel).deleteAttachment(ref);
  }

  private registered<T>(registry: Map<EMessagePlatform, T>, channel: EMessagePlatform): T {
    const found = registry.get(channel);
    if (found === undefined) {
      throw new Error(`Nothing registered for ${channel}`);
    }

    return found;
  }

  public setup(): void {
    const bus = EventBus.instance;

    bus.subscribe({
      consumer: "outbound",
      type: EEventType.ReplyReady,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.outboundBackoffMs,
      handler: (event, ctx) =>
        this.send(
          event.payload.conversationKey,
          { channel: event.payload.channel, address: event.payload.replyAddress },
          event.payload.text,
          event.payload.transcript,
          event.payload.display,
          event,
          ctx,
        ),
    });
    bus.subscribe({
      consumer: "outbound",
      type: EEventType.DeliveryReady,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.outboundBackoffMs,
      handler: (event, ctx) =>
        this.send(
          event.payload.chatId,
          undefined,
          event.payload.text,
          event.payload.transcript,
          undefined,
          event,
          ctx,
        ),
    });
    // a notice is shown in history and never replayed to the model
    bus.subscribe({
      consumer: "outbound",
      type: EEventType.NoticeReady,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.outboundBackoffMs,
      handler: (event, ctx) =>
        this.send(
          event.payload.chatId,
          undefined,
          event.payload.text,
          undefined,
          { text: event.payload.text, command: event.payload.command },
          event,
          ctx,
        ),
    });
  }

  // key: the conversation the message belongs to, possibly the old key of a linked address;
  // origin: where a reply goes. A message without one, a delivery or a notice, goes to the main
  // channel, decided at each attempt: the app while the account has a registered device, else
  // where Identity resolves the key
  private async send(
    key: string,
    origin: TOption<TChatAddress>,
    text: string,
    transcript: TOption<TDeliveryTranscript>,
    display: TOption<TDisplay>,
    event: TEvent,
    ctx: TEventContext,
  ): Promise<void> {
    const resolved = await IdentityService.instance.resolve(key);
    const chatId = resolved?.conversationKey ?? key;
    let destination = origin ?? resolved?.destination;

    if (origin === undefined && resolved !== undefined) {
      const accountId = IdentityService.instance.accountIdOf(resolved.ownerKey);

      if (accountId !== undefined && (await AppChannel.instance.hasDevice(accountId))) {
        destination = { channel: EMessagePlatform.App, address: accountId };
      }
    }

    if (destination === undefined) {
      throw new Error("Unknown chat platform");
    }

    // NOTE: the app has nothing to send: the transcript row that message.sent writes is the
    // delivery. Any other channel is retried with the outbound backoff until its transport
    // registers
    if (destination.channel !== EMessagePlatform.App) {
      const transport = this.registered(this.transports, destination.channel);
      const failure = await this.sendText(transport, destination.address, text, event.trace);
      if (failure !== undefined) {
        throw new Error(failure);
      }
    }

    await ctx.complete(async (_tx, emit) => {
      emit(
        EEventType.MessageSent,
        {
          chatId,
          channel: destination.channel,
          sourceType: event.type,
          chars: text.length,
          sentAt: Date.now(),
          transcript,
          display,
        },
        undefined,
        // the conversation's lane, so the transcript append orders with its turns
        chatId,
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
