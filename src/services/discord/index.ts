import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import { Logger } from "../../utils/logger";
import { OpenrouterAiProvider } from "../ai-providers/openrouter";
import { Memory } from "../memory";
import { EMemoryAuthor, EMemoryImportance } from "../memory/types";

export class DiscordSingleton extends Logger {
  private static _instance: DiscordSingleton;

  private client: Client;
  private memory: Memory;
  private openrouter: OpenrouterAiProvider;

  private constructor() {
    super("DISCORD");
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

  private remember(message: Message, bot?: true) {
    this.memory.remember({
      userId: message.author.id,
      author: bot ? EMemoryAuthor.Bot : EMemoryAuthor.User,
      guild: message.guild?.id ?? null,
      importance: EMemoryImportance.Low,
      message: message.content,
    });
  }

  private async messageHandler(message: Message) {
    console.log(`<${message.author.username}> ${message.content}`);

    if (message.author.id === this.client.user?.id) {
      this.remember(message, true);
      return;
    }

    if (!this.client.user?.id) {
      return;
    }

    const memories = await this.memory.readFullMemory(message.author.id);

    const res = await this.openrouter.chatWithTools(
      {
        role: "user",
        content: [
          {
            type: "text",
            text: message.content,
          },
        ],
      },
      memories?.map((el) => {
        return {
          content: el.message,
          role: el.author === EMemoryAuthor.Bot ? "assistant" : "user",
        };
      }) || [],
      {
        id: message.author.id,
        username: message.author.username,
        displayName: message.author.displayName,
      },
    );

    if (!res) {
      return;
    }

    message.reply(res);

    this.remember(message);
  }

  private async onReady(c: Client<true>) {
    this.logger.info(`Logged in as ${c.user.tag}!`);
  }

  public setup() {
    this.client.once(Events.ClientReady, this.onReady.bind(this));
    this.client.on(Events.MessageCreate, this.messageHandler.bind(this));
    this.client.login(Bun.env.DISCORD_TOKEN);
  }
}
