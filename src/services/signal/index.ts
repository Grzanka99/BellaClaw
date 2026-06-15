import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform, type TMessageTransport } from "../messaging/types";
import { SignalClient, type TSignalInboundMessage } from "./client";

export class SignalSingleton implements TMessageTransport {
  private static _instance: TOption<SignalSingleton>;
  private logger: TLogger = createLogger("SIGNAL");
  private client: TOption<SignalClient>;
  private setupPromise: TOption<Promise<void>>;
  private typingInFlightByRecipient = new Map<string, number>();
  private retryDelayMs = 2000;
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

    this.setupPromise = this.setupWithRetries();
    await this.setupPromise;
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
      this.logger.error("sendText: Signal client is not initialized");
      return;
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

    const inFlightCount = this.typingInFlightByRecipient.get(message.sourceNumber) ?? 0;
    this.typingInFlightByRecipient.set(message.sourceNumber, inFlightCount + 1);

    if (inFlightCount === 0 && client !== undefined) {
      void client.showTyping(message.sourceNumber).catch((error) => {
        this.logger.error(`showTyping failed: ${String(error)}`);
      });
    }

    try {
      await MessagingAdapter.instance.handleInboundMessage({
        platform: EMessagePlatform.Signal,
        chatId: message.sourceNumber,
        author: {
          id: message.sourceNumber,
          username: message.sourceName,
        },
        message: {
          type: "text",
          content: message.message,
        },
      });
    } finally {
      const currentCount = this.typingInFlightByRecipient.get(message.sourceNumber) ?? 1;
      const nextCount = currentCount - 1;

      if (nextCount <= 0) {
        this.typingInFlightByRecipient.delete(message.sourceNumber);
      } else {
        this.typingInFlightByRecipient.set(message.sourceNumber, nextCount);
      }

      if (currentCount === 1 && client !== undefined) {
        try {
          await client.hideTyping(message.sourceNumber);
        } catch (error) {
          this.logger.error(`hideTyping failed: ${String(error)}`);
        }
      }
    }
  }
}
