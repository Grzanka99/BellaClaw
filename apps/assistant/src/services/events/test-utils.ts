import { EConversationKind, EEventType } from "@bellaclaw/database";
import { EMessagePlatform } from "../messaging/types";
import { ESubscriptionMode, EventBus, type TEventContext, type TEventRequester } from "./index";

let requesters = 0;

// runs work inside a live handler of the current bus, as a tool or a scheduled run would
export async function withEventContext<R>(work: (ctx: TEventContext) => Promise<R>): Promise<R> {
  const bus = EventBus.instance;
  requesters += 1;
  const consumer = `test-requester-${requesters}`;
  const result = Promise.withResolvers<R>();

  bus.subscribe({
    consumer,
    type: EEventType.TestNoted,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event, ctx) => {
      if (event.source !== consumer) {
        return;
      }

      try {
        result.resolve(await work(ctx));
      } catch (error) {
        result.reject(error);
      }
    },
  });
  await bus.publish({
    type: EEventType.TestNoted,
    source: consumer,
    key: consumer,
    trace: { turnId: `test:${consumer}`, chatId: undefined, platform: undefined },
    payload: { text: consumer, count: 0 },
    causationId: undefined,
    dedupeKey: undefined,
  });

  return result.promise;
}

// a tool context's events, backed by the current bus
export const testEventRequester: TEventRequester = {
  request: (type, payload, options) =>
    withEventContext((ctx) => ctx.request(type, payload, options)),
  waitFor: (causationId, type, timeoutMs) =>
    withEventContext((ctx) => ctx.waitFor(causationId, type, timeoutMs)),
};

// the address of a received message: the chat key is the conversation and the owner
export function testMessageAddress(chatId: string, channel: EMessagePlatform) {
  return {
    conversationKey: chatId,
    ownerKey: chatId,
    channel,
    replyAddress: chatId.slice(chatId.indexOf(":") + 1),
  };
}

// the origin of an authorized message: its address and its Bella conversation's kind
export function testMessageOrigin(chatId: string, channel: EMessagePlatform) {
  return { ...testMessageAddress(chatId, channel), kind: EConversationKind.Bella };
}

// a message received in a chat, as its channel publishes it, handled by the time this returns
export async function publishTestMessage(chatKey: string, content: string) {
  await EventBus.instance.publish({
    type: EEventType.MessageReceived,
    source: "test",
    key: chatKey,
    trace: { turnId: `test:${chatKey}`, chatId: chatKey, platform: EMessagePlatform.Signal },
    payload: {
      ...testMessageAddress(chatKey, EMessagePlatform.Signal),
      content,
      attachments: [],
      receivedAt: Date.now(),
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await EventBus.instance.idle();
}
