import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger } from "@bellaclaw/shared";
import { AgentHarness } from "../ai/agent-harness";
import { ERole } from "../ai/types";
import { logHandlerStarted, startHandlerSpan, startMemorySaveSpan } from "../app-logger/operations";
import { startSpan } from "../app-logger/span";
import { ConversationStore } from "../conversation";
import { IMAGE_MARKER, type TConversation } from "../conversation/types";
import type { TSelectMemory } from "../database/schema";
import { ESubscriptionMode, EventBus, type TEventContext, type TEventRequester } from "../events";
import { EEventType, type TEvent } from "../events/catalog";
import { MessagingAdapter } from "../messaging";
import type { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { EConfigKey, type TConfigRecord } from "../settings/schema";

const FAILED_REPLY = "Something went wrong.";
const INTERRUPTED_REPLY =
  "I was restarted while answering, so that reply is lost. Some actions may already be done. Check before asking again.";
const INTERRUPTED_NOTICE =
  "System notice, not from the user: the previous turn was interrupted by a restart. Its tool calls may be partly applied. The next assistant message says so.";
// one auth check per OAuth provider, each up to 30 s, then the provider switch
const DIAGNOSE_TIMEOUT_MS = 120_000;

export class MessageHandler {
  private static _instance: TOption<MessageHandler>;
  private logger = createLogger("MESSAGE_HANDLER");
  private ai = AgentHarness.instance;
  private conversations = ConversationStore.instance;

  private constructor() {}

  public static get instance() {
    if (!MessageHandler._instance) {
      MessageHandler._instance = new MessageHandler();
    }

    return MessageHandler._instance;
  }

  // NOTE: both subscriptions share the consumer, so one lane per chat orders turns, their
  // compaction and transcript appends
  public setup(): void {
    const bus = EventBus.instance;

    bus.subscribe({
      consumer: "conversation",
      type: EEventType.TurnRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: (event, ctx) => this.handleTurn(event, ctx),
    });
    bus.subscribe({
      consumer: "conversation",
      type: EEventType.MessageSent,
      mode: ESubscriptionMode.Durable,
      backoffMs: [1_000, 5_000, 30_000],
      handler: (event, ctx) => this.saveDeliveredMessage(event, ctx),
    });
  }

  private async saveDeliveredMessage(
    event: TEvent<EEventType.MessageSent>,
    ctx: TEventContext,
  ): Promise<void> {
    const transcript = event.payload.transcript;

    if (transcript === undefined) {
      return;
    }

    const span = startMemorySaveSpan(event.trace, ERole.Assistant, transcript.text.length);
    let failure: TOption<string>;
    try {
      await ctx.complete((tx) =>
        this.conversations.saveDeliveredMessage(
          tx,
          event.payload.chatId,
          transcript.text,
          transcript.notice,
          event.payload.sentAt,
        ),
      );
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      span.end(failure === undefined, {}, failure);
    }
  }

  private async handleTurn(
    event: TEvent<EEventType.TurnRequested>,
    ctx: TEventContext,
  ): Promise<void> {
    const { chatId, content, attachments, receivedAt, platform } = event.payload;
    const trace = event.trace;
    const handleMessageStart = performance.now();
    this.logger.info("handleTurn: start");
    logHandlerStarted(trace, "message-handler");
    const span = startHandlerSpan(trace, "message-handler");

    // an earlier attempt died mid-run; the model must not answer twice
    if ((await ctx.findCaused(EEventType.TurnStarted, undefined)) !== undefined) {
      this.logger.warning("handleTurn: interrupted turn found, not running it again");
      await ctx.complete(async (_tx, emit) => {
        emit(
          EEventType.ReplyReady,
          {
            chatId,
            text: INTERRUPTED_REPLY,
            transcript: { text: INTERRUPTED_REPLY, notice: INTERRUPTED_NOTICE },
          },
          undefined,
          undefined,
        );
        emit(EEventType.TurnFailed, { chatId, reason: "interrupted" }, undefined, undefined);
      });
      span.fail("interrupted", INTERRUPTED_REPLY.length);
      return;
    }

    const settings = await SettingsService.instance.getAll(chatId);
    let persisted: TOption<TConversation>;

    try {
      let conversation = await this.conversations.load(chatId);
      if (conversation !== undefined) {
        conversation = await this.compact(chatId, conversation, settings, platform, trace, ctx);
      }

      const storedText = [content, ...attachments.map(() => IMAGE_MARKER)]
        .filter((part) => part.length > 0)
        .join(" ");
      const saveSpan = startMemorySaveSpan(trace, ERole.User, storedText.length);
      let saveFailure: TOption<string>;
      let savedMessage: TSelectMemory;
      try {
        savedMessage = await ctx.transact(async (tx, emit) => {
          const row = await this.conversations.saveUserMessage(
            tx,
            chatId,
            ERole.User,
            storedText,
            new Date(receivedAt),
          );
          emit(EEventType.TurnStarted, { chatId, userMessageId: row.id }, undefined, undefined);
          return row;
        });
      } catch (error) {
        saveFailure = String(error);
        throw error;
      } finally {
        saveSpan.end(saveFailure === undefined, {}, saveFailure);
      }

      const chatStart = performance.now();
      const aiRes = await this.ai.runMain({
        prompt: content,
        conversation,
        images: {
          refs: attachments,
          fetch: (ref) => MessagingAdapter.instance.fetchAttachment(chatId, ref),
        },
        currentTimeContext: createCurrentTimeContext(settings, savedMessage.createdAt),
        chatId,
        settings,
        platform,
        trace,
        events: ctx,
        signal: undefined,
      });
      this.logger.info(
        `handleTurn: AI chat completed (${(performance.now() - chatStart).toFixed(0)}ms)`,
      );

      const text = aiRes.text;

      if (text === undefined) {
        this.logger.warning("handleTurn: AI returned no final response");
        let fallback = FAILED_REPLY;
        const diagnosed = await ctx.request(
          EEventType.AiAuthDiagnoseRequested,
          { chatId, providerId: settings[EConfigKey.AiProvider] },
          {
            outcome: EEventType.AiAuthDiagnosed,
            step: undefined,
            key: undefined,
            timeoutMs: DIAGNOSE_TIMEOUT_MS,
          },
        );

        if (diagnosed.payload.problem !== undefined) {
          fallback = diagnosed.payload.problem;
        }

        await ctx.complete(async (_tx, emit) => {
          emit(EEventType.ReplyReady, { chatId, text: fallback }, undefined, undefined);
          emit(
            EEventType.TurnFailed,
            { chatId, reason: "no_final_response" },
            undefined,
            undefined,
          );
        });
        span.fail("missing final response", fallback.length);
        return;
      }

      const turnSpan = startMemorySaveSpan(trace, ERole.Assistant, text.length);
      let turnFailure: TOption<string>;
      try {
        persisted = await ctx.complete(async (tx, emit) => {
          const state = await this.conversations.saveTurn(
            tx,
            chatId,
            aiRes.messages,
            savedMessage.id,
            conversation,
          );

          if (text.trim().length > 0) {
            emit(EEventType.ReplyReady, { chatId, text }, undefined, undefined);
          }

          emit(
            EEventType.TurnCompleted,
            { chatId, userMessageId: savedMessage.id },
            undefined,
            undefined,
          );
          return state;
        });
      } catch (error) {
        turnFailure = String(error);
        throw error;
      } finally {
        turnSpan.end(turnFailure === undefined, {}, turnFailure);
      }

      this.logger.info(
        `handleTurn: done (${(performance.now() - handleMessageStart).toFixed(0)}ms)`,
      );
      span.ok("completed", text.length);
    } catch (error) {
      this.logger.error(`handleTurn: failed: ${String(error)}`);
      await ctx.complete(async (_tx, emit) => {
        emit(EEventType.ReplyReady, { chatId, text: FAILED_REPLY }, "failed", undefined);
        emit(EEventType.TurnFailed, { chatId, reason: "error" }, undefined, undefined);
      });
      span.fail("failed", 0, String(error));
      return;
    }

    if (persisted === undefined) {
      return;
    }

    // acked; the chat lane is still held, so the next turn waits for compaction.
    // compact() reports its own failures
    await this.compact(chatId, persisted, settings, platform, trace, ctx);
  }

  private async compact(
    chatId: string,
    state: TConversation,
    settings: TConfigRecord,
    platform: TOption<EMessagePlatform>,
    trace: TBehaviorTraceContext,
    events: TEventRequester,
  ): Promise<TConversation> {
    const span = startSpan(trace, "conversation.compaction.completed", "message-handler");
    try {
      const result = await this.ai.compactConversation(
        state,
        settings,
        chatId,
        platform,
        trace,
        events,
      );
      if (result === undefined) {
        return state;
      }
      const unused = await this.conversations.saveSummary(chatId, result.state);
      for (const ref of unused) {
        try {
          await MessagingAdapter.instance.deleteAttachment(chatId, ref);
        } catch (error) {
          this.logger.warning(`Attachment delete failed: ${String(error)}`);
        }
      }
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
