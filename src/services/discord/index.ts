import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform, type TMessageTransport } from "../messaging/types";

export class DiscordSingleton implements TMessageTransport {
  private static _instance: DiscordSingleton;
  private logger: TLogger = createLogger("DISCORD");
  private client: Client;
  private readyPromise: TOption<Promise<void>>;
  private messageHandlerRegistered = false;
  public platform = EMessagePlatform.Discord;

  private constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
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
  }

  private async onReady(c: Client<true>) {
    this.logger.info(`Logged in as ${c.user.tag}!`);
  }

  public async sendText(chatId: string, text: string): Promise<void> {
    const user = await this.client.users.fetch(chatId);
    await user.send(text);
  }

  public setup(): Promise<void> {
    if (this.readyPromise !== undefined) {
      return this.readyPromise;
    }

    MessagingAdapter.instance.registerTransport(this);

    this.readyPromise = new Promise((resolve, reject) => {
      const readyListener = (client: Client<true>) => {
        void this.onReady(client);
        resolve();
      };

      this.client.once(Events.ClientReady, readyListener);

      this.client.login(Bun.env.DISCORD_TOKEN).catch((error) => {
        this.client.off(Events.ClientReady, readyListener);
        this.readyPromise = undefined;
        reject(error);
      });
    });

    if (!this.messageHandlerRegistered) {
      this.client.on(Events.MessageCreate, this.handleMessage.bind(this));
      this.messageHandlerRegistered = true;
    }

    return this.readyPromise;
  }
}
