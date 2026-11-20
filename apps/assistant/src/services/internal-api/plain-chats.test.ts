import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  conversationSummariesTable,
  conversationsTable,
  EConversationKind,
  EEventType,
  eventsTable,
  factsTable,
  listConversations,
  listHistory,
  memoriesTable,
} from "@bellaclaw/database";
import {
  dashboardAccountConversationMessagesPath,
  dashboardAccountConversationPath,
  dashboardAccountConversationsPath,
  type TDashboardStreamEvent,
} from "@bellaclaw/shared";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { asc, eq } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { setupAiAuth } from "../ai/auth";
import { decodeAiModelPreferences } from "../ai/model-preferences";
import { aiModels } from "../ai/providers/registry";
import { EAiProvider } from "../ai/types";
import { AppStream } from "../app-stream";
import { AuthorizationService } from "../authorization";
import { Commands } from "../commands";
import { ConversationStore } from "../conversation";
import { DatabaseConnector } from "../database";
import { resetEventTables, resetIdentityLinksTable } from "../database/test-utils";
import { EventBus } from "../events";
import { IdentityService } from "../identity";
import { FactDistiller } from "../memory/distill";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { handleInternalApiRequest, setupInternalApi } from ".";

const SECRET = "internal-secret";
const NOT_FOUND = { error: "Not found" };
const GPT = { provider: "openrouter", model: "openai/gpt-5", effort: "low" };
const HAIKU = { provider: "openrouter", model: "anthropic/claude-haiku-4.5", effort: "off" };

type TRunArgs = Parameters<AgentHarness["runMain"]>[0];

const previousOpenrouterKey = Bun.env.OPENROUTER_API_KEY;

function reset() {
  for (const service of [
    EventBus,
    MessageHandler,
    MessagingAdapter,
    Commands,
    AuthorizationService,
    IdentityService,
    SettingsService,
    FactDistiller,
    AppStream,
  ]) {
    Object.assign(service, { _instance: undefined });
  }
}

beforeEach(async () => {
  Bun.env.OPENROUTER_API_KEY = "openrouter-test-key";
  reset();
  await resetEventTables();
  await resetIdentityLinksTable();
});

afterEach(async () => {
  await EventBus.instance.idle();
  await EventBus.instance.stop();
  await resetIdentityLinksTable();
  reset();
  Bun.env.OPENROUTER_API_KEY = previousOpenrouterKey;
});

function reply(args: TRunArgs, text: string) {
  const messages: Message[] = [
    ...(args.conversation?.entries.map((entry) => entry.message) ?? []),
    { role: "user", content: args.prompt, timestamp: Date.now() },
    fauxAssistantMessage(text),
  ];
  return { text, iterations: 1, toolCallCount: 0, stopReason: "completed", messages };
}

// the pipeline from the internal API to the transcript and Memory on a fresh bus, with a scripted
// model: the Bella agent and the plain agent answer apart. Memory distils a fact from every user
// message it reads; streamed: what the app stream sent. storedSettings: Settings and the AI auth
// diagnosis run for real instead of every owner reading the default settings
async function start(
  runPlain = mock(async (args: TRunArgs) => reply(args, `Plain reply to ${args.prompt}`)),
  storedSettings = false,
) {
  if (storedSettings) {
    SettingsService.instance.setup();
    setupAiAuth();
  } else {
    Object.assign(SettingsService, {
      _instance: { getAll: mock(async () => DefaultConfigRecord) },
    });
  }
  const runMain = mock(async (args: TRunArgs) => reply(args, `Bella reply to ${args.prompt}`));
  Object.assign(MessageHandler.instance, {
    ai: { runMain, runPlain, compactConversation: mock(async () => undefined) },
  });
  Object.assign(FactDistiller.instance, {
    distill: mock(async (window: { messages: { id: number; author: string }[] }) =>
      window.messages
        .filter((message) => message.author === "user")
        .map((message) => ({ text: "The user lives in Krakow.", sourceMessageId: message.id })),
    ),
    embedding: {
      embedMany: mock(async (texts: string[]) => texts.map(() => Array(768).fill(0.1))),
    },
  });
  const streamed: TDashboardStreamEvent[] = [];
  AppStream.instance.setup();
  AppStream.instance.listen((event) => streamed.push(event));
  MessageHandler.instance.setup();
  Commands.instance.setup();
  MessagingAdapter.instance.setup();
  FactDistiller.instance.setup();
  setupInternalApi();
  await IdentityService.instance.setup();
  await AuthorizationService.instance.setup();
  await EventBus.instance.start();
  return { runMain, runPlain, streamed };
}

async function request(method: string, path: string, body?: unknown) {
  const response = await handleInternalApiRequest(
    new Request(`http://internal${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    }),
    SECRET,
  );
  const answer: [number, unknown] = [response.status, await response.json()];
  await EventBus.instance.idle();
  return answer;
}

async function createChat(accountId: string): Promise<string> {
  const [status, body] = await request("POST", dashboardAccountConversationsPath(accountId));
  expect(status).toBe(200);
  expect(body).toEqual({ conversationKey: expect.any(String), createdAt: expect.any(Number) });
  return (body as { conversationKey: string }).conversationKey;
}

function send(accountId: string, conversationKey: string, body: unknown) {
  return request(
    "POST",
    dashboardAccountConversationMessagesPath(accountId, conversationKey),
    body,
  );
}

function account(accountId: string) {
  return { conversationKey: `bella:${accountId}`, ownerKey: `account:${accountId}` };
}

function history(conversationKey: string) {
  return listHistory(DatabaseConnector.instance.database, conversationKey, undefined, 50);
}

function factsOf(ownerKey: string) {
  return DatabaseConnector.instance.database
    .select({ text: factsTable.text })
    .from(factsTable)
    .where(eq(factsTable.chatId, ownerKey));
}

async function eventsOf(type: EEventType) {
  return DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, type))
    .orderBy(asc(eventsTable.seq));
}

test("the app creates a plain chat, lists it, sends with a model, reads the plain agent's reply, deletes it and finds it gone", async () => {
  const { runMain, runPlain, streamed } = await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const keys = account(accountId);
  const chat = await createChat(accountId);

  expect(chat.startsWith(`plain:${accountId}:`)).toBe(true);
  expect(
    (await listConversations(DatabaseConnector.instance.database, keys)).map((row) => [
      row.conversationKey,
      row.kind,
      row.revision,
    ]),
  ).toEqual([
    [keys.conversationKey, EConversationKind.Bella, 0],
    [chat, EConversationKind.Plain, 0],
  ]);

  expect(
    await send(accountId, chat, { clientMessageId: "m-1", text: "Hello", model: GPT }),
  ).toEqual([200, { clientMessageId: "m-1" }]);
  expect(runMain).not.toHaveBeenCalled();
  expect(runPlain).toHaveBeenCalledTimes(1);
  const used = runPlain.mock.calls[0]?.[0];
  expect([
    used?.settings[EConfigKey.AiProvider],
    used?.model?.model.provider,
    used?.model?.model.id,
    used?.model?.effort,
  ]).toEqual(["openrouter", "openrouter", GPT.model, "low"]);
  expect(await history(chat)).toMatchObject([
    { author: "user", kind: "message", channel: "app", text: "Hello", clientMessageId: "m-1" },
    { author: "assistant", kind: "message", channel: "app", text: "Plain reply to Hello" },
  ]);

  // the Bella conversation keeps the account's settings and refuses a model
  expect(
    await send(accountId, keys.conversationKey, { clientMessageId: "b-1", text: "Hi", model: GPT }),
  ).toEqual([400, { error: "The Bella conversation runs on the account's model settings" }]);
  await send(accountId, keys.conversationKey, { clientMessageId: "b-2", text: "Hi" });
  expect(runMain.mock.calls[0]?.[0].settings).toBe(DefaultConfigRecord);

  const [status, body] = await request("DELETE", dashboardAccountConversationPath(accountId, chat));
  expect([status, body]).toEqual([200, { conversationKey: chat }]);
  expect(streamed).toContainEqual({ type: "deleted", accountId, conversationKey: chat });
  expect(
    (await listConversations(DatabaseConnector.instance.database, keys)).map(
      (row) => row.conversationKey,
    ),
  ).toEqual([keys.conversationKey]);

  // gone: reading, sending and deleting answer as for a conversation that never existed
  expect(
    await send(accountId, chat, { clientMessageId: "m-2", text: "Again", model: GPT }),
  ).toEqual([404, NOT_FOUND]);
  expect(await request("DELETE", dashboardAccountConversationPath(accountId, chat))).toEqual([
    404,
    NOT_FOUND,
  ]);
  expect(await history(chat)).toEqual([]);
});

test("a send to a plain chat names a model the server offers, with an effort the model supports", async () => {
  const { runPlain } = await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const chat = await createChat(accountId);
  const answers = [];

  for (const model of [
    undefined,
    { ...GPT, provider: "elsewhere" },
    { ...GPT, model: "no-such-model" },
    { ...GPT, effort: "max" },
  ]) {
    answers.push(await send(accountId, chat, { clientMessageId: "m-1", text: "Hello", model }));
  }

  expect(answers).toEqual([
    [400, { error: "A message to a plain chat names its model" }],
    [400, { error: "Unknown AI provider: elsewhere" }],
    [400, { error: 'Model "no-such-model" is not available from provider "openrouter"' }],
    [400, { error: "Effort max is unsupported by openai/gpt-5" }],
  ]);
  expect(await eventsOf(EEventType.MessageReceived)).toEqual([]);
  expect(runPlain).not.toHaveBeenCalled();
});

test("a repeated send of a stored message is answered the same after its provider became unusable", async () => {
  const { runPlain } = await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const chat = await createChat(accountId);
  const message = { clientMessageId: "m-1", text: "Hi", model: GPT };

  const first = await send(accountId, chat, message);
  await EventBus.instance.idle();
  delete Bun.env.OPENROUTER_API_KEY;
  const repeated = await send(accountId, chat, message);
  await EventBus.instance.idle();

  expect(first).toEqual([200, { clientMessageId: "m-1" }]);
  expect(repeated).toEqual(first);
  expect(runPlain).toHaveBeenCalledTimes(1);
});

test("a send to a plain chat names a provider the server can use now, else it answers 400 and stores nothing", async () => {
  const { runPlain } = await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const chat = await createChat(accountId);
  const getAuth = spyOn(aiModels, "getAuth").mockResolvedValue(undefined);
  const answers = [];

  try {
    delete Bun.env.OPENROUTER_API_KEY;
    answers.push(await send(accountId, chat, { clientMessageId: "m-1", text: "Hi", model: GPT }));
    answers.push(
      await send(accountId, chat, {
        clientMessageId: "m-2",
        text: "Hi",
        model: { provider: "opencode-go", model: "grok-4.7", effort: "high" },
      }),
    );
  } finally {
    getAuth.mockRestore();
  }

  expect(answers).toEqual([
    [400, { error: "Missing required environment variable OPENROUTER_API_KEY" }],
    [400, { error: "opencode-go is not connected." }],
  ]);
  expect(await eventsOf(EEventType.MessageReceived)).toEqual([]);
  expect(await history(chat)).toEqual([]);
  expect(runPlain).not.toHaveBeenCalled();
});

test("a plain chat's failed turn answers the failure reply and leaves the account's provider and models as they are", async () => {
  const keys = { provider: EConfigKey.AiProvider, preferences: EConfigKey.AiModelPreferences };
  let expired = false;
  const getAuth = spyOn(aiModels, "getAuth").mockImplementation((async (provider: string) => {
    // the chosen provider's login expires during the turn; another one stays connected
    if (provider === EAiProvider.OpencodeGo && expired) {
      return undefined;
    }

    return { apiKey: "test" };
  }) as typeof aiModels.getAuth);
  const refresh = spyOn(aiModels, "refresh").mockResolvedValue({
    errors: new Map(),
    aborted: false,
  } as unknown as Awaited<ReturnType<typeof aiModels.refresh>>);
  const runPlain = mock(async (args: TRunArgs) => {
    expired = true;
    // no final response
    return { ...reply(args, ""), text: undefined as unknown as string };
  });

  try {
    await start(runPlain, true);
    const accountId = `acct-${crypto.randomUUID()}`;
    const { ownerKey } = account(accountId);
    const chat = await createChat(accountId);
    const before = await SettingsService.instance.getAll(ownerKey);

    expect(
      await send(accountId, chat, {
        clientMessageId: "m-1",
        text: "Hello",
        model: { provider: "opencode-go", model: "grok-4.7", effort: "high" },
      }),
    ).toEqual([200, { clientMessageId: "m-1" }]);

    const after = await SettingsService.instance.getAll(ownerKey);
    expect(runPlain).toHaveBeenCalledTimes(1);
    expect(after[keys.provider]).toBe(before[keys.provider]);
    expect(decodeAiModelPreferences(after[keys.preferences])).toEqual(
      decodeAiModelPreferences(before[keys.preferences]),
    );
    expect(await eventsOf(EEventType.AiAuthDiagnoseRequested)).toEqual([]);
    expect((await history(chat)).map((row) => [row.author, row.text])).toEqual([
      ["user", "Hello"],
      ["assistant", "Something went wrong."],
    ]);
  } finally {
    getAuth.mockRestore();
    refresh.mockRestore();
  }
});

test("a plain chat's turn whose model left the catalog after the send was accepted fails with a reply naming the model and runs no model", async () => {
  const keys = { provider: EConfigKey.AiProvider, preferences: EConfigKey.AiModelPreferences };
  const running = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let gone = false;
  const getModel = aiModels.getModel.bind(aiModels);
  const getModelSpy = spyOn(aiModels, "getModel").mockImplementation(((
    provider: string,
    modelId: string,
  ) => {
    if (gone && modelId === GPT.model) {
      return undefined;
    }

    return getModel(provider, modelId);
  }) as typeof aiModels.getModel);
  // the first turn is slow: the second send is accepted and waits behind it on the chat's lane
  const runPlain = mock(async (args: TRunArgs) => {
    running.resolve();
    await release.promise;
    return reply(args, `Plain reply to ${args.prompt}`);
  });

  try {
    await start(runPlain, true);
    const accountId = `acct-${crypto.randomUUID()}`;
    const { ownerKey } = account(accountId);
    const chat = await createChat(accountId);
    const before = await SettingsService.instance.getAll(ownerKey);

    const first = send(accountId, chat, { clientMessageId: "m-1", text: "One", model: GPT });
    await running.promise;
    const second = await handleInternalApiRequest(
      new Request(`http://internal${dashboardAccountConversationMessagesPath(accountId, chat)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ clientMessageId: "m-2", text: "Two", model: GPT }),
      }),
      SECRET,
    );
    expect([second.status, await second.json()]).toEqual([200, { clientMessageId: "m-2" }]);

    gone = true;
    release.resolve();
    expect(await first).toEqual([200, { clientMessageId: "m-1" }]);
    await EventBus.instance.idle();

    expect(runPlain).toHaveBeenCalledTimes(1);
    expect((await history(chat)).map((row) => [row.author, row.text])).toEqual([
      ["user", "One"],
      ["assistant", "Plain reply to One"],
      ["user", "Two"],
      [
        "assistant",
        `The model ${GPT.model} is no longer available from openrouter. Choose another model and send again.`,
      ],
    ]);
    expect((await eventsOf(EEventType.TurnFailed)).map((event) => event.payload)).toMatchObject([
      { conversationKey: chat, reason: "no_final_response" },
    ]);
    const after = await SettingsService.instance.getAll(ownerKey);
    expect(after[keys.provider]).toBe(before[keys.provider]);
    expect(decodeAiModelPreferences(after[keys.preferences])).toEqual(
      decodeAiModelPreferences(before[keys.preferences]),
    );
  } finally {
    getModelSpy.mockRestore();
  }
});

test("another account's plain chat is answered like one that does not exist, for sending and deleting", async () => {
  const { runPlain } = await start();
  const alice = `acct-${crypto.randomUUID()}`;
  const bob = `acct-${crypto.randomUUID()}`;
  const chat = await createChat(alice);
  await send(alice, chat, { clientMessageId: "m-1", text: "Secret", model: GPT });

  expect(await send(bob, chat, { clientMessageId: "m-2", text: "Hi", model: GPT })).toEqual([
    404,
    NOT_FOUND,
  ]);
  expect(await request("DELETE", dashboardAccountConversationPath(bob, chat))).toEqual([
    404,
    NOT_FOUND,
  ]);
  // the Bella conversation is no plain chat: it cannot be deleted
  expect(
    await request(
      "DELETE",
      dashboardAccountConversationPath(alice, account(alice).conversationKey),
    ),
  ).toEqual([404, NOT_FOUND]);
  // both are refused before a command reaches a lane
  expect(await eventsOf(EEventType.ConversationDeleteRequested)).toEqual([]);
  expect(runPlain).toHaveBeenCalledTimes(1);
  expect((await history(chat)).map((row) => row.text)).toEqual(["Secret", "Plain reply to Secret"]);
});

test("! messages in a plain chat reach the model as text", async () => {
  const { runPlain } = await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const chat = await createChat(accountId);

  await send(accountId, chat, { clientMessageId: "m-1", text: "!help", model: GPT });
  // a command in the Bella conversation, plain text here
  await send(accountId, chat, { clientMessageId: "m-2", text: "!update", model: GPT });

  expect(runPlain.mock.calls.map(([args]) => args.prompt)).toEqual(["!help", "!update"]);
  expect((await history(chat)).map((row) => [row.kind, row.text])).toEqual([
    ["message", "!help"],
    ["message", "Plain reply to !help"],
    ["message", "!update"],
    ["message", "Plain reply to !update"],
  ]);
});

test("two plain chats run their turns at the same time, each on the model its message carried", async () => {
  const running = Promise.withResolvers<void>();
  const started: string[] = [];
  const models = new Map<string, string>();
  const runPlain = mock(async (args: TRunArgs) => {
    started.push(args.conversationKey ?? "");
    models.set(args.conversationKey ?? "", `${args.model?.model.id}/${args.model?.effort}`);

    // each turn finishes only once both are running: a shared lane would never get there
    if (started.length === 2) {
      running.resolve();
    }

    await running.promise;
    return reply(args, `Plain reply to ${args.prompt}`);
  });
  await start(runPlain);
  const accountId = `acct-${crypto.randomUUID()}`;
  const first = await createChat(accountId);
  const second = await createChat(accountId);

  await Promise.all([
    send(accountId, first, { clientMessageId: "m-1", text: "One", model: GPT }),
    send(accountId, second, { clientMessageId: "m-1", text: "Two", model: HAIKU }),
  ]);

  expect(started.sort()).toEqual([first, second].sort());
  expect(models.get(first)).toBe(`${GPT.model}/low`);
  expect(models.get(second)).toBe(`${HAIKU.model}/off`);
  expect((await history(first)).map((row) => row.text)).toEqual(["One", "Plain reply to One"]);
  expect((await history(second)).map((row) => row.text)).toEqual(["Two", "Plain reply to Two"]);
});

test("a plain chat's personal fact adds no fact, also after a restart, while the Bella conversation's does", async () => {
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const keys = account(accountId);
  const chat = await createChat(accountId);

  await send(accountId, chat, { clientMessageId: "m-1", text: "I live in Krakow", model: GPT });
  expect(await factsOf(keys.ownerKey)).toEqual([]);

  // the control: the same message in the Bella conversation becomes a fact
  await send(accountId, keys.conversationKey, { clientMessageId: "m-2", text: "I live in Krakow" });
  expect(await factsOf(keys.ownerKey)).toEqual([{ text: "The user lives in Krakow." }]);

  // a restart: the boot catch-up drains every stored conversation but the plain chat
  expect(await ConversationStore.instance.findChatIds()).toContain(keys.conversationKey);
  expect(await ConversationStore.instance.findChatIds()).not.toContain(chat);
  await EventBus.instance.publish({
    type: EEventType.AppStarted,
    source: "test",
    key: "global",
    trace: { turnId: "test:boot", chatId: undefined, platform: undefined },
    payload: {},
    causationId: undefined,
    dedupeKey: undefined,
  });
  await EventBus.instance.idle();

  const refreshed = (await eventsOf(EEventType.MemoryFactsRefreshRequested)).map(
    (event) => event.key,
  );
  expect(refreshed).toContain(keys.conversationKey);
  expect(refreshed).not.toContain(chat);
  expect(await factsOf(keys.ownerKey)).toEqual([{ text: "The user lives in Krakow." }]);
});

test("deleting a plain chat leaves no transcript rows, summary or registry entry for it, and a late turn or reply stores nothing", async () => {
  const { runPlain } = await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const chat = await createChat(accountId);
  await send(accountId, chat, { clientMessageId: "m-1", text: "Hello", model: GPT });
  await ConversationStore.instance.saveSummary(chat, {
    summary: "An earlier talk",
    summaryTimestamp: 1_000,
    summarizedThroughId: 1,
    entries: [],
  });
  const db = DatabaseConnector.instance.database;
  const rowsOf = async () => [
    (await db.select().from(memoriesTable).where(eq(memoriesTable.chatId, chat))).length,
    (
      await db
        .select()
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.chatId, chat))
    ).length,
    (await db.select().from(conversationsTable).where(eq(conversationsTable.conversationKey, chat)))
      .length,
  ];
  expect(await rowsOf()).toEqual([2, 1, 1]);

  expect(await request("DELETE", dashboardAccountConversationPath(accountId, chat))).toEqual([
    200,
    { conversationKey: chat },
  ]);
  expect(await rowsOf()).toEqual([0, 0, 0]);

  // a turn and a failure reply that reach the chat's lane after the delete store nothing
  await EventBus.instance.publish({
    type: EEventType.TurnRequested,
    source: "test",
    key: chat,
    trace: { turnId: "test:late-turn", chatId: chat, platform: EMessagePlatform.App },
    payload: {
      conversationKey: chat,
      ownerKey: `account:${accountId}`,
      channel: EMessagePlatform.App,
      replyAddress: accountId,
      kind: EConversationKind.Plain,
      content: "Late",
      attachments: [],
      receivedAt: Date.now(),
      model: { provider: EAiProvider.Openrouter, model: GPT.model, effort: "low" },
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await EventBus.instance.publish({
    type: EEventType.MessageSent,
    source: "test",
    key: chat,
    trace: { turnId: "test:late", chatId: chat, platform: undefined },
    payload: {
      chatId: chat,
      channel: EMessagePlatform.App,
      sourceType: EEventType.ReplyReady,
      chars: 5,
      sentAt: Date.now(),
      display: { text: "Late" },
    },
    causationId: undefined,
    dedupeKey: undefined,
  });
  await EventBus.instance.idle();
  expect(await rowsOf()).toEqual([0, 0, 0]);
  expect(runPlain).toHaveBeenCalledTimes(1);
  expect(
    await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.ownerKey, `account:${accountId}`)),
  ).toEqual([]);
});
