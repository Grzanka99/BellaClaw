import { createMessageTurnId } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger, type TLogger } from "@bellaclaw/shared";
import { ChannelType, Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import { EventBus } from "../events";
import { EEventType } from "../events/catalog";
import { MessagingAdapter } from "../messaging";
import { createCanonicalChatKey } from "../messaging/chat-key";
import {
  EMessagePlatform,
  readAttachment,
  SUPPORTED_IMAGE_TYPES,
  type TAttachmentRef,
  type TMessageTransport,
} from "../messaging/types";

const DISCORD_MESSAGE_MAX_LENGTH = 2_000;

export class DiscordSingleton implements TMessageTransport {
  private static _instance: DiscordSingleton;
  private logger: TLogger = createLogger("DISCORD");
  private client: Client;
  private readyPromise: TOption<Promise<void>>;
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

    // NOTE: the reference names the message, not the CDN URL, which expires
    const attachments: TAttachmentRef[] = [];
    for (const attachment of message.attachments.values()) {
      const mimeType = attachment.contentType;
      if (mimeType === null || !SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
        continue;
      }

      attachments.push({ id: `${message.id}:${attachment.id}`, mimeType });
    }

    if (message.content.trim().length === 0 && attachments.length === 0) {
      return;
    }

    const receivedAt = Date.now();
    const chatId = createCanonicalChatKey(EMessagePlatform.Discord, message.author.id);

    try {
      await EventBus.instance.publish({
        type: EEventType.MessageReceived,
        source: "discord",
        key: chatId,
        trace: { turnId: createMessageTurnId(), chatId, platform: EMessagePlatform.Discord },
        payload: {
          chatId,
          content: message.content,
          attachments,
          receivedAt,
          platform: EMessagePlatform.Discord,
        },
        causationId: undefined,
        dedupeKey: `discord:${message.id}`,
      });
    } catch (error) {
      this.logger.error(`handleMessage: inbound Discord message failed: ${String(error)}`);
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

  public async fetchAttachment(
    chatId: string,
    ref: TAttachmentRef,
    maxBytes: number,
  ): Promise<TOption<Uint8Array>> {
    const [messageId, attachmentId] = ref.id.split(":");
    if (messageId === undefined || attachmentId === undefined) {
      throw new Error("Invalid Discord attachment reference");
    }

    const user = await this.client.users.fetch(chatId);
    const channel = await user.createDM();
    // NOTE: a cached message still carries the URL it arrived with, which expires
    const message = await channel.messages.fetch({ message: messageId, force: true });
    const attachment = message.attachments.get(attachmentId);
    if (attachment === undefined) {
      throw new Error("Discord attachment is missing");
    }

    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`Discord attachment fetch failed with status ${response.status}`);
    }

    return readAttachment(response, maxBytes);
  }

  // NOTE: Discord keeps the file with the message; there is nothing to delete
  public async deleteAttachment(): Promise<void> {
    return;
  }

  public setup(): Promise<void> {
    if (this.readyPromise !== undefined) {
      return this.readyPromise;
    }

    const token = Bun.env.DISCORD_TOKEN;
    if (token === undefined || token.trim().length === 0) {
      this.logger.info("Discord disabled");
      return Promise.resolve();
    }

    MessagingAdapter.instance.registerTransport(this);

    this.readyPromise = new Promise((resolve, reject) => {
      const readyListener = (client: Client<true>) => {
        void this.onReady(client);
        resolve();
      };

      this.client.once(Events.ClientReady, readyListener);

      this.client.login(token).catch((error) => {
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
