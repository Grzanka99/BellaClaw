import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { AsyncQueue, createLogger, type TLogger } from "@bellaclaw/shared";
import { AgentHarness } from "../ai/agent-harness";
import { describeAiAuthProblem } from "../ai/auth";
import { ERole, type THistoryItem } from "../ai/types";
import { logHandlerStarted, startHandlerSpan, startMemorySaveSpan } from "../app-logger/operations";
import { startSpan } from "../app-logger/span";
import { ConversationStore } from "../conversation";
import type { TConversation } from "../conversation/types";
import { Memory } from "../memory";
import { FactDistiller } from "../memory/distill";
import { EMemoryImportance, type TMemory } from "../memory/types";
import type { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { EConfigKey, type TConfigRecord } from "../settings/schema";
import type { TIncommingMessage } from "./types";

export class MessageHandler {
  private static _instances = new Map<string, MessageHandler>();
  private logger: TLogger;
  private ai = AgentHarness.instance;
  private queue = new AsyncQueue();
  private turnQueue = new AsyncQueue();
  private conversations = ConversationStore.instance;
  private memory = Memory.instance;
  private factDistiller = FactDistiller.instance;

  constructor(private chatId: string) {
    this.logger = createLogger(`AbstractMessageHandler (cid: ${chatId})`);
    this.logger.info("created abstract message handler");
    this.logger.info("handler is up");
  }

  public static getInstance(chatId: string): MessageHandler {
    const instance = MessageHandler._instances.get(chatId);

    if (instance) {
      return instance;
    }

    const newInstance = new MessageHandler(chatId);
    MessageHandler._instances.set(chatId, newInstance);

    return newInstance;
  }

  public async handleMessage(
    message: TIncommingMessage,
    trace: TBehaviorTraceContext,
    commands: string,
    platform?: EMessagePlatform,
  ): Promise<string> {
    return this.turnQueue.enqueue(() => this.handleTurn(message, trace, commands, platform));
  }

  public saveDeliveredMessage(
    text: string,
    platform: EMessagePlatform,
    deliveredAt: number,
  ): Promise<void> {
    // Append after the active turn and its compaction so a summary cannot skip this delivery.
    return this.turnQueue.enqueue(() =>
      this.queue.enqueue(() =>
        this.conversations.saveDeliveredMessage(this.chatId, platform, text, deliveredAt),
      ),
    );
  }

  private async handleTurn(
    message: TIncommingMessage,
    trace: TBehaviorTraceContext,
    commands: string,
    platform: TOption<EMessagePlatform>,
  ): Promise<string> {
    const handleMessageStart = performance.now();
    this.logger.info("handleMessage: start");
    logHandlerStarted(trace, "message-handler");
    const span = startHandlerSpan(trace, "message-handler");

    try {
      const settings = await SettingsService.instance.getAll(message.chatId);
      await this.queue.enqueue(async () => undefined);
      let conversation = await this.conversations.load(message.chatId, platform ?? "unknown");
      if (conversation !== undefined) {
        conversation = await this.compact(conversation, settings, commands, platform, trace);
      }
      let last30: TMemory[] = [];
      if (conversation === undefined) {
        last30 = await this.retrieveMemory(message.chatId, trace, platform);
      }

      const savedMessage = await this.queue.enqueue(() =>
        this.saveMessageToDatabase(message, trace, platform),
      );

      const history: THistoryItem[] = [];

      for (const el of last30.toReversed()) {
        let content = el.message;
        if (el.author === ERole.User) {
          content = `${createCurrentTimeContext(settings, el.createdAt)}\n\n${content}`;
        }
        history.push({
          role: el.author,
          content,
        });
      }

      const chatStart = performance.now();
      const aiRes = await this.ai.runMain({
        prompt: message.message.content,
        history,
        conversation,
        currentTimeContext: createCurrentTimeContext(settings, savedMessage.createdAt),
        chatId: message.chatId,
        settings,
        commands,
        platform,
        trace,
        signal: undefined,
      });
      this.logger.info(
        `handleMessage: AI chat completed (${(performance.now() - chatStart).toFixed(0)}ms)`,
      );

      if (aiRes.text === undefined) {
        this.logger.warning("handleMessage: AI returned no final response");
        let reply = "Something went wrong.";
        const authProblem = await describeAiAuthProblem(
          message.chatId,
          settings[EConfigKey.AiProvider],
        );

        if (authProblem !== undefined) {
          reply = authProblem;
        }

        span.fail("missing final response", reply.length);
        return reply;
      }

      const saveSpan = startMemorySaveSpan(
        trace,
        ERole.Assistant,
        EMemoryImportance.Medium,
        aiRes.text.length,
      );
      let persisted: TConversation;
      let saveError: TOption<string>;
      try {
        persisted = await this.conversations.saveTurn(
          message.chatId,
          platform ?? "unknown",
          aiRes.messages,
          savedMessage.id,
          conversation,
          last30
            .toReversed()
            .filter((item) => item.author !== ERole.System)
            .map((item) => item.id),
        );
      } catch (error) {
        saveError = String(error);
        throw error;
      } finally {
        saveSpan.end(saveError === undefined, {}, saveError);
      }

      const finalResponse = aiRes.text;

      void this.factDistiller
        .enqueueFactDrain(message.chatId, settings, trace)
        .catch((error) => this.logger.error(`handleMessage: fact drain failed: ${String(error)}`));
      void this.queue
        .enqueue(async () => {
          await this.compact(persisted, settings, commands, platform, trace);
        })
        .catch((error) => this.logger.error(`handleMessage: compaction failed: ${String(error)}`));

      this.logger.info(
        `handleMessage: done (${(performance.now() - handleMessageStart).toFixed(0)}ms)`,
      );
      span.ok("completed", finalResponse.length);
      return finalResponse;
    } catch (error) {
      span.fail("failed", 0, String(error));
      throw error;
    }
  }

  private async compact(
    state: TConversation,
    settings: TConfigRecord,
    commands: string,
    platform: TOption<EMessagePlatform>,
    trace: TBehaviorTraceContext,
  ): Promise<TConversation> {
    const span = startSpan(trace, "conversation.compaction.completed", "message-handler");
    try {
      const result = await this.ai.compactConversation(
        state,
        settings,
        this.chatId,
        platform,
        commands,
        trace,
      );
      if (result === undefined) {
        return state;
      }
      await this.conversations.saveSummary(this.chatId, platform ?? "unknown", result.state);
      span.ok({
        summary: "Conversation compacted",
        metadata: {
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          ...result.usage,
        },
      });
      return result.state;
    } catch (error) {
      this.logger.error(`Conversation compaction failed: ${String(error)}`);
      span.fail(String(error), {
        event: "conversation.compaction.failed",
        summary: "Kept original conversation; retry next turn",
      });
      return state;
    }
  }

  private async saveMessageToDatabase(
    message: TIncommingMessage,
    trace: TBehaviorTraceContext,
    platform: TOption<EMessagePlatform>,
  ): Promise<TMemory> {
    const span = startMemorySaveSpan(
      trace,
      message.author.type,
      EMemoryImportance.Medium,
      message.message.content.length,
    );
    let failure: TOption<string>;
    try {
      return await this.memory.save({
        chatId: message.chatId,
        platform,
        author: message.author.type,
        importance: EMemoryImportance.Medium,
        message: message.message.content,
        createdAt: message.receivedAt,
      });
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      span.end(failure === undefined, {}, failure);
    }
  }

  private async retrieveMemory(
    chatId: string,
    trace: TBehaviorTraceContext,
    platform: TOption<EMessagePlatform>,
  ): Promise<TMemory[]> {
    const span = startSpan(trace, "memory.recent.completed", "memory");

    try {
      const memories = await this.memory.findRecent(chatId, 30, platform);
      span.ok({
        summary: `recent memory completed count=${memories.length} limit=30`,
        metadata: { count: memories.length, limit: 30 },
      });
      return memories;
    } catch (error) {
      this.logger.error(`retrieveMemory: failed to retrieve recent memory: ${String(error)}`);
      span.fail(String(error), {
        summary: "recent memory completed count=0 limit=30",
        metadata: { count: 0, limit: 30 },
      });
      return [];
    }
  }
}

function createCurrentTimeContext(settings: TConfigRecord, now: Date) {
  const timezone = settings[EConfigKey.AiInstructionsTimezone];

  return [
    "Message received at:",
    `UTC: ${now.toISOString()}`,
    `Timezone: ${timezone}`,
    `Local: ${now.toLocaleString("sv-SE-u-nu-latn", {
      timeZone: timezone,
      hourCycle: "h23",
    })}`,
    `Weekday: ${now.toLocaleString("en-US-u-nu-latn", {
      timeZone: timezone,
      weekday: "long",
    })}`,
  ].join("\n");
}
