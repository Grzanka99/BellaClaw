import { afterEach, beforeEach, expect, test } from "bun:test";
import { EEventType, factsTable, memoriesTable } from "@bellaclaw/database";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ERole } from "../ai/types";
import { DatabaseConnector } from "../database";
import { linkTestAddress, resetEventTables, resetIdentityLinksTable } from "../database/test-utils";
import { CommandRejectedError, EventBus } from "../events";
import { ERejectionCode } from "../events/catalog";
import { withEventContext } from "../events/test-utils";
import { IdentityService } from "../identity";
import { Memory } from "../memory";
import { MessageHandler } from "../message-handler";
import { EMessagePlatform } from "../messaging/types";
import { ConversationStore } from ".";
import type { TConversation } from "./types";

// the conversation and memory consumers on a fresh bus
beforeEach(async () => {
  await resetEventTables();
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(MessageHandler, { _instance: undefined });
  Object.assign(Memory, { _instance: undefined });
  MessageHandler.instance.setup();
  Memory.instance.setup();
  await EventBus.instance.start();
});

afterEach(async () => {
  await EventBus.instance.stop();
});

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

// saves one turn; extra: the tool call and result between the user message and the reply
async function saveTurn(
  chatId: string,
  text: string,
  extra: Message[],
  previous: TConversation | undefined,
) {
  const db = DatabaseConnector.instance.database;
  const store = ConversationStore.instance;
  const source = await store.saveUserMessage(
    db,
    chatId,
    EMessagePlatform.Signal,
    ERole.User,
    text,
    new Date(),
    undefined,
    [],
  );
  const history = previous?.entries.map((entry) => entry.message) ?? [];

  return store.saveTurn(
    db,
    chatId,
    EMessagePlatform.Signal,
    [
      ...history,
      { role: "user", content: text, timestamp: source.createdAt.getTime() },
      ...extra,
      fauxAssistantMessage(`reply to ${text}`),
    ],
    source.id,
    previous,
  );
}

async function rowIds(chatId: string) {
  const rows = await DatabaseConnector.instance.database
    .select({ id: memoriesTable.id })
    .from(memoriesTable)
    .where(eq(memoriesTable.chatId, chatId))
    .orderBy(asc(memoriesTable.id));

  return rows.map((row) => row.id);
}

async function insertFact(chatId: string, text: string, sourceMessageId: number) {
  const embedding = new Array<number>(768).fill(0);
  embedding[0] = 1;
  await DatabaseConnector.instance.database
    .insert(factsTable)
    .values({ chatId, text, embedding, createdAt: new Date(), sourceMessageId });
}

async function liveFacts(chatId: string) {
  const rows = await DatabaseConnector.instance.database
    .select({ text: factsTable.text })
    .from(factsTable)
    .where(and(eq(factsTable.chatId, chatId), isNull(factsTable.forgottenAt)))
    .orderBy(asc(factsTable.id));

  return rows.map((row) => row.text);
}

test("deleting an assistant reply removes it with its tool rows and forgets the facts they sourced", async () => {
  const chatId = "delete-reply";
  const first = await saveTurn(chatId, "first", [], undefined);
  const second = await saveTurn(
    chatId,
    "second",
    [
      fauxAssistantMessage(fauxToolCall("calendar", {}, { id: "calendar-1" })),
      {
        role: "toolResult",
        toolName: "calendar",
        toolCallId: "calendar-1",
        content: [{ type: "text", text: "Free" }],
        timestamp: 2,
        isError: false,
      },
    ],
    first,
  );
  const third = await saveTurn(chatId, "third", [], second);
  const ids = third.entries.map((entry) => entry.id);
  // [first, reply, second, tool call, tool result, reply, third, reply]
  const [, , secondId = 0, callId = 0, resultId = 0, replyId = 0] = ids;
  await insertFact(chatId, "from the reply", replyId);
  await insertFact(chatId, "from the tool result", resultId);
  await insertFact(chatId, "from the user message", secondId);

  const deleted = await requestDelete(chatId, replyId);
  await EventBus.instance.idle();

  expect(deleted.payload).toEqual({ chatId, messageIds: [callId, resultId, replyId] });
  const kept = ids.filter((id) => ![callId, resultId, replyId].includes(id));
  expect(await rowIds(chatId)).toEqual(kept);
  expect((await ConversationStore.instance.load(chatId))?.entries.map((entry) => entry.id)).toEqual(
    kept,
  );
  expect(await liveFacts(chatId)).toEqual(["from the user message"]);
});

test("deleting a delivered message removes it with its notice row and keeps the display rows before it", async () => {
  const chatId = "delete-delivered";
  const db = DatabaseConnector.instance.database;
  const store = ConversationStore.instance;
  await saveTurn(chatId, "first", [], undefined);
  await store.saveDisplayMessage(
    db,
    chatId,
    EMessagePlatform.Signal,
    { text: "Updated.", request: { text: "!update", receivedAt: 1 } },
    2,
  );
  await store.saveDeliveredMessage(
    db,
    chatId,
    EMessagePlatform.Signal,
    "Tea time",
    "Tea time",
    "a reminder",
    3,
  );
  const ids = await rowIds(chatId);
  // [first, reply, command, command reply, reminder notice, reminder]
  const [, , , , noticeId = 0, reminderId = 0] = ids;

  const deleted = await requestDelete(chatId, reminderId);
  await EventBus.instance.idle();

  expect(deleted.payload).toEqual({ chatId, messageIds: [noticeId, reminderId] });
  expect(await rowIds(chatId)).toEqual(ids.slice(0, 4));
});

test("a message id of another chat is rejected and nothing is deleted", async () => {
  const chatId = "delete-foreign";
  const otherChatId = "delete-foreign-other";
  await saveTurn(chatId, "mine", [], undefined);
  const other = await saveTurn(otherChatId, "theirs", [], undefined);
  const before = [await rowIds(chatId), await rowIds(otherChatId)];

  for (const entry of other.entries) {
    const rejected = await requestDelete(chatId, entry.id).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(CommandRejectedError);
    expect(rejected).toMatchObject({ code: ERejectionCode.Invalid });
  }

  expect([await rowIds(chatId), await rowIds(otherChatId)]).toEqual(before);
});

test("deleting a message of an account's Bella conversation forgets the facts stored under the account", async () => {
  await resetIdentityLinksTable();
  Object.assign(IdentityService, { _instance: undefined });
  await linkTestAddress("+800", "acct-delete");
  const chatId = "bella:acct-delete";
  const turn = await saveTurn(chatId, "first", [], undefined);
  const replyId = turn.entries[1]?.id ?? 0;
  await insertFact("account:acct-delete", "from the reply", replyId);

  await requestDelete(chatId, replyId);
  await EventBus.instance.idle();

  expect(await liveFacts("account:acct-delete")).toEqual([]);
  await resetIdentityLinksTable();
  Object.assign(IdentityService, { _instance: undefined });
});
