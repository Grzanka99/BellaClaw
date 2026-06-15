import { generateReminderText } from "../../handlers/generate-reminder-text";
import type { TCronEngineJobContext } from "../../lib/cron-engine";
import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";
import { AiConnector } from "../ai/api";
import { ERole } from "../ai/types";
import { CronSingleton } from "../cron";
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { MessageHandler } from "../message-handler";
import { createCanonicalChatKey, parseCanonicalChatKey } from "./chat-key";
import { MessagingDataMigration } from "./migration";
import type { EMessagePlatform, TMessageTransport, TPlatformMessage } from "./types";

export class MessagingAdapter {
  private static _instance: TOption<MessagingAdapter>;
  private logger: TLogger = createLogger("MESSAGING");
  private transports = new Map<EMessagePlatform, TMessageTransport>();
  private ai = AiConnector.instance;
  private cronListenerRegistered = false;
  private migration = new MessagingDataMigration();
  private migrationPromise: TOption<Promise<void>>;

  private constructor() {}

  public static get instance() {
    if (!MessagingAdapter._instance) {
      MessagingAdapter._instance = new MessagingAdapter();
    }

    return MessagingAdapter._instance;
  }

  public registerTransport(transport: TMessageTransport) {
    this.transports.set(transport.platform, transport);
    this.ensureCronListener();
  }

  public async setup() {
    this.ensureCronListener();
    CronSingleton.instance.setup();
  }

  public async migrateData() {
    if (this.migrationPromise !== undefined) {
      return this.migrationPromise;
    }

    this.migrationPromise = this.migration.migrateRawDiscordScopes();
    return this.migrationPromise;
  }

  public async handleInboundMessage(message: TPlatformMessage) {
    const transport = this.transports.get(message.platform);
    if (transport === undefined) {
      this.logger.error(`handleInboundMessage: no transport for platform ${message.platform}`);
      return;
    }

    const canonicalChatId = createCanonicalChatKey(message.platform, message.chatId);
    const messageHandler = MessageHandler.getInstance(canonicalChatId);
    const reply = await messageHandler.handleMessage({
      chatId: canonicalChatId,
      author: {
        type: ERole.User,
        username: message.author.username,
        id: message.author.id,
      },
      message: message.message,
    });

    if (reply.trim().length === 0) {
      return;
    }

    try {
      await transport.sendText(message.chatId, reply);
    } catch (error) {
      this.logger.error(
        `handleInboundMessage: failed to send message to ${message.platform} chat ${message.chatId}: ${String(error)}`,
      );
    }
  }

  private ensureCronListener() {
    if (this.cronListenerRegistered) {
      return;
    }

    CronSingleton.instance.onCronEvent(this.handleCronFire.bind(this));
    this.cronListenerRegistered = true;
  }

  private async handleCronFire(ctx: TCronEngineJobContext) {
    const canonicalChatId = ctx.scope;
    if (canonicalChatId === undefined) {
      this.logger.warning(`handleCronFire: job "${ctx.name}" has no scope, skipping delivery`);
      return;
    }

    const parsedScope = parseCanonicalChatKey(canonicalChatId);
    if (parsedScope === undefined) {
      this.logger.warning(
        `handleCronFire: job "${ctx.name}" has invalid scope "${canonicalChatId}", skipping delivery`,
      );
      return;
    }

    const transport = this.transports.get(parsedScope.platform);
    if (transport === undefined) {
      this.logger.warning(
        `handleCronFire: no ${parsedScope.platform} transport for reminder "${ctx.name}", skipping delivery`,
      );
      return;
    }

    const text = await generateReminderText(ctx, this.ai);
    if (text === undefined) {
      this.logger.info(`handleCronFire: job "${ctx.name}" has no reminder text, skipping delivery`);
      return;
    }

    try {
      await transport.sendText(parsedScope.chatId, text);
    } catch (error) {
      this.logger.error(
        `handleCronFire: failed to deliver reminder "${ctx.name}" to ${parsedScope.platform} chat ${parsedScope.chatId}: ${String(error)}`,
      );
      return;
    }

    try {
      const saveResult = await Memory.instance.save({
        chatId: canonicalChatId,
        author: ERole.Assistant,
        importance: EMemoryImportance.Low,
        message: `[CRON REMINDER ${ctx.name}]: ${text}`,
      });

      if ("operation" in saveResult) {
        this.logger.error(
          `handleCronFire: failed to save reminder "${ctx.name}" to memory for chat ${canonicalChatId}: ${String(saveResult.error)}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `handleCronFire: failed to save reminder "${ctx.name}" to memory for chat ${canonicalChatId}: ${String(error)}`,
      );
    }
  }
}
