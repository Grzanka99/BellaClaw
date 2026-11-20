import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  conversationsTable,
  EEventType,
  eventsTable,
  memoriesTable,
  type TSelectMemory,
} from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { asc, eq } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { ERole } from "../ai/types";
import { AuthorizationService } from "../authorization";
import { Commands } from "../commands";
import { DatabaseConnector } from "../database";
import { EventBus } from "../events";
import { testMessageOrigin, withEventContext } from "../events/test-utils";
import { IdentityService } from "../identity";
import { resetServices } from "../internal-api/test-utils";
import { Memory } from "../memory";
import { MessageHandler } from "../message-handler";
import { scriptedReply } from "../message-handler/test-utils";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import type { TConversation } from "./types";

const originalUrl = Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL;
const originalSecret = Bun.env.BELLACLAW_GATEWAY_SECRET;

resetServices([
  EventBus,
  MessageHandler,
  MessagingAdapter,
  Commands,
  AuthorizationService,
  IdentityService,
  SettingsService,
]);

beforeEach(() => {
  Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL = "https://dashboard.test";
  Bun.env.BELLACLAW_GATEWAY_SECRET = "gateway-secret";
});

afterEach(() => {
  Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL = originalUrl;
  Bun.env.BELLACLAW_GATEWAY_SECRET = originalSecret;
});

// Commands, the conversation consumer and outbound on a fresh bus, with a scripted model
async function setupSession() {
  Object.assign(SettingsService, {
    _instance: { getAll: mock(async () => DefaultConfigRecord) },
  });
  const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) =>
    scriptedReply(args, `Reply to ${args.prompt}`),
  );
  Object.assign(MessageHandler.instance, {
    ai: { runMain, compactConversation: mock(async () => undefined) },
  });
  const sendText = mock(async (_address: string, _text: string) => undefined);
  MessagingAdapter.instance.registerTransport({
    platform: EMessagePlatform.Signal,
    sendText,
    fetchAttachment: async () => new Uint8Array(),
    deleteAttachment: async () => undefined,
  });
  MessageHandler.instance.setup();
  Commands.instance.setup();
  MessagingAdapter.instance.setup();
  await EventBus.instance.start();
  return { runMain, sendText };
}

async function send(chatId: string, content: string, clientMessageId: string) {
  await EventBus.instance.publish({
    type: EEventType.MessageAuthorized,
    source: "test",
    key: chatId,
    trace: { turnId: `test:${clientMessageId}`, chatId, platform: EMessagePlatform.Signal },
    payload: {
      ...testMessageOrigin(chatId, EMessagePlatform.Signal),
      content,
      attachments: [],
      receivedAt: Date.now(),
      clientMessageId,
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await EventBus.instance.idle();
}

async function publish(
  chatId: string,
  type: EEventType.NoticeReady | EEventType.DeliveryReady,
  text: string,
) {
  const trace = { turnId: `test:${type}`, chatId, platform: undefined };
  if (type === EEventType.NoticeReady) {
    await EventBus.instance.publish({
      type,
      source: "test",
      key: chatId,
      trace,
      payload: { chatId, text },
      causationId: undefined,
      dedupeKey: undefined,
    });
  } else {
    await EventBus.instance.publish({
      type,
      source: "test",
      key: chatId,
      trace,
      payload: {
        chatId,
        text,
        transcript: {
          text,
          modelText: `[CRON REMINDER daily]: ${text}`,
          notice: "A reminder fired.",
        },
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
  }
  await EventBus.instance.idle();
}

function requestDelete(chatId: string, messageId: number) {
  return withEventContext((ctx) =>
    ctx.request(
      EEventType.ConversationMessageDeleteRequested,
      { chatId, messageId },
      {
        outcome: EEventType.ConversationMessageDeleted,
        step: undefined,
        key: chatId,
        timeoutMs: undefined,
      },
    ),
  );
}

async function rows(chatId: string): Promise<TSelectMemory[]> {
  return DatabaseConnector.instance.database
    .select()
    .from(memoriesTable)
    .where(eq(memoriesTable.chatId, chatId))
    .orderBy(asc(memoriesTable.id));
}

// the conversation.changed payloads, oldest first; each test has one conversation
async function changes() {
  const events = await DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, EEventType.ConversationChanged))
    .orderBy(asc(eventsTable.seq));
  return events.map((event) => event.payload);
}

async function revision(chatId: string) {
  return DatabaseConnector.instance.database
    .select({
      revision: conversationsTable.revision,
      rewriteRevision: conversationsTable.rewriteRevision,
    })
    .from(conversationsTable)
    .where(eq(conversationsTable.conversationKey, chatId))
    .get();
}

test("a scripted session stores one row per visible message with its channel, a fact per change, and replays only the model's rows", async () => {
  const chatId = `signal:session-${crypto.randomUUID()}`;
  const { runMain, sendText } = await setupSession();
  const seen: number[] = [];
  // each change raises the revision by one, and the fact carries it with the revision of the
  // latest change that was not an append
  const expectChanged = async (count: number, rewriteRevision: number) => {
    const facts = await changes();
    expect(facts).toHaveLength(seen.length + count);
    for (const fact of facts.slice(seen.length)) {
      // an appended reply or notice also names its row
      expect(fact).toMatchObject({
        conversationKey: chatId,
        ownerKey: chatId,
        revision: seen.length + 1,
        rewriteRevision,
      });
      seen.push(seen.length + 1);
    }
    expect(await revision(chatId)).toEqual({ revision: seen.length, rewriteRevision });
  };

  // appends leave rewriteRevision where it is
  await send(chatId, "Hello", "client-1");
  await expectChanged(2, 0);
  await send(chatId, "!update", "client-2");
  await expectChanged(1, 0);
  await publish(chatId, EEventType.NoticeReady, "Connected MCP profile notes.");
  await expectChanged(1, 0);
  await publish(chatId, EEventType.DeliveryReady, "Take a break.");
  await expectChanged(1, 0);
  runMain.mockImplementationOnce(async () => {
    throw new Error("model down");
  });
  await send(chatId, "Are you there?", "client-3");
  await expectChanged(2, 0);
  await send(chatId, "!dashboard", "client-4");
  await expectChanged(0, 0);
  // the delete is the eighth change, and sets rewriteRevision to it
  const reply = (await rows(chatId)).find((row) => row.message === "Reply to Hello");
  await requestDelete(chatId, reply?.id ?? 0);
  await expectChanged(1, 8);

  // the dashboard link is sent on the channel it was asked on, and stored nowhere
  const link = sendText.mock.calls.find(([, text]) => text.includes("/link?token="));
  expect(link?.[0]).toBe(chatId.slice("signal:".length));
  expect(
    (await DatabaseConnector.instance.database.select().from(eventsTable)).filter(
      (event) => event.type !== EEventType.ReplyReady && JSON.stringify(event).includes("token="),
    ),
  ).toEqual([]);

  expect(
    (await rows(chatId)).map((row) => ({
      author: row.author,
      kind: row.kind,
      message: row.message,
      channel: row.channel,
      clientMessageId: row.clientMessageId,
      replayed: row.modelMessage !== null,
    })),
  ).toEqual([
    {
      author: ERole.User,
      kind: "message",
      message: "Hello",
      channel: EMessagePlatform.Signal,
      clientMessageId: "client-1",
      replayed: true,
    },
    {
      author: ERole.User,
      kind: "display",
      message: "!update",
      channel: EMessagePlatform.Signal,
      clientMessageId: "client-2",
      replayed: false,
    },
    {
      author: ERole.Assistant,
      kind: "display",
      message: "Updating requires BELLACLAW_ACTIVATION_TOKEN and an activated chat.",
      channel: EMessagePlatform.Signal,
      clientMessageId: null,
      replayed: false,
    },
    {
      author: ERole.Assistant,
      kind: "display",
      message: "Connected MCP profile notes.",
      channel: EMessagePlatform.Signal,
      clientMessageId: null,
      replayed: false,
    },
    // the reminder's notice to the model, which the user never sees
    {
      author: ERole.User,
      kind: "tool",
      message: "A reminder fired.",
      channel: EMessagePlatform.Signal,
      clientMessageId: null,
      replayed: true,
    },
    {
      author: ERole.Assistant,
      kind: "message",
      message: "Take a break.",
      channel: EMessagePlatform.Signal,
      clientMessageId: null,
      replayed: true,
    },
    {
      author: ERole.User,
      kind: "message",
      message: "Are you there?",
      channel: EMessagePlatform.Signal,
      clientMessageId: "client-3",
      replayed: false,
    },
    {
      author: ERole.Assistant,
      kind: "display",
      message: "Something went wrong.",
      channel: EMessagePlatform.Signal,
      clientMessageId: null,
      replayed: false,
    },
  ]);

  // fact distillation reads the model's message rows only, never display rows
  expect(
    (await Memory.instance.loadLiveFactWindow(chatId)).messages.map((row) => row.message),
  ).toEqual(["Hello", "Take a break.", "Are you there?"]);

  // the next turn replays the model's rows only: compaction gets this same state; its appends
  // keep rewriteRevision at the delete
  await send(chatId, "Again", "client-5");
  await expectChanged(2, 8);

  const conversation: TOption<TConversation> = runMain.mock.calls[2]?.[0].conversation;
  expect(
    conversation?.entries.map((entry) => [entry.message.role, JSON.stringify(entry.message)]),
  ).toEqual([
    ["user", expect.stringContaining('"Hello"')],
    ["user", expect.stringContaining('"A reminder fired."')],
    ["assistant", expect.stringContaining("[CRON REMINDER daily]: Take a break.")],
  ]);
});
