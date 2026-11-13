import { createMessageTurnId } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger, type TLogger } from "@bellaclaw/shared";
import { ESubscriptionMode, EventBus } from "../events";
import { EEventType, type TEvent } from "../events/catalog";
import { MessagingAdapter } from "../messaging";
import { createCanonicalChatKey, parseCanonicalChatKey } from "../messaging/chat-key";
import { EMessagePlatform, type TMessageTransport } from "../messaging/types";
import { SignalClient, type TSignalInboundMessage } from "./client";

export class SignalSingleton implements TMessageTransport {
  private static _instance: TOption<SignalSingleton>;
  private logger: TLogger = createLogger("SIGNAL");
  private client: TOption<SignalClient>;
  private setupPromise: TOption<Promise<void>>;
  private retryDelayMs = 2000;
  private setupBootGraceMs = 30_000;
  public platform = EMessagePlatform.Signal;

  private constructor() {}

  public static get instance() {
    if (!SignalSingleton._instance) {
      SignalSingleton._instance = new SignalSingleton();
    }

    return SignalSingleton._instance;
  }

  public async setup() {
    if (this.client !== undefined) {
      return;
    }

    if (this.setupPromise !== undefined) {
      return this.setupPromise;
    }

    if (Bun.env.SIGNAL_ENABLED !== "true") {
      this.logger.info("Signal disabled");
      return;
    }

    const bus = EventBus.instance;
    const typingEvents: [EEventType, boolean][] = [
      [EEventType.TurnRequested, true],
      [EEventType.TurnCompleted, false],
      [EEventType.TurnFailed, false],
      [EEventType.EventDeadLettered, false],
    ];

    for (const [type, typing] of typingEvents) {
      bus.subscribe({
        consumer: "signal-typing",
        type,
        mode: ESubscriptionMode.Live,
        backoffMs: [],
        handler: (event) => this.setTyping(event, typing),
      });
    }

    this.setupPromise = this.setupWithRetries().catch((error) => {
      this.logger.error(`Signal setup failed: ${String(error)}`);
    });

    await Promise.race([this.setupPromise, Bun.sleep(this.setupBootGraceMs)]);

    if (this.client === undefined) {
      this.logger.warning(
        `Signal is not connected after ${this.setupBootGraceMs}ms; continuing boot and retrying in the background`,
      );
    }
  }

  private async setupWithRetries() {
    const baseUrl = Bun.env.SIGNAL_CLI_RPC_URL;
    const phoneNumber = Bun.env.SIGNAL_PHONE_NUMBER;

    if (baseUrl === undefined || baseUrl.trim().length === 0) {
      this.logger.error("SIGNAL_CLI_RPC_URL is required when Signal is enabled");
      return;
    }

    if (phoneNumber === undefined || phoneNumber.trim().length === 0) {
      this.logger.error("SIGNAL_PHONE_NUMBER is required when Signal is enabled");
      return;
    }

    let client: SignalClient;
    try {
      client = new SignalClient({ baseUrl, phoneNumber });
    } catch (error) {
      this.logger.error(`Invalid Signal configuration: ${String(error)}`);
      return;
    }

    while (this.client === undefined) {
      let ready = false;
      try {
        ready = await client.checkReadiness();
      } catch (error) {
        this.logger.error(`signal-cli-rest-api readiness check failed: ${String(error)}`);
      }

      if (!ready) {
        this.logger.error("signal-cli-rest-api is not ready");
        await Bun.sleep(this.retryDelayMs);
        continue;
      }

      let unsubscribe: TOption<() => void>;
      try {
        unsubscribe = await client.subscribe(this.handleInboundMessage.bind(this));
      } catch (error) {
        this.logger.error(`Signal receive subscription failed: ${String(error)}`);
      }

      if (unsubscribe === undefined) {
        this.logger.error(
          "Signal receive subscription failed; inbound Signal messages are inactive",
        );
        await Bun.sleep(this.retryDelayMs);
        continue;
      }

      this.client = client;
      MessagingAdapter.instance.registerTransport(this);
      this.logger.info("Signal receive subscription active");
    }
  }

  public async sendText(chatId: string, text: string): Promise<void> {
    if (this.client === undefined) {
      throw new Error("Signal client is not initialized");
    }

    await this.client.sendText(chatId, text);
  }

  private async handleInboundMessage(message: TSignalInboundMessage) {
    const ownNumber = Bun.env.SIGNAL_PHONE_NUMBER;
    if (ownNumber !== undefined && message.sourceNumber === ownNumber) {
      return;
    }

    if (message.message.trim().length === 0) {
      return;
    }

    const receivedAt = Date.now();
    const client = this.client;
    if (client !== undefined) {
      if (message.timestamp !== undefined) {
        void client.sendReadReceipt(message.sourceNumber, message.timestamp).catch((error) => {
          this.logger.error(`sendReadReceipt failed: ${String(error)}`);
        });
      } else {
        this.logger.warning("sendReadReceipt skipped: Signal message timestamp missing");
      }
    }

    // NOTE: a sender retrying after a network drop re-delivers the same message under the
    // same timestamp, and signal-cli passes every copy through
    let dedupeKey: TOption<string>;
    if (message.timestamp !== undefined) {
      dedupeKey = `signal:${message.sourceNumber}:${message.timestamp}`;
    }

    const chatId = createCanonicalChatKey(EMessagePlatform.Signal, message.sourceNumber);
    await EventBus.instance.publish({
      type: EEventType.MessageReceived,
      source: "signal",
      key: chatId,
      trace: { turnId: createMessageTurnId(), chatId, platform: EMessagePlatform.Signal },
      payload: { chatId, content: message.message, receivedAt, platform: EMessagePlatform.Signal },
      causationId: undefined,
      dedupeKey,
    });
  }

  private async setTyping(event: TEvent, typing: boolean): Promise<void> {
    const client = this.client;
    const chatId = event.trace.chatId;

    if (client === undefined || chatId === undefined) {
      return;
    }

    const owner = parseCanonicalChatKey(chatId);

    if (owner === undefined || owner.platform !== EMessagePlatform.Signal) {
      return;
    }

    try {
      if (typing) {
        await client.showTyping(owner.chatId);
      } else {
        await client.hideTyping(owner.chatId);
      }
    } catch (error) {
      this.logger.error(`setTyping(${typing}) failed: ${String(error)}`);
    }
  }
}
