import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { EEventType } from "@bellaclaw/database";
import { createLogger, SUpdateNotice, type TOption, UPDATER_NOTICES_DIR } from "@bellaclaw/shared";
import { z } from "zod";
import { AppChannel } from "../app";
import { AuthorizationService } from "../authorization";
import { ESubscriptionMode, EventBus, type TEventContext } from "../events";
import { EEventKind, EVENT_KINDS } from "../events/catalog";
import { IdentityService } from "../identity";

const DEAD_LETTER_NOTICE = "Something I was doing failed and was dropped. Try again.";
// a notice for these would loop
const NO_DEAD_LETTER_NOTICE: ReadonlySet<string> = new Set([
  EEventType.ReplyReady,
  EEventType.DeliveryReady,
  EEventType.NoticeReady,
  EEventType.MessageSent,
  EEventType.EventDeadLettered,
  // a push, which gives up without a dead letter unless the process dies on its last attempt
  EEventType.ConversationChanged,
]);
// the user's request succeeded before these consumers ran, so their failure has nothing to retry
const NO_DEAD_LETTER_NOTICE_CONSUMERS: ReadonlySet<string> = new Set(["conversation-title"]);
const SEventType = z.enum(EEventType);
const UPDATER_NOTICES_INTERVAL_MS = 2_000;

export class Notices {
  private static _instance: TOption<Notices>;
  private backoffMs = [1_000, 5_000];
  private logger = createLogger("NOTICES");

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
        this.notify(ctx, event.payload.chatId, `Connected connector ${event.payload.profileId}.`),
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

        if (
          NO_DEAD_LETTER_NOTICE.has(event.payload.eventType) ||
          NO_DEAD_LETTER_NOTICE_CONSUMERS.has(event.payload.consumer)
        ) {
          return;
        }

        const chatId = event.trace.chatId;

        // an event of no chat, such as a global one, goes to every recipient of a global notice
        if (chatId === undefined) {
          await this.notifyAll(ctx, DEAD_LETTER_NOTICE);
          return;
        }

        // on the conversation's lane, not on the dead event's scope or job lane
        await this.notify(ctx, chatId, DEAD_LETTER_NOTICE);
      },
    });
  }

  // directory: BELLACLAW_UPDATER_DIR; each pass starts 2 s after the previous one ends, so two
  // never overlap
  public watchUpdaterNotices(directory: string): void {
    const pass = async () => {
      try {
        await this.deliverUpdaterNotices(directory);
      } catch (error) {
        this.logger.error(`Failed to deliver the updater's notices: ${String(error)}`);
      }

      setTimeout(pass, UPDATER_NOTICES_INTERVAL_MS);
    };

    void pass();
  }

  // One pass over the updater's notice files, in name order. The dedupe key of each file's notice
  // keeps a crash between the emit and the delete from sending the line twice.
  public async deliverUpdaterNotices(directory: string): Promise<void> {
    const noticesDirectory = join(directory, UPDATER_NOTICES_DIR);

    await mkdir(noticesDirectory, { recursive: true });

    const fileNames = (await readdir(noticesDirectory))
      .filter((fileName) => fileName.endsWith(".json"))
      .sort();

    for (const fileName of fileNames) {
      const path = join(noticesDirectory, fileName);
      const text = await Bun.file(path).text();
      let raw: unknown;

      try {
        raw = JSON.parse(text);
      } catch {
        raw = undefined;
      }

      const notice = SUpdateNotice.safeParse(raw);

      if (!notice.success) {
        this.logger.warning(`Deleting the updater's unreadable notice ${fileName}`);
        await rm(path, { force: true });
        continue;
      }

      const chatId = await IdentityService.instance.conversationKeyOf(notice.data.chatId);

      await EventBus.instance.transact(async (_tx, emit) => {
        emit({
          type: EEventType.NoticeReady,
          source: "notices",
          key: chatId,
          trace: { turnId: `update:${crypto.randomUUID()}`, chatId, platform: undefined },
          payload: { chatId, text: notice.data.text },
          causationId: undefined,
          dedupeKey: `updater-notice:${fileName}`,
        });
      });
      await rm(path, { force: true });
    }
  }

  private async notifyAll(ctx: TEventContext, text: string): Promise<void> {
    const chatIds = await this.listGlobalRecipients();

    await ctx.complete(async (_tx, emit) => {
      for (const chatId of chatIds) {
        emit(EEventType.NoticeReady, { chatId, text }, chatId, chatId);
      }
    });
  }

  // Identity's recipients of a global notice, and the Bella conversation of every account with a
  // registered device, once
  private async listGlobalRecipients(): Promise<string[]> {
    const chatIds = await IdentityService.instance.listNoticeRecipients(
      await AuthorizationService.instance.listAuthorizedChatIds(),
    );

    for (const accountId of await AppChannel.instance.listDeviceAccounts()) {
      const { conversationKey } = await IdentityService.instance.account(accountId);

      if (!chatIds.includes(conversationKey)) {
        chatIds.push(conversationKey);
      }
    }

    return chatIds;
  }

  // recipient: an owner, conversation or address key; the notice goes to its conversation, on
  // that conversation's lane
  private async notify(ctx: TEventContext, recipient: string, text: string): Promise<void> {
    const chatId = await IdentityService.instance.conversationKeyOf(recipient);

    await ctx.complete(async (_tx, emit) => {
      emit(EEventType.NoticeReady, { chatId, text }, undefined, chatId);
    });
  }
}
