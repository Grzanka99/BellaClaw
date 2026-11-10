import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { AsyncQueue, createLogger, type TLogger } from "@bellaclaw/shared";
import { AgentHarness } from "../ai/agent-harness";
import { describeAiAuthProblem } from "../ai/auth";
import { ERole } from "../ai/types";
import { logHandlerStarted, startHandlerSpan, startMemorySaveSpan } from "../app-logger/operations";
import { startSpan } from "../app-logger/span";
import { ConversationStore } from "../conversation";
import type { TConversation } from "../conversation/types";
import type { TSelectMemory } from "../database/schema";
import { FactDistiller } from "../memory/distill";
import type { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { EConfigKey, type TConfigRecord } from "../settings/schema";
import type { TIncommingMessage } from "./types";

export class MessageHandler {
  private static _instances = new Map<string, MessageHandler>();
  private logger: TLogger;
  private ai = AgentHarness.instance;
  private turnQueue = new AsyncQueue();
  private conversations = ConversationStore.instance;
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
    platform?: EMessagePlatform,
  ): Promise<string> {
    // The turn task settles the reply first, then runs post-turn work, so the caller never waits
    // for compaction while the next turn of this chat still starts only after it.
    const reply = Promise.withResolvers<string>();
    void this.turnQueue
      .enqueue(() => this.handleTurn(message, trace, platform, reply))
      .catch((error) => reply.reject(error));
    return reply.promise;
  }

  public saveDeliveredMessage(text: string, notice: string, deliveredAt: number): Promise<void> {
    // Append after the active turn and its compaction so a summary cannot skip this delivery.
    return this.turnQueue.enqueue(() =>
      this.conversations.saveDeliveredMessage(this.chatId, text, notice, deliveredAt),
    );
  }

  private async handleTurn(
    message: TIncommingMessage,
    trace: TBehaviorTraceContext,
    platform: TOption<EMessagePlatform>,
    reply: PromiseWithResolvers<string>,
  ): Promise<void> {
    const handleMessageStart = performance.now();
    this.logger.info("handleMessage: start");
    logHandlerStarted(trace, "message-handler");
    const span = startHandlerSpan(trace, "message-handler");

    try {
      const settings = await SettingsService.instance.getAll(message.chatId);
      let conversation = await this.conversations.load(message.chatId);
      if (conversation !== undefined) {
        conversation = await this.compact(conversation, settings, platform, trace);
      }

      const savedMessage = await this.saveMessageToDatabase(message, trace);

      const chatStart = performance.now();
      const aiRes = await this.ai.runMain({
        prompt: message.message.content,
        conversation,
        currentTimeContext: createCurrentTimeContext(settings, savedMessage.createdAt),
        chatId: message.chatId,
        settings,
        platform,
        trace,
        signal: undefined,
      });
      this.logger.info(
        `handleMessage: AI chat completed (${(performance.now() - chatStart).toFixed(0)}ms)`,
      );

      if (aiRes.text === undefined) {
        this.logger.warning("handleMessage: AI returned no final response");
        let fallback = "Something went wrong.";
        const authProblem = await describeAiAuthProblem(
          message.chatId,
          settings[EConfigKey.AiProvider],
        );

        if (authProblem !== undefined) {
          fallback = authProblem;
        }

        span.fail("missing final response", fallback.length);
        reply.resolve(fallback);
        return;
      }

      const saveSpan = startMemorySaveSpan(trace, ERole.Assistant, aiRes.text.length);
      let persisted: TConversation;
      let saveError: TOption<string>;
      try {
        persisted = await this.conversations.saveTurn(
          message.chatId,
          aiRes.messages,
          savedMessage.id,
          conversation,
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

      this.logger.info(
        `handleMessage: done (${(performance.now() - handleMessageStart).toFixed(0)}ms)`,
      );
      span.ok("completed", finalResponse.length);
      reply.resolve(finalResponse);

      // Post-turn work runs after the reply is settled; compact() reports its own failures
      await this.compact(persisted, settings, platform, trace);
    } catch (error) {
      span.fail("failed", 0, String(error));
      reply.reject(error);
    }
  }

  private async compact(
    state: TConversation,
    settings: TConfigRecord,
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
        trace,
      );
      if (result === undefined) {
        return state;
      }
      await this.conversations.saveSummary(this.chatId, result.state);
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
  ): Promise<TSelectMemory> {
    const span = startMemorySaveSpan(trace, message.author.type, message.message.content.length);
    let failure: TOption<string>;
    try {
      return await this.conversations.saveUserMessage(
        message.chatId,
        message.author.type,
        message.message.content,
        message.receivedAt,
      );
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      span.end(failure === undefined, {}, failure);
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
