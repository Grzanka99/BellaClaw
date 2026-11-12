import type { TOption } from "@bellaclaw/shared";
import { AuthorizationService } from "../authorization";
import { ESubscriptionMode, EventBus, type TEventContext } from "../events";
import { EEventType } from "../events/catalog";

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
      handler: async (event, ctx) => {
        const text = `AI login needed:\n${event.payload.problems.map((problem) => `- ${problem}`).join("\n")}`;
        const chatIds = await AuthorizationService.instance.listAuthorizedChatIds();

        await ctx.complete(async (_tx, emit) => {
          for (const chatId of chatIds) {
            emit(EEventType.NoticeReady, { chatId, text }, chatId, chatId);
          }
        });
      },
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
  }

  private async notify(ctx: TEventContext, chatId: string, text: string): Promise<void> {
    await ctx.complete(async (_tx, emit) => {
      emit(EEventType.NoticeReady, { chatId, text }, undefined, undefined);
    });
  }
}
