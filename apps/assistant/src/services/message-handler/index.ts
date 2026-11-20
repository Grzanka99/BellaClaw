import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import { EEventType, type TSelectMemory } from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { createLogger } from "@bellaclaw/shared";
import { AgentHarness } from "../ai/agent-harness";
import { ERole } from "../ai/types";
import { logHandlerStarted, startHandlerSpan, startMemorySaveSpan } from "../app-logger/operations";
import { startSpan } from "../app-logger/span";
import { ConversationStore } from "../conversation";
import { IMAGE_MARKER, type TConversation } from "../conversation/types";
import { ESubscriptionMode, EventBus, type TEventContext, type TEventRequester } from "../events";
import { ERejectionCode, type TEvent, type TMessageOrigin } from "../events/catalog";
import { IdentityService } from "../identity";
import { EIdentityLinkOwner } from "../identity/schema";
import { MessagingAdapter } from "../messaging";
import { SettingsService } from "../settings";
import { EConfigKey, type TConfigRecord } from "../settings/schema";

const FAILED_REPLY = "Something went wrong.";
const INTERRUPTED_REPLY =
  "I was restarted while answering, so that reply is lost. Some actions may already be done. Check before asking again.";
const INTERRUPTED_NOTICE =
  "System notice, not from the user: the previous turn was interrupted by a restart. Its tool calls may be partly applied. The next assistant message says so.";
// the lane prefix of an address's turns held while its account is being linked
const LINK_HOLD_PREFIX = "link-hold|";
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

  // NOTE: the subscriptions share the consumer, so one lane per chat orders turns, their
  // compaction, transcript appends and message deletes
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
    // NOTE: the barrier of a link. It passes the address's lane, behind the address's running or
    // queued turn, then the account's Bella conversation's lane, behind that side's running turn,
    // and only then lets the owners move, on the address's lanes
    bus.subscribe({
      consumer: "conversation",
      type: EEventType.IdentityLinkStarted,
      mode: ESubscriptionMode.Durable,
      backoffMs: [1_000, 5_000],
      handler: async (event, ctx) => {
        await ctx.complete(async (_tx, emit) => {
          emit(
            EEventType.IdentityLinkSettled,
            { ...event.payload, owner: EIdentityLinkOwner.Conversation },
            undefined,
            event.payload.conversationKey,
          );
        });
      },
    });
    bus.subscribe({
      consumer: "conversation",
      type: EEventType.IdentityLinkSettled,
      mode: ESubscriptionMode.Durable,
      backoffMs: [1_000, 5_000],
      handler: async (event, ctx) => {
        const { owner, ...keys } = event.payload;

        if (owner !== EIdentityLinkOwner.Conversation) {
          return;
        }

        await ctx.complete(async (_tx, emit) => {
          emit(EEventType.IdentityLinkQuiet, keys, undefined, keys.chatKey);
        });
      },
    });
    // NOTE: Conversation's move follows Memory's, on the Bella conversation's lane, so a message of
    // the address forwarded there is stored before or after the move, never across it. A failed
    // fusion fails the handler, so the move waits for its retry
    bus.subscribe({
      consumer: "conversation",
      type: EEventType.IdentityLinkMoved,
      mode: ESubscriptionMode.Durable,
      backoffMs: [1_000, 5_000, 30_000],
      handler: async (event, ctx) => {
        if (event.payload.owner === EIdentityLinkOwner.Memory) {
          await this.moveToBella(event, ctx);
        }
      },
    });
    bus.subscribe({
      consumer: "conversation",
      type: EEventType.ConversationMessageDeleteRequested,
      mode: ESubscriptionMode.Durable,
      backoffMs: [],
      handler: async (event, ctx) => {
        const { chatId, messageId } = event.payload;

        await ctx.complete(async (tx, emit) => {
          const messageIds = await this.conversations.deleteMessage(tx, chatId, messageId);

          if (messageIds === undefined) {
            emit(
              EEventType.CommandRejected,
              {
                commandType: event.type,
                code: ERejectionCode.Invalid,
                message: "No such user or assistant message in this chat",
              },
              undefined,
              undefined,
            );
            return;
          }

          emit(EEventType.ConversationMessageDeleted, { chatId, messageIds }, undefined, undefined);
        });
      },
    });
  }

  // NOTE: the two summaries are fused into one before the rows mix, when both chats have a
  // summary or a row of either chat would otherwise be skipped or replayed. The fusion is a model
  // call, so its result is saved as a checkpoint fact before it is applied, and a redelivery
  // applies that instead of calling the model again
  // NOTE: accepted risk: the fusion is one request to the account's main model and, when that
  // fails, one to the provider's default main model, so an input above both context windows
  // fails on every retry
  private async moveToBella(
    event: TEvent<EEventType.IdentityLinkMoved>,
    ctx: TEventContext,
  ): Promise<void> {
    const { chatKey, conversationKey, ownerKey, channel } = event.payload;
    let fused = (await ctx.findCaused(EEventType.ConversationSummariesFused, undefined))?.payload;

    if (fused === undefined) {
      const fusion = await this.conversations.loadFusion(chatKey, conversationKey);

      if (fusion.summaries > 1 || fusion.state.entries.length > 0) {
        const settings = await SettingsService.instance.getAll(ownerKey);
        const result = await this.ai.compactConversation(
          fusion.state,
          settings,
          conversationKey,
          ownerKey,
          channel,
          event.trace,
          ctx,
          true,
        );

        if (result === undefined) {
          throw new Error("The fusion of the two summaries returned no summary");
        }

        const summary = {
          chatKey,
          conversationKey,
          summary: result.state.summary,
          summarizedThroughId: fusion.state.summarizedThroughId,
          summaryTimestamp: result.state.summaryTimestamp,
        };
        await ctx.transact(async (_tx, emit) => {
          emit(EEventType.ConversationSummariesFused, summary, undefined, undefined);
        });
        fused = summary;
      }
    }

    await ctx.complete(async (tx, emit) => {
      await this.conversations.moveToBella(tx, chatKey, conversationKey, ownerKey, fused);
      emit(
        EEventType.IdentityLinkMoved,
        { ...event.payload, owner: EIdentityLinkOwner.Conversation },
        undefined,
        chatKey,
      );
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

    // NOTE: a message for an address that is linked or being linked belongs to the account's Bella
    // conversation. It is stored on that conversation's lane, which also moves the address's rows:
    // under the address while its rows wait there to be moved, in the conversation after
    const account = await IdentityService.instance.linkedAccount(event.payload.chatId);
    let lane = event.payload.chatId;
    let chatId = lane;

    if (account !== undefined) {
      lane = account.conversationKey;
      chatId = account.conversationKey;

      if (event.key === lane && (await this.conversations.holds(event.payload.chatId))) {
        chatId = event.payload.chatId;
      }
    }

    // written on its conversation's lane only, so the row orders with that conversation's turns;
    // the forward and the ack commit together, and the emit's dedupe key keeps a redelivery
    // from forwarding twice
    if (lane !== event.key) {
      await ctx.complete(async (_tx, emit) => {
        emit(EEventType.MessageSent, event.payload, undefined, lane);
      });
      return;
    }

    const span = startMemorySaveSpan(event.trace, ERole.Assistant, transcript.text.length);
    let failure: TOption<string>;
    try {
      await ctx.complete((tx) =>
        this.conversations.saveDeliveredMessage(
          tx,
          chatId,
          event.payload.channel,
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
    const { content, attachments, receivedAt, ...requested } = event.payload;
    let origin: TMessageOrigin = requested;
    const trace = event.trace;
    const handleMessageStart = performance.now();
    this.logger.info("handleTurn: start");
    logHandlerStarted(trace, "message-handler");
    const span = startHandlerSpan(trace, "message-handler");

    // NOTE: a turn of an address that is linked or being linked waits on a hold lane of its own
    // until no link of the address's account is being made, then runs on the account's lane, in
    // the account's Bella conversation, with the account's keys. The address's and the account's
    // lanes stay free for the link's barrier and moves; the bound counts from the hold
    const account = await IdentityService.instance.linkedAccount(requested.conversationKey);

    if (account !== undefined && event.key === account.conversationKey) {
      origin = { ...requested, ...account };
    }

    // an earlier attempt died mid-run; the model must not answer twice
    if ((await ctx.findCaused(EEventType.TurnStarted, undefined)) !== undefined) {
      this.logger.warning("handleTurn: interrupted turn found, not running it again");
      await ctx.complete(async (_tx, emit) => {
        emit(
          EEventType.ReplyReady,
          {
            ...origin,
            text: INTERRUPTED_REPLY,
            transcript: { text: INTERRUPTED_REPLY, notice: INTERRUPTED_NOTICE },
          },
          undefined,
          undefined,
        );
        emit(EEventType.TurnFailed, { ...origin, reason: "interrupted" }, undefined, undefined);
      });
      span.fail("interrupted", INTERRUPTED_REPLY.length);
      return;
    }

    if (account !== undefined && event.key !== account.conversationKey) {
      const holdKey = `${LINK_HOLD_PREFIX}${requested.conversationKey}`;
      let lane = holdKey;

      if (event.key === holdKey) {
        if (
          !(await IdentityService.instance.waitWhileLinking(
            requested.conversationKey,
            event.occurredAt,
          ))
        ) {
          span.fail("link hold expired", 0);
          throw new Error("The link of this address did not complete in time");
        }

        lane = account.conversationKey;
      }

      await ctx.complete(async (_tx, emit) => {
        emit(EEventType.TurnRequested, event.payload, undefined, lane);
      });
      span.ok("forwarded", 0);
      return;
    }

    const { conversationKey, ownerKey, channel } = origin;
    const settings = await SettingsService.instance.getAll(ownerKey);
    let persisted: TOption<TConversation>;

    try {
      let conversation = await this.conversations.load(conversationKey);
      if (conversation !== undefined) {
        conversation = await this.compact(origin, conversation, settings, trace, ctx);
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
            conversationKey,
            channel,
            ERole.User,
            storedText,
            new Date(receivedAt),
          );
          emit(EEventType.TurnStarted, { ...origin, userMessageId: row.id }, undefined, undefined);
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
          fetch: (ref, maxBytes) => MessagingAdapter.instance.fetchAttachment(ref, maxBytes),
        },
        currentTimeContext: createCurrentTimeContext(settings, savedMessage.createdAt),
        conversationKey,
        ownerKey,
        settings,
        platform: channel,
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
          { chatId: ownerKey, providerId: settings[EConfigKey.AiProvider] },
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
          emit(EEventType.ReplyReady, { ...origin, text: fallback }, undefined, undefined);
          emit(
            EEventType.TurnFailed,
            { ...origin, reason: "no_final_response" },
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
            conversationKey,
            channel,
            aiRes.messages,
            savedMessage.id,
            conversation,
          );

          if (text.trim().length > 0) {
            emit(EEventType.ReplyReady, { ...origin, text }, undefined, undefined);
          }

          emit(
            EEventType.TurnCompleted,
            { ...origin, userMessageId: savedMessage.id },
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
        emit(EEventType.ReplyReady, { ...origin, text: FAILED_REPLY }, "failed", undefined);
        emit(EEventType.TurnFailed, { ...origin, reason: "error" }, undefined, undefined);
      });
      span.fail("failed", 0, String(error));
      return;
    }

    if (persisted === undefined) {
      return;
    }

    // acked; the chat lane is still held, so the next turn waits for compaction.
    // compact() reports its own failures
    await this.compact(origin, persisted, settings, trace, ctx);
  }

  private async compact(
    origin: TMessageOrigin,
    state: TConversation,
    settings: TConfigRecord,
    trace: TBehaviorTraceContext,
    events: TEventRequester,
  ): Promise<TConversation> {
    const span = startSpan(trace, "conversation.compaction.completed", "message-handler");
    try {
      const result = await this.ai.compactConversation(
        state,
        settings,
        origin.conversationKey,
        origin.ownerKey,
        origin.channel,
        trace,
        events,
        false,
      );
      if (result === undefined) {
        return state;
      }
      const unused = await this.conversations.saveSummary(origin.conversationKey, result.state);
      for (const ref of unused) {
        try {
          await MessagingAdapter.instance.deleteAttachment(ref);
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
