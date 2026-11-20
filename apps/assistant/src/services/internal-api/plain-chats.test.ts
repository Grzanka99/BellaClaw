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
  gatewayAccountConversationMessagesPath,
  gatewayAccountConversationPath,
  gatewayAccountConversationsPath,
  gatewayAccountModelsPath,
  type TGatewayModelCatalog,
  type TGatewayStreamEvent,
  type TOption,
} from "@bellaclaw/shared";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { asc, eq } from "drizzle-orm";
import type { AgentHarness } from "../ai/agent-harness";
import { setupAiAuth } from "../ai/auth";
import type { LlmClient } from "../ai/llm";
import { decodeAiModelPreferences } from "../ai/model-preferences";
import { aiModels } from "../ai/providers/registry";
import { EAiProvider, EModelPurpose } from "../ai/types";
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
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { handleInternalApiRequest, setupInternalApi } from ".";

const SECRET = "internal-secret";
const NOT_FOUND = { error: "Not found" };
const GPT = { provider: "openrouter", model: "openai/gpt-5", effort: "low" };
const HAIKU = { provider: "openrouter", model: "anthropic/claude-haiku-4.5", effort: "off" };

type TRunArgs = Parameters<AgentHarness["runMain"]>[0];
type TCompleteTextArgs = Parameters<LlmClient["completeText"]>[0];

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
// diagnosis run for real instead of every owner reading the default settings. completeText: the
// Utility call that writes a plain chat's title
async function start(
  runPlain = mock(async (args: TRunArgs) => reply(args, `Plain reply to ${args.prompt}`)),
  storedSettings = false,
  completeText = mock(async (_args: TCompleteTextArgs): Promise<TOption<string>> => "Trip plans"),
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
    llm: { completeText },
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
  const streamed: TGatewayStreamEvent[] = [];
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
  return { runMain, runPlain, completeText, streamed };
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
  const [status, body] = await request("POST", gatewayAccountConversationsPath(accountId));
  expect(status).toBe(200);
  expect(body).toEqual({ conversationKey: expect.any(String), createdAt: expect.any(Number) });
  return (body as { conversationKey: string }).conversationKey;
}

function send(accountId: string, conversationKey: string, body: unknown) {
  return request("POST", gatewayAccountConversationMessagesPath(accountId, conversationKey), body);
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

  const [status, body] = await request("DELETE", gatewayAccountConversationPath(accountId, chat));
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
  expect(await request("DELETE", gatewayAccountConversationPath(accountId, chat))).toEqual([
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

test("the models list offers every provider with its models and efforts, and why a send cannot use one now", async () => {
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const getAuth = spyOn(aiModels, "getAuth").mockResolvedValue(undefined);
  let answer: [number, unknown];

  try {
    answer = await request("GET", gatewayAccountModelsPath(accountId));
  } finally {
    getAuth.mockRestore();
  }

  const [status, body] = answer;
  expect(status).toBe(200);
  const { providers } = body as TGatewayModelCatalog;
  expect(providers.map((provider) => provider.id)).toEqual(Object.values(EAiProvider));

  const openrouter = providers.find((provider) => provider.id === EAiProvider.Openrouter);
  expect(openrouter).toMatchObject({ usable: true });
  expect(openrouter?.reason).toBeUndefined();
  expect(openrouter?.models.find((model) => model.id === GPT.model)?.supportedEfforts).toContain(
    "low",
  );

  const opencodeGo = providers.find((provider) => provider.id === EAiProvider.OpencodeGo);
  expect(opencodeGo).toMatchObject({ usable: false, reason: "opencode-go is not connected." });
  expect(opencodeGo?.models.map((model) => model.id)).toContain("grok-4.7");
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
  expect(await request("DELETE", gatewayAccountConversationPath(bob, chat))).toEqual([
    404,
    NOT_FOUND,
  ]);
  // the Bella conversation is no plain chat: it cannot be deleted
  expect(
    await request("DELETE", gatewayAccountConversationPath(alice, account(alice).conversationKey)),
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

test("deleting a plain chat leaves no transcript rows, summary or registry entry for it", async () => {
  await start();
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

  expect(await request("DELETE", gatewayAccountConversationPath(accountId, chat))).toEqual([
    200,
    { conversationKey: chat },
  ]);
  expect(await rowsOf()).toEqual([0, 0, 0]);

  expect(
    await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.ownerKey, `account:${accountId}`)),
  ).toEqual([]);
});

async function titleOf(conversationKey: string) {
  const row = await DatabaseConnector.instance.database
    .select({ title: conversationsTable.title, revision: conversationsTable.revision })
    .from(conversationsTable)
    .where(eq(conversationsTable.conversationKey, conversationKey))
    .get();
  return row;
}

test("the first reply of a plain chat writes one title, which the stream announces and the list shows; later turns keep it", async () => {
  const { runMain, completeText, streamed } = await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const keys = account(accountId);
  const chat = await createChat(accountId);

  await send(accountId, chat, { clientMessageId: "m-1", text: "Plan a trip", model: GPT });

  expect(completeText).toHaveBeenCalledTimes(1);
  const titleCall = completeText.mock.calls[0]?.[0];
  expect(titleCall?.purpose).toBe(EModelPurpose.Utility);
  expect(titleCall?.settings).toBe(DefaultConfigRecord);
  expect(JSON.parse(titleCall?.prompt ?? "")).toEqual({
    message: "Plan a trip",
    reply: "Plain reply to Plan a trip",
  });
  const titled = await titleOf(chat);
  expect(titled?.title).toBe("Trip plans");
  // the title raised the revision after the turn's, and the stream carried it
  expect(streamed.filter((event) => event.type === "changed").at(-1)).toEqual({
    type: "changed",
    accountId,
    conversationKey: chat,
    revision: titled?.revision ?? 0,
    rewriteRevision: 0,
  });
  expect(
    (await listConversations(DatabaseConnector.instance.database, keys)).map((row) => [
      row.conversationKey,
      row.title,
    ]),
  ).toEqual([
    [keys.conversationKey, undefined],
    [chat, "Trip plans"],
  ]);

  // a second turn and the Bella conversation call nothing
  completeText.mockImplementation(async () => "Another title");
  await send(accountId, chat, { clientMessageId: "m-2", text: "And hotels?", model: GPT });
  await send(accountId, keys.conversationKey, { clientMessageId: "b-1", text: "Hi" });
  expect(runMain).toHaveBeenCalledTimes(1);
  expect(completeText).toHaveBeenCalledTimes(1);
  expect((await titleOf(chat))?.title).toBe("Trip plans");
});

test("a plain chat whose first turn fails takes its title from the next completed turn", async () => {
  const runPlain = mock(async (args: TRunArgs) => reply(args, `Plain reply to ${args.prompt}`));
  runPlain.mockImplementationOnce(async () => {
    throw new Error("provider down");
  });
  const { completeText } = await start(runPlain);
  const accountId = `acct-${crypto.randomUUID()}`;
  const chat = await createChat(accountId);

  await send(accountId, chat, { clientMessageId: "m-1", text: "Hello", model: GPT });
  expect(await eventsOf(EEventType.TurnFailed)).toHaveLength(1);
  expect(completeText).toHaveBeenCalledTimes(0);

  completeText.mockImplementation(async () => "Trip plans");
  await send(accountId, chat, { clientMessageId: "m-2", text: "Plan a trip", model: GPT });
  expect(completeText).toHaveBeenCalledTimes(1);
  expect(JSON.parse(completeText.mock.calls[0]?.[0].prompt ?? "")).toEqual({
    message: "Plan a trip",
    reply: "Plain reply to Plan a trip",
  });
  expect((await titleOf(chat))?.title).toBe("Trip plans");
});

test("a failed or empty title call leaves the plain chat untitled and usable, with no dead letter", async () => {
  const completeText = mock(async (_args: TCompleteTextArgs): Promise<TOption<string>> => {
    throw new Error("provider down");
  });
  const { runPlain } = await start(undefined, false, completeText);
  const accountId = `acct-${crypto.randomUUID()}`;
  const chat = await createChat(accountId);
  const empty = await createChat(accountId);

  await send(accountId, chat, { clientMessageId: "m-1", text: "Hello", model: GPT });
  completeText.mockImplementation(async () => undefined);
  await send(accountId, empty, { clientMessageId: "m-1", text: "Hello", model: GPT });
  await send(accountId, chat, { clientMessageId: "m-2", text: "Still there?", model: GPT });

  expect(runPlain).toHaveBeenCalledTimes(3);
  expect(completeText).toHaveBeenCalledTimes(3);
  expect((await titleOf(chat))?.title).toBeNull();
  expect((await titleOf(empty))?.title).toBeNull();
  expect(await eventsOf(EEventType.EventDeadLettered)).toEqual([]);
  expect((await history(chat)).map((row) => row.text)).toEqual([
    "Hello",
    "Plain reply to Hello",
    "Still there?",
    "Plain reply to Still there?",
  ]);
});
