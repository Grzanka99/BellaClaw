import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { EEventType, eventsTable, identityLinksTable, listHistory } from "@bellaclaw/database";
import {
  GATEWAY_STREAM_PATH,
  gatewayAccountConversationMessagesPath,
  type TGatewayStreamEvent,
} from "@bellaclaw/shared";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { eq } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { AuthorizationService } from "../authorization";
import { Commands } from "../commands";
import { DatabaseConnector } from "../database";
import { resetEventTables, resetIdentityLinksTable } from "../database/test-utils";
import { EventBus } from "../events";
import { IdentityService } from "../identity";
import { EIdentityLinkState } from "../identity/schema";
import { handleInternalApiRequest, setupInternalApi } from "../internal-api";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import { AppStream } from ".";

const SECRET = "internal-secret";

function reset() {
  for (const service of [
    EventBus,
    MessageHandler,
    MessagingAdapter,
    Commands,
    AuthorizationService,
    IdentityService,
    SettingsService,
    AppStream,
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

// the pipeline from the internal API to Outbound on a fresh bus, with a scripted model, a Signal
// transport and the app stream; the model awaits beforeReply before it answers a prompt
async function start(beforeReply = async (_prompt: string) => {}) {
  Object.assign(SettingsService, {
    _instance: { getAll: mock(async () => DefaultConfigRecord) },
  });
  const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) => {
    await beforeReply(args.prompt);
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
  AppStream.instance.setup();
  await IdentityService.instance.setup();
  await AuthorizationService.instance.setup();
  await EventBus.instance.start();
  return { sendText };
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

// the edge's stream; events: every event read so far, by reading what has arrived
async function openStream() {
  const response = await request("GET", GATEWAY_STREAM_PATH);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
  const reader = response.body?.getReader();

  if (reader === undefined) {
    throw new Error("The stream has no body");
  }

  const decoder = new TextDecoder();
  const events: TGatewayStreamEvent[] = [];
  let buffered = "";
  let pending = reader.read();

  return {
    events,
    // reads until nothing more arrives within a moment
    async drain() {
      while (true) {
        const chunk = await Promise.race([pending, Bun.sleep(20).then(() => undefined)]);

        if (chunk === undefined || chunk.done) {
          return events;
        }

        pending = reader.read();
        buffered += decoder.decode(chunk.value);
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";

        for (const line of lines.filter((line) => line.length > 0)) {
          events.push(JSON.parse(line));
        }
      }
    },
    close: () => reader.cancel(),
  };
}

function listeners() {
  // biome-ignore lint/complexity/useLiteralKeys: a private field, read for the check
  return AppStream.instance["listeners"].size;
}

async function sendApp(accountId: string, text: string, clientMessageId: string) {
  const response = await request(
    "POST",
    gatewayAccountConversationMessagesPath(accountId, `bella:${accountId}`),
    { clientMessageId, text },
  );
  expect(response.status).toBe(200);
  await EventBus.instance.idle();
}

test("an app send streams typing on as requested and as started, the user's row, typing off and the reply, with rising revisions, under its account", async () => {
  await start();
  const stream = await openStream();
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = `bella:${accountId}`;

  await sendApp(accountId, "Hello", "m-1");
  await sendApp(accountId, "And you?", "m-2");

  // the order a client relies on: a nudge after typing stops already carries the reply
  const turn = (revision: number): TGatewayStreamEvent[] => [
    { type: "typing", accountId, conversationKey, typing: true },
    { type: "typing", accountId, conversationKey, typing: true },
    { type: "changed", accountId, conversationKey, revision, rewriteRevision: 0 },
    { type: "typing", accountId, conversationKey, typing: false },
    { type: "changed", accountId, conversationKey, revision: revision + 1, rewriteRevision: 0 },
  ];
  expect(await stream.drain()).toEqual([...turn(1), ...turn(3)]);

  await stream.close();
  expect(listeners()).toBe(0);
});

test("a message queued behind a running turn turns typing on again when it starts, after the first turn's typing off", async () => {
  const running = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await start(async (prompt) => {
    if (prompt === "Slow") {
      running.resolve();
      await release.promise;
    }
  });
  const stream = await openStream();
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = `bella:${accountId}`;
  const path = gatewayAccountConversationMessagesPath(accountId, conversationKey);

  expect((await request("POST", path, { clientMessageId: "m-1", text: "Slow" })).status).toBe(200);
  await running.promise;
  expect((await request("POST", path, { clientMessageId: "m-2", text: "Next" })).status).toBe(200);
  await stream.drain();
  release.resolve();
  await EventBus.instance.idle();

  const typing = (on: boolean): TGatewayStreamEvent => ({
    type: "typing",
    accountId,
    conversationKey,
    typing: on,
  });
  const changed = (revision: number): TGatewayStreamEvent => ({
    type: "changed",
    accountId,
    conversationKey,
    revision,
    rewriteRevision: 0,
  });
  // the second request turns typing on while the first turn runs; the first turn's typing off
  // comes before the second turn starts, which turns it on again before its reply
  expect(await stream.drain()).toEqual([
    typing(true),
    typing(true),
    changed(1),
    typing(true),
    typing(false),
    changed(2),
    typing(true),
    changed(3),
    typing(false),
    changed(4),
  ]);
  await stream.close();
});

test("a Signal message of a linked address streams under the address's account; an unlinked chat streams nothing", async () => {
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
  const stream = await openStream();

  for (const chatAddress of [address, `+${Date.now() + 1}`]) {
    const chatKey = `signal:${chatAddress}`;
    await EventBus.instance.publish({
      type: EEventType.MessageReceived,
      source: "signal",
      key: chatKey,
      trace: { turnId: `test:${chatKey}`, chatId: chatKey, platform: EMessagePlatform.Signal },
      payload: {
        conversationKey: chatKey,
        ownerKey: chatKey,
        channel: EMessagePlatform.Signal,
        replyAddress: chatAddress,
        content: "Hi from Signal",
        attachments: [],
        receivedAt: Date.now(),
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await EventBus.instance.idle();
  }

  expect(sendText.mock.calls[0]).toEqual([address, "Reply to Hi from Signal"]);
  const conversationKey = `bella:${accountId}`;
  expect(await stream.drain()).toEqual([
    { type: "typing", accountId, conversationKey, typing: true },
    { type: "typing", accountId, conversationKey, typing: true },
    { type: "changed", accountId, conversationKey, revision: 1, rewriteRevision: 0 },
    { type: "typing", accountId, conversationKey, typing: false },
    { type: "changed", accountId, conversationKey, revision: 2, rewriteRevision: 0 },
  ]);
  await stream.close();
});

// a message from a Signal address, as the Signal channel publishes it
async function sendSignal(address: string, text: string) {
  const chatKey = `signal:${address}`;
  await EventBus.instance.publish({
    type: EEventType.MessageReceived,
    source: "signal",
    key: chatKey,
    trace: { turnId: `test:${chatKey}`, chatId: chatKey, platform: EMessagePlatform.Signal },
    payload: {
      conversationKey: chatKey,
      ownerKey: chatKey,
      channel: EMessagePlatform.Signal,
      replyAddress: address,
      content: text,
      attachments: [],
      receivedAt: Date.now(),
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await EventBus.instance.idle();
}

async function linkSignal(accountId: string, address: string) {
  await DatabaseConnector.instance.database.insert(identityLinksTable).values({
    channel: EMessagePlatform.Signal,
    address,
    accountId,
    state: EIdentityLinkState.Active,
    linkedAt: new Date(1_000),
  });
}

test("a confidential command reply to an app message streams once as a reply and is neither stored nor nudged; on Signal it is sent and streams nothing", async () => {
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = `bella:${accountId}`;
  const address = `+${Date.now()}`;
  const usage =
    "Usage: !mcp-auth connect|disconnect|status PROFILE or !mcp-auth token PROFILE TOKEN";
  await linkSignal(accountId, address);
  const { sendText } = await start();
  const stream = await openStream();

  await sendApp(accountId, "!mcp-auth", "m-1");

  expect(await stream.drain()).toEqual([
    { type: "reply", accountId, conversationKey, text: usage },
  ]);
  expect(
    await listHistory(DatabaseConnector.instance.database, conversationKey, undefined, 50),
  ).toEqual([]);
  expect(
    await DatabaseConnector.instance.database
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.type, EEventType.ConversationChanged)),
  ).toEqual([]);

  await sendSignal(address, "!mcp-auth");

  expect(sendText.mock.calls).toEqual([[address, usage]]);
  // drain returns every event read so far: the app reply alone
  expect(await stream.drain()).toHaveLength(1);
  await stream.close();
});

test("!app and !dashboard from the app answer with a stored plain reply and no link; from Signal they send a confidential link", async () => {
  const originalUrl = Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL;
  const originalSecret = Bun.env.BELLACLAW_GATEWAY_SECRET;
  Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL = "https://dashboard.test";
  Bun.env.BELLACLAW_GATEWAY_SECRET = "gateway-secret";

  try {
    const accountId = `acct-${crypto.randomUUID()}`;
    const conversationKey = `bella:${accountId}`;
    const address = `+${Date.now()}`;
    await linkSignal(accountId, address);
    const { sendText } = await start();
    const stream = await openStream();

    await sendApp(accountId, "!app", "m-1");
    await sendApp(accountId, "!dashboard", "m-2");

    expect(await stream.drain()).toEqual([
      { type: "changed", accountId, conversationKey, revision: 1, rewriteRevision: 0 },
      { type: "changed", accountId, conversationKey, revision: 2, rewriteRevision: 0 },
    ]);
    const texts = (
      await listHistory(DatabaseConnector.instance.database, conversationKey, undefined, 50)
    ).map((message) => message.text);
    expect(texts).toHaveLength(4);
    expect(texts).toContain("!app");
    expect(texts).toContain("!dashboard");
    expect(texts.filter((text) => text.startsWith("This app is signed in"))).toHaveLength(2);
    expect(texts.join("\n")).not.toContain("token=");

    await sendSignal(address, "!app");
    await sendSignal(address, "!dashboard");

    expect(sendText.mock.calls.map((call) => call[0])).toEqual([address, address]);
    expect(sendText.mock.calls[0]?.[1]).toStartWith("https://dashboard.test/app?token=");
    expect(sendText.mock.calls[1]?.[1]).toStartWith("https://dashboard.test/link?token=");
    expect(await stream.drain()).toHaveLength(2);
    await stream.close();
  } finally {
    Bun.env.BELLACLAW_GATEWAY_PUBLIC_URL = originalUrl;
    Bun.env.BELLACLAW_GATEWAY_SECRET = originalSecret;
  }
});

test("a message deleted in the dashboard streams a nudge whose rewrite revision moved", async () => {
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = `bella:${accountId}`;
  await sendApp(accountId, "Hello", "m-1");
  const stream = await openStream();

  const reply = (
    await listHistory(DatabaseConnector.instance.database, conversationKey, undefined, 50)
  ).at(-1);
  const deleted = await request(
    "DELETE",
    `/internal/accounts/${encodeURIComponent(accountId)}/messages/${reply?.id}`,
  );
  expect(deleted.status).toBe(200);
  await EventBus.instance.idle();

  expect(await stream.drain()).toEqual([
    { type: "changed", accountId, conversationKey, revision: 3, rewriteRevision: 3 },
  ]);
  await stream.close();
});

test("a dead-lettered turn request turns typing off; a dead letter of another event sends nothing", async () => {
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = `bella:${accountId}`;
  const stream = await openStream();

  async function deadLetter(eventType: EEventType) {
    await EventBus.instance.publish({
      type: EEventType.EventDeadLettered,
      source: "events",
      key: conversationKey,
      trace: { turnId: "test:dead", chatId: conversationKey, platform: EMessagePlatform.App },
      payload: {
        eventId: `event-${eventType}`,
        eventType,
        consumer: "conversation",
        attempts: 1,
        error: "killed",
      },
      causationId: undefined,
      dedupeKey: undefined,
    });
    await EventBus.instance.idle();
  }

  await deadLetter(EEventType.ConversationChanged);
  expect(await stream.drain()).toEqual([]);

  await deadLetter(EEventType.TurnRequested);
  expect(await stream.drain()).toEqual([
    { type: "typing", accountId, conversationKey, typing: false },
  ]);
  await stream.close();
});

test("the stream needs the secret, and an aborted connection releases its listener", async () => {
  await start();
  const refused = await handleInternalApiRequest(
    new Request(`http://internal${GATEWAY_STREAM_PATH}`),
    SECRET,
  );
  expect(refused.status).toBe(401);

  const aborted = new AbortController();
  await handleInternalApiRequest(
    new Request(`http://internal${GATEWAY_STREAM_PATH}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
      signal: aborted.signal,
    }),
    SECRET,
  );
  expect(listeners()).toBe(1);
  aborted.abort();
  expect(listeners()).toBe(0);
});
