import { ChannelType, Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform, type TMessageTransport } from "../messaging/types";

const DISCORD_MESSAGE_MAX_LENGTH = 2_000;

export class DiscordSingleton implements TMessageTransport {
  private static _instance: DiscordSingleton;
  private logger: TLogger = createLogger("DISCORD");
  private client: Client;
  private readyPromise: TOption<Promise<void>>;
  private retryTimer: TOption<ReturnType<typeof setTimeout>>;
  private retryDelayMs = 2_000;
  private messageHandlerRegistered = false;
  public platform = EMessagePlatform.Discord;

  private constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
    });
  }

  public static get instance() {
    if (!DiscordSingleton._instance) {
      DiscordSingleton._instance = new DiscordSingleton();
    }

    return DiscordSingleton._instance;
  }

  private async handleMessage(message: Message) {
    if (message.channel.type !== ChannelType.DM) {
      return;
    }

    if (message.author.bot) {
      return;
    }

    if (message.author.id === this.client.user?.id) {
      return;
    }

    if (!this.client.user?.id) {
      return;
    }

    if (message.content.trim().length === 0) {
      return;
    }

    try {
      await MessagingAdapter.instance.handleInboundMessage({
        platform: EMessagePlatform.Discord,
        chatId: message.author.id,
        author: {
          username: message.author.username,
          id: message.author.id,
        },
        message: {
          type: "text",
          content: message.content,
        },
      });
    } catch (error) {
      this.logger.error(
        `handleMessage: failed to process message from ${message.author.id}: ${String(error)}`,
      );
    }
  }

  private async onReady(c: Client<true>) {
    this.logger.info(`Logged in as ${c.user.tag}!`);
  }

  public async sendText(chatId: string, text: string): Promise<void> {
    const user = await this.client.users.fetch(chatId);

    let remainingText = text;

    while (remainingText.length > DISCORD_MESSAGE_MAX_LENGTH) {
      let chunkEnd = remainingText.lastIndexOf("\n", DISCORD_MESSAGE_MAX_LENGTH - 1) + 1;

      if (chunkEnd <= 1) {
        chunkEnd = DISCORD_MESSAGE_MAX_LENGTH;
      }

      await user.send(remainingText.slice(0, chunkEnd));
      remainingText = remainingText.slice(chunkEnd);
    }

    await user.send(remainingText);
  }

  public setup(): Promise<void> {
    if (this.readyPromise !== undefined) {
      return this.readyPromise;
    }

    const token = Bun.env.DISCORD_TOKEN?.trim();
    if (token === undefined || token.length === 0) {
      this.logger.warning("Discord unavailable: DISCORD_TOKEN is not configured");
      return Promise.resolve();
    }

    this.readyPromise = new Promise((resolve) => {
      const readyListener = (client: Client<true>) => {
        if (this.retryTimer !== undefined) {
          clearTimeout(this.retryTimer);
          this.retryTimer = undefined;
        }

        MessagingAdapter.instance.registerTransport(this);
        void this.onReady(client);
        resolve();
      };

      this.client.once(Events.ClientReady, readyListener);

      this.client.login(token).catch((error) => {
        this.client.off(Events.ClientReady, readyListener);
        this.readyPromise = undefined;
        this.logger.error(`Discord unavailable: failed to log in: ${String(error)}`);

        if (this.retryTimer === undefined) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.setup();
          }, this.retryDelayMs);
        }

        resolve();
      });
    });

    if (!this.messageHandlerRegistered) {
      this.client.on(Events.MessageCreate, this.handleMessage.bind(this));
      this.messageHandlerRegistered = true;
    }

    return this.readyPromise;
  }
}
