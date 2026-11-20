import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  EEventType,
  eventsTable,
  findOwnedConversation,
  identityLinksTable,
  listHistory,
  type THistoryCursor,
} from "@bellaclaw/database";
import { dashboardAccountConversationMessagesPath, type TOption } from "@bellaclaw/shared";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { asc, eq } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { AuthorizationService } from "../authorization";
import { Commands } from "../commands";
import { DatabaseConnector } from "../database";
import { resetEventTables, resetIdentityLinksTable } from "../database/test-utils";
import { EventBus } from "../events";
import { IdentityService } from "../identity";
import { EIdentityLinkState } from "../identity/schema";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import { handleInternalApiRequest, setupInternalApi } from ".";

const SECRET = "internal-secret";
const NOT_FOUND = { error: "Not found" };

function reset() {
  for (const service of [
    EventBus,
    MessageHandler,
    MessagingAdapter,
    Commands,
    AuthorizationService,
    IdentityService,
    SettingsService,
  ]) {
    Object.assign(service, { _instance: undefined });
  }
}

beforeEach(async () => {
  reset();
  await resetEventTables();
  await resetIdentityLinksTable();
});

afterEach(async () => {
  await EventBus.instance.idle();
  await EventBus.instance.stop();
  await resetIdentityLinksTable();
  reset();
});

// the pipeline from the internal API to Outbound on a fresh bus, with a scripted model and a
// Signal transport
async function start() {
  Object.assign(SettingsService, {
    _instance: { getAll: mock(async () => DefaultConfigRecord) },
  });
  const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) => {
    const messages: Message[] = [
      ...(args.conversation?.entries.map((entry) => entry.message) ?? []),
      { role: "user", content: args.prompt, timestamp: Date.now() },
      fauxAssistantMessage(`Reply to ${args.prompt}`),
    ];
    return {
      text: `Reply to ${args.prompt}`,
      iterations: 1,
      toolCallCount: 0,
      stopReason: "completed",
      messages,
    };
  });
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
  setupInternalApi();
  await IdentityService.instance.setup();
  await AuthorizationService.instance.setup();
  await EventBus.instance.start();
  return { runMain, sendText };
}

function request(method: string, path: string, body?: unknown) {
  return handleInternalApiRequest(
    new Request(`http://internal${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    }),
    SECRET,
  );
}

// an app send as the dashboard forwards it; the status and the body once the turn settled
async function sendApp(accountId: string, conversationKey: string, body: unknown) {
  const response = await request(
    "POST",
    dashboardAccountConversationMessagesPath(accountId, conversationKey),
    body,
  );
  const answer = [response.status, await response.json()];
  await EventBus.instance.idle();
  return answer;
}

function account(accountId: string) {
  return { conversationKey: `bella:${accountId}`, ownerKey: `account:${accountId}` };
}

function history(conversationKey: string, after?: number) {
  let cursor: TOption<THistoryCursor>;
  if (after !== undefined) {
    cursor = { direction: "after", id: after };
  }
  return listHistory(DatabaseConnector.instance.database, conversationKey, cursor, 50);
}

function revisions(conversationKey: string, accountId: string) {
  return findOwnedConversation(
    DatabaseConnector.instance.database,
    conversationKey,
    account(accountId),
  );
}

async function eventsOf(type: EEventType) {
  return DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, type))
    .orderBy(asc(eventsTable.seq));
}

test("an account with no linked chat sends twice with one client id, gets one turn and one reply in history, and fetches by cursor", async () => {
  const { runMain, sendText } = await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const { conversationKey } = account(accountId);
  const message = { clientMessageId: "m-1", text: "Hello" };

  expect(await revisions(conversationKey, accountId)).toEqual({ revision: 0, rewriteRevision: 0 });
  expect(await sendApp(accountId, conversationKey, message)).toEqual([
    200,
    { clientMessageId: "m-1" },
  ]);
  expect(await sendApp(accountId, conversationKey, message)).toEqual([
    200,
    { clientMessageId: "m-1" },
  ]);

  expect(await eventsOf(EEventType.MessageReceived)).toHaveLength(1);
  expect(runMain).toHaveBeenCalledTimes(1);
  expect(await eventsOf(EEventType.ReplyReady)).toHaveLength(1);
  // the app is a destination with nothing to send
  expect(sendText).not.toHaveBeenCalled();
  expect((await eventsOf(EEventType.MessageSent)).map((event) => event.payload)).toMatchObject([
    { chatId: conversationKey, channel: EMessagePlatform.App },
  ]);

  const rows = await history(conversationKey);
  expect(rows).toMatchObject([
    { author: "user", kind: "message", channel: "app", text: "Hello", clientMessageId: "m-1" },
    { author: "assistant", kind: "message", channel: "app", text: "Reply to Hello" },
  ]);
  expect(await revisions(conversationKey, accountId)).toEqual({ revision: 2, rewriteRevision: 0 });

  // a command from the app keeps its consumer, and is shown in history
  await sendApp(accountId, conversationKey, { clientMessageId: "m-2", text: "!update" });
  await sendApp(accountId, conversationKey, { clientMessageId: "m-3", text: "And you?" });
  expect(runMain).toHaveBeenCalledTimes(2);
  const appended = await history(conversationKey, rows.at(-1)?.id);
  expect(appended).toMatchObject([
    { author: "user", kind: "display", text: "!update", clientMessageId: "m-2" },
    { author: "assistant", kind: "display" },
    { author: "user", kind: "message", text: "And you?", clientMessageId: "m-3" },
    { author: "assistant", kind: "message", text: "Reply to And you?" },
  ]);
  expect(await revisions(conversationKey, accountId)).toEqual({ revision: 5, rewriteRevision: 0 });
});

test("a conversation of another account is answered like one that does not exist, and Authorization drops a message for it", async () => {
  const { runMain } = await start();
  const alice = `acct-${crypto.randomUUID()}`;
  const bob = `acct-${crypto.randomUUID()}`;
  const message = { clientMessageId: "m-1", text: "Hello" };
  await sendApp(alice, account(alice).conversationKey, message);
  expect(runMain).toHaveBeenCalledTimes(1);

  const answers = [
    await sendApp(bob, account(alice).conversationKey, message),
    await sendApp(bob, "bella:nobody", message),
    await sendApp(bob, `signal:+${Date.now()}`, message),
  ];
  expect(answers).toEqual([
    [404, NOT_FOUND],
    [404, NOT_FOUND],
    [404, NOT_FOUND],
  ]);
  expect(await eventsOf(EEventType.MessageReceived)).toHaveLength(1);

  // an app message for a conversation its owner key does not own stops at Authorization
  await EventBus.instance.publish({
    type: EEventType.MessageReceived,
    source: "test",
    key: account(alice).conversationKey,
    trace: { turnId: "test:forged", chatId: undefined, platform: EMessagePlatform.App },
    payload: {
      conversationKey: account(alice).conversationKey,
      ownerKey: account(bob).ownerKey,
      channel: EMessagePlatform.App,
      replyAddress: bob,
      content: "Forged",
      attachments: [],
      receivedAt: Date.now(),
      clientMessageId: "m-2",
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await EventBus.instance.idle();
  expect(await eventsOf(EEventType.MessageAuthorized)).toHaveLength(1);
  expect(runMain).toHaveBeenCalledTimes(1);
  expect((await history(account(alice).conversationKey)).map((row) => row.text)).toEqual([
    "Hello",
    "Reply to Hello",
  ]);
});

test("a Signal message of a linked address is answered on Signal, and the app's history shows it", async () => {
  const accountId = `acct-${crypto.randomUUID()}`;
  const address = `+${Date.now()}`;
  await DatabaseConnector.instance.database.insert(identityLinksTable).values({
    channel: EMessagePlatform.Signal,
    address,
    accountId,
    state: EIdentityLinkState.Active,
    linkedAt: new Date(1_000),
  });
  const { sendText } = await start();
  const chatKey = `signal:${address}`;

  await EventBus.instance.publish({
    type: EEventType.MessageReceived,
    source: "signal",
    key: chatKey,
    trace: { turnId: "test:signal", chatId: chatKey, platform: EMessagePlatform.Signal },
    payload: {
      conversationKey: chatKey,
      ownerKey: chatKey,
      channel: EMessagePlatform.Signal,
      replyAddress: address,
      content: "Hi from Signal",
      attachments: [],
      receivedAt: Date.now(),
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await EventBus.instance.idle();

  expect(sendText.mock.calls).toEqual([[address, "Reply to Hi from Signal"]]);
  const { conversationKey } = account(accountId);
  expect(await history(conversationKey)).toMatchObject([
    { author: "user", channel: "signal", text: "Hi from Signal" },
    { author: "assistant", channel: "signal", text: "Reply to Hi from Signal" },
  ]);
  expect(await revisions(conversationKey, accountId)).toEqual({ revision: 2, rewriteRevision: 0 });
});

test("a message deleted in the dashboard moves the rewrite revision, and a reload no longer returns it", async () => {
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const { conversationKey } = account(accountId);
  await sendApp(accountId, conversationKey, { clientMessageId: "m-1", text: "Hello" });
  const reply = (await history(conversationKey)).at(-1);

  const deleted = await request(
    "DELETE",
    `/internal/accounts/${encodeURIComponent(accountId)}/messages/${reply?.id}`,
  );
  expect(deleted.status).toBe(200);
  await EventBus.instance.idle();

  // a client synced at revision 2 is below the rewrite revision, so it reloads
  expect(await revisions(conversationKey, accountId)).toEqual({ revision: 3, rewriteRevision: 3 });
  expect((await history(conversationKey)).map((row) => row.text)).toEqual(["Hello"]);
});

test("a notice or a reminder of an account with no linked chat goes to the app's history", async () => {
  const { sendText } = await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const { conversationKey } = account(accountId);

  await EventBus.instance.publish({
    type: EEventType.NoticeReady,
    source: "test",
    key: conversationKey,
    trace: { turnId: "test:notice", chatId: conversationKey, platform: undefined },
    payload: { chatId: conversationKey, text: "A notice" },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await EventBus.instance.publish({
    type: EEventType.DeliveryReady,
    source: "test",
    key: conversationKey,
    trace: { turnId: "test:delivery", chatId: conversationKey, platform: undefined },
    payload: {
      chatId: conversationKey,
      text: "Take a break",
      transcript: { text: "Take a break", notice: "A reminder fired." },
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await EventBus.instance.idle();

  expect(sendText).not.toHaveBeenCalled();
  expect(await history(conversationKey)).toMatchObject([
    { author: "assistant", kind: "display", channel: "app", text: "A notice" },
    { author: "assistant", kind: "message", channel: "app", text: "Take a break" },
  ]);
  // listed under the account, so the app may read it
  expect(await revisions(conversationKey, accountId)).toEqual({ revision: 2, rewriteRevision: 0 });
});
