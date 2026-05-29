import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import { generateReminderText } from "../../handlers/generate-reminder-text";
import type { TCronEngineJobContext } from "../../lib/cron-engine";
import { createLogger, type TLogger } from "../../utils/logger";
import { AiConnector } from "../ai/api";
import { ERole } from "../ai/types";
import { CronSingleton } from "../cron";
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "../message-handler";

export class DiscordSingleton {
  private static _instance: DiscordSingleton;
  private logger: TLogger = createLogger("DISCORD");
  private ai = AiConnector.instance;
  private client: Client;

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
    if (message.author.id === this.client.user?.id) {
      return;
    }

    if (!this.client.user?.id) {
      return;
    }

    const messageHandler = MessageHandler.getInstance(message.author.id);

    const res = await messageHandler.handleMessage({
      chatId: message.author.id,
      author: {
        type: ERole.User,
        username: message.author.username,
        id: message.author.id,
      },
      message: {
        type: "text",
        content: message.content,
      },
    });

    message.author.send(String(res));
  }

  private async onReady(c: Client<true>) {
    this.logger.info(`Logged in as ${c.user.tag}!`);
    CronSingleton.instance.setup();
  }

  private async handleCronFire(ctx: TCronEngineJobContext) {
    const userId = ctx.scope;
    if (userId === undefined) {
      this.logger.warning(`handleCronFire: job "${ctx.name}" has no scope, skipping delivery`);
      return;
    }

    const text = await generateReminderText(ctx, this.ai);
    if (text === undefined) {
      this.logger.info(`handleCronFire: job "${ctx.name}" has no reminder text, skipping delivery`);
      return;
    }

    try {
      const user = await this.client.users.fetch(userId);
      await user.send(text);
    } catch (error) {
      this.logger.error(
        `handleCronFire: failed to deliver reminder "${ctx.name}" to user ${userId}: ${String(error)}`,
      );
      return;
    }

    try {
      const saveResult = await Memory.instance.save({
        chatId: userId,
        author: ERole.Assistant,
        importance: EMemoryImportance.Low,
        message: `[CRON REMINDER ${ctx.name}]: ${text}`,
      });

      if ("operation" in saveResult) {
        this.logger.error(
          `handleCronFire: failed to save reminder "${ctx.name}" to memory for user ${userId}: ${String(saveResult.error)}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `handleCronFire: failed to save reminder "${ctx.name}" to memory for user ${userId}: ${String(error)}`,
      );
    }
  }

  public setup() {
    this.client.once(Events.ClientReady, this.onReady.bind(this));
    this.client.on(Events.MessageCreate, this.handleMessage.bind(this));
    CronSingleton.instance.onCronEvent(this.handleCronFire.bind(this));
    this.client.login(Bun.env.DISCORD_TOKEN);
  }
}
