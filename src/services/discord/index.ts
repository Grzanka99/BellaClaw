import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import { Logger } from "../../utils/logger";
import { OpenrouterAiProvider } from "../ai-providers/openrouter";
import { Memory } from "../memory";
import { EMemoryAuthor, EMemoryImportance } from "../memory/types";

class DiscordSingleton extends Logger {
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
      return;
    }

    const res = await this.openrouter.chat(
      {
        role: "user",
        content: [
          {
            type: "text",
            text: message.content,
          },
        ],
      },
      [],
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

const discord = DiscordSingleton.instance;

discord.setup();
