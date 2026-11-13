import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";
import { AuthorizationService } from "../authorization";
import { ESubscriptionMode, EventBus, type TEventContext } from "../events";
import { EEventKind, EEventType, EVENT_KINDS } from "../events/catalog";

const DEAD_LETTER_NOTICE = "Something I was doing failed and was dropped. Try again.";
// a notice for these would loop
const NO_DEAD_LETTER_NOTICE: ReadonlySet<string> = new Set([
  EEventType.ReplyReady,
  EEventType.DeliveryReady,
  EEventType.NoticeReady,
  EEventType.EventDeadLettered,
]);
const SEventType = z.enum(EEventType);
const SSupervisorNotice = z.object({ type: z.literal("notice"), text: z.string() });

export class Notices {
  private static _instance: TOption<Notices>;
  private backoffMs = [1_000, 5_000];

  private constructor() {}

  public static get instance() {
    if (!Notices._instance) {
      Notices._instance = new Notices();
    }

    return Notices._instance;
  }

  public setup(): void {
    const bus = EventBus.instance;

    bus.subscribe({
      consumer: "notices",
      type: EEventType.McpAuthConnected,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.backoffMs,
      handler: (event, ctx) =>
        this.notify(ctx, event.payload.chatId, `Connected MCP profile ${event.payload.profileId}.`),
    });
    bus.subscribe({
      consumer: "notices",
      type: EEventType.AiAuthLoginNeeded,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.backoffMs,
      handler: (event, ctx) =>
        this.notifyAll(
          ctx,
          `AI login needed:\n${event.payload.problems.map((problem) => `- ${problem}`).join("\n")}`,
        ),
    });
    bus.subscribe({
      consumer: "notices",
      type: EEventType.AiAuthLoginCompleted,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.backoffMs,
      handler: (event, ctx) => {
        let text = `Connected ${event.payload.providerId}.`;

        if (event.payload.selected) {
          text = `Connected ${event.payload.providerId}. It is now this chat's AI provider.`;
        }

        return this.notify(ctx, event.payload.chatId, text);
      },
    });
    bus.subscribe({
      consumer: "notices",
      type: EEventType.AiAuthLoginFailed,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.backoffMs,
      handler: (event, ctx) =>
        this.notify(
          ctx,
          event.payload.chatId,
          `Login for ${event.payload.providerId} failed: ${event.payload.error}`,
        ),
    });
    bus.subscribe({
      consumer: "notices",
      type: EEventType.EventDeadLettered,
      mode: ESubscriptionMode.Durable,
      backoffMs: this.backoffMs,
      handler: async (event, ctx) => {
        const deadType = SEventType.safeParse(event.payload.eventType);

        // a command's requester reports the failure itself
        if (deadType.success && EVENT_KINDS[deadType.data] === EEventKind.Command) {
          return;
        }

        if (NO_DEAD_LETTER_NOTICE.has(event.payload.eventType)) {
          return;
        }

        const chatId = event.trace.chatId;

        // an event of no chat, such as a global one, goes to every authorized chat
        if (chatId === undefined) {
          await this.notifyAll(ctx, DEAD_LETTER_NOTICE);
          return;
        }

        // on the chat's lane, not on the dead event's scope or job lane
        await ctx.complete(async (_tx, emit) => {
          emit(EEventType.NoticeReady, { chatId, text: DEAD_LETTER_NOTICE }, undefined, chatId);
        });
      },
    });
  }

  // message: what the supervisor sent the app over its IPC channel
  public async handleSupervisorMessage(message: unknown): Promise<void> {
    const notice = SSupervisorNotice.safeParse(message);

    if (!notice.success) {
      return;
    }

    const chatIds = await AuthorizationService.instance.listAuthorizedChatIds();

    await EventBus.instance.transact(async (_tx, emit) => {
      for (const chatId of chatIds) {
        emit({
          type: EEventType.NoticeReady,
          source: "notices",
          key: chatId,
          trace: { turnId: `update:${crypto.randomUUID()}`, chatId, platform: undefined },
          payload: { chatId, text: notice.data.text },
          causationId: undefined,
          dedupeKey: undefined,
        });
      }
    });
  }

  private async notifyAll(ctx: TEventContext, text: string): Promise<void> {
    const chatIds = await AuthorizationService.instance.listAuthorizedChatIds();

    await ctx.complete(async (_tx, emit) => {
      for (const chatId of chatIds) {
        emit(EEventType.NoticeReady, { chatId, text }, chatId, chatId);
      }
    });
  }

  private async notify(ctx: TEventContext, chatId: string, text: string): Promise<void> {
    await ctx.complete(async (_tx, emit) => {
      emit(EEventType.NoticeReady, { chatId, text }, undefined, undefined);
    });
  }
}
