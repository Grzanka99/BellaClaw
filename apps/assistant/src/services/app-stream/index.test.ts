import { expect, mock, test } from "bun:test";
import { EEventType, eventsTable, listHistory } from "@bellaclaw/database";
import {
  GATEWAY_STREAM_PATH,
  gatewayAccountConversationMessagesPath,
  type TGatewayStreamEvent,
  type TOption,
} from "@bellaclaw/shared";
import { eq } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { AuthorizationService } from "../authorization";
import { Commands } from "../commands";
import { DatabaseConnector } from "../database";
import { linkTestAddress } from "../database/test-utils";
import { EventBus } from "../events";
import { publishTestMessage } from "../events/test-utils";
import { IdentityService } from "../identity";
import { handleInternalApiRequest, setupInternalApi } from "../internal-api";
import { internalRequest, resetServices, TEST_SECRET } from "../internal-api/test-utils";
import { MessageHandler } from "../message-handler";
import { scriptedReply } from "../message-handler/test-utils";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord } from "../settings/schema";
import { AppStream } from ".";

resetServices([
  EventBus,
  MessageHandler,
  MessagingAdapter,
  Commands,
  AuthorizationService,
  IdentityService,
  SettingsService,
  AppStream,
]);

// the pipeline from the internal API to Outbound on a fresh bus, with a scripted model, a Signal
// transport and the app stream; the model awaits beforeReply before it answers a prompt
async function start(beforeReply = async (_prompt: string) => {}) {
  Object.assign(SettingsService, {
    _instance: { getAll: mock(async () => DefaultConfigRecord) },
  });
  const runMain = mock(async (args: Parameters<AgentHarness["runMain"]>[0]) => {
    await beforeReply(args.prompt);
    return scriptedReply(args, `Reply to ${args.prompt}`);
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

// a dead letter of an event of eventType in the conversation
async function publishDeadLetter(conversationKey: string, eventType: EEventType) {
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
}

// no test uses these conversations: each read's own one's typing off marks the end of what it reads
let markers = 0;
// a read that has not met its marker by then fails, well before Bun's test timeout
const MARKER_DEADLINE_MS = 2_000;

// the edge's stream
async function openStream() {
  const response = await internalRequest("GET", GATEWAY_STREAM_PATH);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
  const reader = response.body?.getReader();

  if (reader === undefined) {
    throw new Error("The stream has no body");
  }

  const decoder = new TextDecoder();
  // read from the stream, not returned yet
  const unread: TGatewayStreamEvent[] = [];
  let buffered = "";

  // reads up to and including the first event equal to marker. Returns every event that arrived
  // before it and after the previous read's marker (or since the stream opened), in arrival order
  async function readUntil(marker: TGatewayStreamEvent) {
    let timer: TOption<ReturnType<typeof setTimeout>>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`No marker ${JSON.stringify(marker)} within ${MARKER_DEADLINE_MS} ms`)),
        MARKER_DEADLINE_MS,
      );
    });

    try {
      while (true) {
        const found = unread.findIndex((event) => Bun.deepEquals(event, marker));

        if (found !== -1) {
          return unread.splice(0, found + 1).slice(0, found);
        }

        const chunk = await Promise.race([reader.read(), deadline]);

        if (chunk.done) {
          throw new Error("The stream closed before the marker");
        }

        buffered += decoder.decode(chunk.value);
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";

        for (const line of lines.filter((line) => line.length > 0)) {
          unread.push(JSON.parse(line));
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    readUntil,
    // makes the stream send a marker of its own, a fresh conversation's typing off, and reads up
    // to it
    async drainToMarker() {
      markers += 1;
      const accountId = `acct-stream-marker-${markers}`;
      const conversationKey = `bella:${accountId}`;
      await publishDeadLetter(conversationKey, EEventType.TurnRequested);
      return readUntil({ type: "typing", accountId, conversationKey, typing: false });
    },
    close: () => reader.cancel(),
  };
}

function listeners() {
  // biome-ignore lint/complexity/useLiteralKeys: a private field, read for the check
  return AppStream.instance["listeners"].size;
}

async function sendApp(accountId: string, text: string, clientMessageId: string) {
  const response = await internalRequest(
    "POST",
    gatewayAccountConversationMessagesPath(accountId, `bella:${accountId}`),
    JSON.stringify({ clientMessageId, text }),
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
  expect(await stream.drainToMarker()).toEqual([...turn(1), ...turn(3)]);

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

  // the first turn stays parked until released, also when an assertion fails
  try {
    expect(
      (
        await internalRequest(
          "POST",
          path,
          JSON.stringify({ clientMessageId: "m-1", text: "Slow" }),
        )
      ).status,
    ).toBe(200);
    await running.promise;
    expect(
      (
        await internalRequest(
          "POST",
          path,
          JSON.stringify({ clientMessageId: "m-2", text: "Next" }),
        )
      ).status,
    ).toBe(200);
    // a confidential command reply follows the second request's typing on on the conversation's
    // own lanes, and is neither stored nor nudged
    expect(
      (
        await internalRequest(
          "POST",
          path,
          JSON.stringify({ clientMessageId: "m-3", text: "!mcp-auth" }),
        )
      ).status,
    ).toBe(200);

    // the second request turns typing on while the first turn runs
    expect(
      await stream.readUntil({
        type: "reply",
        accountId,
        conversationKey,
        text: "Usage: !mcp-auth connect|disconnect|status PROFILE or !mcp-auth token PROFILE TOKEN",
      }),
    ).toEqual([typing(true), typing(true), changed(1), typing(true)]);
  } finally {
    release.resolve();
  }
  await EventBus.instance.idle();

  // the first turn's typing off comes before the second turn starts, which turns it on again
  // before its reply
  expect(await stream.drainToMarker()).toEqual([
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
  await linkTestAddress(address, accountId);
  const { sendText } = await start();
  const stream = await openStream();

  for (const chatAddress of [address, `+${Date.now() + 1}`]) {
    await publishTestMessage(`signal:${chatAddress}`, "Hi from Signal");
  }

  expect(sendText.mock.calls[0]).toEqual([address, "Reply to Hi from Signal"]);
  const conversationKey = `bella:${accountId}`;
  expect(await stream.drainToMarker()).toEqual([
    { type: "typing", accountId, conversationKey, typing: true },
    { type: "typing", accountId, conversationKey, typing: true },
    { type: "changed", accountId, conversationKey, revision: 1, rewriteRevision: 0 },
    { type: "typing", accountId, conversationKey, typing: false },
    { type: "changed", accountId, conversationKey, revision: 2, rewriteRevision: 0 },
  ]);
  await stream.close();
});

test("a confidential command reply to an app message streams once as a reply and is neither stored nor nudged; on Signal it is sent and streams nothing", async () => {
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = `bella:${accountId}`;
  const address = `+${Date.now()}`;
  const usage =
    "Usage: !mcp-auth connect|disconnect|status PROFILE or !mcp-auth token PROFILE TOKEN";
  await linkTestAddress(address, accountId);
  const { sendText } = await start();
  const stream = await openStream();

  await sendApp(accountId, "!mcp-auth", "m-1");

  expect(await stream.drainToMarker()).toEqual([
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

  await publishTestMessage(`signal:${address}`, "!mcp-auth");

  expect(sendText.mock.calls).toEqual([[address, usage]]);
  expect(await stream.drainToMarker()).toEqual([]);
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
    await linkTestAddress(address, accountId);
    const { sendText } = await start();
    const stream = await openStream();

    await sendApp(accountId, "!app", "m-1");
    await sendApp(accountId, "!dashboard", "m-2");

    expect(await stream.drainToMarker()).toEqual([
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

    await publishTestMessage(`signal:${address}`, "!app");
    await publishTestMessage(`signal:${address}`, "!dashboard");

    expect(sendText.mock.calls.map((call) => call[0])).toEqual([address, address]);
    expect(sendText.mock.calls[0]?.[1]).toStartWith("https://dashboard.test/app?token=");
    expect(sendText.mock.calls[1]?.[1]).toStartWith("https://dashboard.test/link?token=");
    expect(await stream.drainToMarker()).toEqual([]);
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
  const deleted = await internalRequest(
    "DELETE",
    `/internal/accounts/${encodeURIComponent(accountId)}/messages/${reply?.id}`,
  );
  expect(deleted.status).toBe(200);
  await EventBus.instance.idle();

  expect(await stream.drainToMarker()).toEqual([
    { type: "changed", accountId, conversationKey, revision: 3, rewriteRevision: 3 },
  ]);
  await stream.close();
});

test("a dead-lettered turn request turns typing off; a dead letter of another event sends nothing", async () => {
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = `bella:${accountId}`;
  const stream = await openStream();

  await publishDeadLetter(conversationKey, EEventType.ConversationChanged);
  await EventBus.instance.idle();
  expect(await stream.drainToMarker()).toEqual([]);

  await publishDeadLetter(conversationKey, EEventType.TurnRequested);
  await EventBus.instance.idle();
  expect(await stream.drainToMarker()).toEqual([
    { type: "typing", accountId, conversationKey, typing: false },
  ]);
  await stream.close();
});

test("the stream needs the secret, and an aborted connection releases its listener", async () => {
  await start();
  const refused = await handleInternalApiRequest(
    new Request(`http://internal${GATEWAY_STREAM_PATH}`),
    TEST_SECRET,
  );
  expect(refused.status).toBe(401);

  const aborted = new AbortController();
  await handleInternalApiRequest(
    new Request(`http://internal${GATEWAY_STREAM_PATH}`, {
      headers: { Authorization: `Bearer ${TEST_SECRET}` },
      signal: aborted.signal,
    }),
    TEST_SECRET,
  );
  expect(listeners()).toBe(1);
  aborted.abort();
  expect(listeners()).toBe(0);
});
