import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import { createLogger, type TLogger } from "../../utils/logger";
import { OpenrouterAiProvider } from "../ai-providers/openrouter";
import { ERole } from "../ai-providers/types";
import { Memory } from "../memory";
import { MessageHandler } from "../message-handler";

export class DiscordSingleton {
  private static _instance: DiscordSingleton;
  private logger: TLogger = createLogger("DISCORD");
  private client: Client;
  private memory: Memory;
  private openrouter: OpenrouterAiProvider;

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

    this.memory = Memory.instance;
    this.openrouter = OpenrouterAiProvider.instance;
  }

  public static get instance() {
    if (!DiscordSingleton._instance) {
      DiscordSingleton._instance = new DiscordSingleton();
    }

    return DiscordSingleton._instance;
  }

  private async handleMessage(message: Message) {
    console.log(`<${message.author.username}> ${message.content}`);

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
  }

  public setup() {
    this.client.once(Events.ClientReady, this.onReady.bind(this));
    this.client.on(Events.MessageCreate, this.handleMessage.bind(this));
    this.client.login(Bun.env.DISCORD_TOKEN);
  }
}
