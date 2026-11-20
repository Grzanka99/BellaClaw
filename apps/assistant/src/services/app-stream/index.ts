import { EEventType } from "@bellaclaw/database";
import type { TGatewayStreamEvent, TOption } from "@bellaclaw/shared";
import { ESubscriptionMode, EventBus } from "../events";
import { IdentityService } from "../identity";
import { EMessagePlatform } from "../messaging/types";

type TAppStreamListener = (event: TGatewayStreamEvent) => void;

// NOTE: the app's live stream: nudges, typing and confidential replies for the edge, which fans
// them out per account. Live only: a stream that was not open misses nothing it can get back,
// because the app compares revisions on every connect and a confidential reply is never stored.
// Only account conversations reach it
export class AppStream {
  private static _instance: TOption<AppStream>;
  // the open streams of the edge
  private listeners = new Set<TAppStreamListener>();

  private constructor() {}

  public static get instance() {
    if (!AppStream._instance) {
      AppStream._instance = new AppStream();
    }

    return AppStream._instance;
  }

  // NOTE: the conversation and turn handlers send without awaiting, so on one conversation's lane
  // the stream follows log order: typing on (requested), typing on (started), the user's row,
  // typing off, the reply
  public setup(): void {
    const bus = EventBus.instance;

    bus.subscribe({
      consumer: "app-stream",
      type: EEventType.ConversationChanged,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        const { conversationKey, ownerKey, revision, rewriteRevision } = event.payload;
        this.send(ownerKey, (accountId) => ({
          type: "changed",
          accountId,
          conversationKey,
          revision,
          rewriteRevision,
        }));
      },
    });

    // a deleted plain chat: open clients drop it; one that was not open finds it gone from the list
    bus.subscribe({
      consumer: "app-stream",
      type: EEventType.ConversationDeleted,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        const { conversationKey, ownerKey } = event.payload;
        this.send(ownerKey, (accountId) => ({ type: "deleted", accountId, conversationKey }));
      },
    });

    // a confidential reply to a message sent from the app is shown once and never stored; one ready
    // while no app stream is open is lost
    bus.subscribe({
      consumer: "app-stream",
      type: EEventType.ReplyReady,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        const { conversationKey, ownerKey, channel, text, confidential } = event.payload;

        if (confidential !== true || channel !== EMessagePlatform.App) {
          return;
        }

        this.send(ownerKey, (accountId) => ({ type: "reply", accountId, conversationKey, text }));
      },
    });

    const turnTypingEvents: [
      (
        | EEventType.TurnRequested
        | EEventType.TurnStarted
        | EEventType.TurnCompleted
        | EEventType.TurnFailed
      ),
      boolean,
    ][] = [
      [EEventType.TurnRequested, true],
      [EEventType.TurnStarted, true],
      [EEventType.TurnCompleted, false],
      [EEventType.TurnFailed, false],
    ];

    // a turn runs in the account's conversation whatever channel its message came from. Typing
    // also turns on when the turn starts: a turn queued behind another runs after that one's
    // typing off, and a turn forwarded during a link was requested under the address's owner
    for (const [type, typing] of turnTypingEvents) {
      bus.subscribe({
        consumer: "app-stream",
        type,
        mode: ESubscriptionMode.Live,
        backoffMs: [],
        handler: async (event) => {
          this.typing(event.payload.ownerKey, event.payload.conversationKey, typing);
        },
      });
    }

    // a dead turn request must not leave typing on; its dead letter names only its chat. Other
    // dead letters say nothing about typing: a later turn of the chat may be running
    bus.subscribe({
      consumer: "app-stream",
      type: EEventType.EventDeadLettered,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        if (
          event.payload.eventType !== EEventType.TurnRequested ||
          event.trace.chatId === undefined
        ) {
          return;
        }

        const resolved = await IdentityService.instance.resolve(event.trace.chatId);

        if (resolved !== undefined) {
          this.typing(resolved.ownerKey, resolved.conversationKey, false);
        }
      },
    });
  }

  // listener: called for every event while the stream is open. Returns what closes it
  public listen(listener: TAppStreamListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private typing(ownerKey: string, conversationKey: string, typing: boolean): void {
    this.send(ownerKey, (accountId) => ({ type: "typing", accountId, conversationKey, typing }));
  }

  // sends to the listeners only for an account's owner key
  private send(ownerKey: string, createEvent: (accountId: string) => TGatewayStreamEvent): void {
    const accountId = IdentityService.instance.accountIdOf(ownerKey);

    if (accountId === undefined) {
      return;
    }

    const event = createEvent(accountId);

    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
