import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appMediaTable,
  EEventType,
  eventsTable,
  listHistory,
  type THistoryMessage,
} from "@bellaclaw/database";
import {
  gatewayAccountConversationMediaFilePath,
  gatewayAccountConversationMediaPath,
  gatewayAccountConversationMessagesPath,
  gatewayAccountConversationPath,
  gatewayAccountConversationsPath,
  gatewayAccountMessagePath,
  MAX_IMAGE_BYTES,
} from "@bellaclaw/shared";
import {
  fauxAssistantMessage,
  fauxProvider,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { eq } from "drizzle-orm";
import { AgentHarness } from "../ai/agent-harness";
import { aiModels } from "../ai/providers/registry";
import { EAiProvider } from "../ai/types";
import { AppChannel } from "../app";
import { AuthorizationService } from "../authorization";
import { Commands } from "../commands";
import type { TConversation } from "../conversation/types";
import { DatabaseConnector } from "../database";
import { ESubscriptionMode, EventBus } from "../events";
import { IdentityService } from "../identity";
import { MessageHandler } from "../message-handler";
import { MessagingAdapter } from "../messaging";
import { EMessagePlatform } from "../messaging/types";
import { SettingsService } from "../settings";
import { DefaultConfigRecord, EConfigKey } from "../settings/schema";
import { setupInternalApi } from ".";
import { internalRequest, resetServices } from "./test-utils";

const MODEL = "google/gemini-3.1-pro-preview";
const NO_VISION_NOTE = "[User sent an image; the current model cannot view images]";
// a PNG's signature and some bytes
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);

const previousMediaDir = Bun.env.BELLACLAW_APP_MEDIA_DIR;
const previousApiKey = Bun.env.OPENROUTER_API_KEY;
const previousProvider = aiModels.getProvider(EAiProvider.Openrouter);
let mediaDir = "";

type TBody = RequestInit["body"];

resetServices([
  EventBus,
  MessageHandler,
  MessagingAdapter,
  Commands,
  AuthorizationService,
  IdentityService,
  SettingsService,
  AppChannel,
]);

beforeAll(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "bellaclaw-app-media-"));
  Bun.env.BELLACLAW_APP_MEDIA_DIR = mediaDir;
  Bun.env.OPENROUTER_API_KEY = "openrouter-test-key";
});

afterAll(async () => {
  await rm(mediaDir, { recursive: true, force: true });
  Bun.env.BELLACLAW_APP_MEDIA_DIR = previousMediaDir;
  Bun.env.OPENROUTER_API_KEY = previousApiKey;

  if (previousProvider !== undefined) {
    aiModels.setProvider(previousProvider);
  }
});

// the model as a faux OpenRouter, with or without vision; contexts: what each request carried
function useModel(vision: boolean) {
  const input: ("text" | "image")[] = ["text"];
  if (vision) {
    input.push("image");
  }
  const faux = fauxProvider({
    provider: EAiProvider.Openrouter,
    models: [{ id: MODEL, reasoning: true, input }],
  });
  const contexts: TranscriptContext[] = [];
  faux.setResponses(
    Array.from({ length: 10 }, () => (context: TranscriptContext) => {
      contexts.push(structuredClone(context));
      return fauxAssistantMessage("I see");
    }),
  );
  aiModels.setProvider(faux.provider);
  return contexts;
}

// the pipeline from the internal API to Outbound on a fresh bus, with the App channel's store and
// the real agent harness on the faux model. compactConversation: none by default
async function start(
  compactConversation: (state: TConversation) => Promise<unknown> = async () => undefined,
) {
  Object.assign(SettingsService, {
    _instance: {
      getAll: mock(async () => ({
        ...DefaultConfigRecord,
        [EConfigKey.AiProvider]: EAiProvider.Openrouter,
      })),
    },
  });
  const runPlain = mock(async (args: Parameters<AgentHarness["runPlain"]>[0]) => {
    const messages: Message[] = [
      { role: "user", content: args.prompt, timestamp: Date.now() },
      fauxAssistantMessage("Plain reply"),
    ];
    return {
      text: "Plain reply",
      iterations: 1,
      toolCallCount: 0,
      stopReason: "completed",
      messages,
    };
  });
  Object.assign(MessageHandler.instance, {
    ai: {
      runMain: (args: Parameters<AgentHarness["runMain"]>[0]) =>
        AgentHarness.instance.runMain(args),
      runPlain,
      compactConversation,
    },
    llm: { completeText: mock(async () => "Title") },
  });
  await AppChannel.instance.setup();
  MessageHandler.instance.setup();
  Commands.instance.setup();
  MessagingAdapter.instance.setup();
  setupInternalApi();
  await IdentityService.instance.setup();
  await AuthorizationService.instance.setup();
  await EventBus.instance.start();
}

async function request(method: string, path: string, body: TBody, contentType: string) {
  const response = await internalRequest(method, path, body, { "Content-Type": contentType });
  await EventBus.instance.idle();
  return response;
}

async function upload(accountId: string, conversationKey: string, data: TBody, type: string) {
  const response = await request(
    "POST",
    gatewayAccountConversationMediaPath(accountId, conversationKey),
    data,
    type,
  );
  return [response.status, await response.json()];
}

async function uploaded(accountId: string, conversationKey: string) {
  const [status, media] = await upload(accountId, conversationKey, PNG, "image/png");
  expect(status).toBe(200);
  expect(media).toEqual({ id: expect.any(String), mimeType: "image/png" });
  return media as { id: string; mimeType: string };
}

function download(accountId: string, conversationKey: string, mediaId: string) {
  return request(
    "GET",
    gatewayAccountConversationMediaFilePath(accountId, conversationKey, mediaId),
    null,
    "",
  );
}

async function send(accountId: string, conversationKey: string, body: unknown) {
  const response = await request(
    "POST",
    gatewayAccountConversationMessagesPath(accountId, conversationKey),
    JSON.stringify(body),
    "application/json",
  );
  return [response.status, await response.json()];
}

function bella(accountId: string) {
  return `bella:${accountId}`;
}

function history(conversationKey: string) {
  return listHistory(DatabaseConnector.instance.database, conversationKey, undefined, 50);
}

// the end of each turn compacts all of it; count: the compactions so far
function compactEverything() {
  const compaction = {
    count: 0,
    compact: async (state: TConversation) => {
      const last = state.entries.at(-1);

      if (last === undefined) {
        return undefined;
      }

      compaction.count += 1;

      return {
        state: {
          ...state,
          summary: "Summary",
          summaryTimestamp: Date.now(),
          summarizedThroughId: last.id,
          entries: [],
        },
        usage: {},
        tokensBefore: 0,
        tokensAfter: 0,
      };
    },
  };
  return compaction;
}

// the handler's model calls, to replace runMain in a test
function handlerAi(): { runMain: AgentHarness["runMain"] } {
  return Reflect.get(MessageHandler.instance, "ai");
}

function mediaRows() {
  return DatabaseConnector.instance.database.select().from(appMediaTable);
}

// no file or row of the image is left
async function expectMediaGone(mediaId: string) {
  expect(await readdir(mediaDir)).not.toContain(mediaId);
  expect((await mediaRows()).map((row) => row.id)).not.toContain(mediaId);
}

test("an uploaded image reaches the model in the turn as an image, a model without vision gets the text fallback", async () => {
  const withVision = useModel(true);
  // message.received loses its payload once delivered, so it is read as it is published
  const received: unknown[] = [];
  EventBus.instance.subscribe({
    consumer: "test",
    type: EEventType.MessageReceived,
    mode: ESubscriptionMode.Live,
    backoffMs: [],
    handler: async (event) => {
      received.push(event.payload);
    },
  });
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const media = await uploaded(accountId, bella(accountId));

  expect(
    await send(accountId, bella(accountId), {
      clientMessageId: "m-1",
      text: "What is this?",
      images: [media],
    }),
  ).toEqual([200, { clientMessageId: "m-1" }]);

  const image = { type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" };
  expect(withVision).toHaveLength(1);
  expect(JSON.stringify(withVision[0]?.messages)).toContain(JSON.stringify(image));

  // the next turn replays the image from history to a model that cannot view it
  const withoutVision = useModel(false);
  await send(accountId, bella(accountId), { clientMessageId: "m-2", text: "And now?" });
  expect(withoutVision).toHaveLength(1);
  expect(JSON.stringify(withoutVision[0]?.messages)).toContain(NO_VISION_NOTE);
  expect(JSON.stringify(withoutVision[0]?.messages)).not.toContain(image.data);

  expect(received).toMatchObject([
    {
      attachments: [
        {
          id: media.id,
          mimeType: "image/png",
          channel: EMessagePlatform.App,
          sourceAddress: accountId,
        },
      ],
    },
    { attachments: [] },
  ]);
});

test("the image downloads again until the third compaction deletes it; then the download answers gone and history shows the placeholder", async () => {
  useModel(true);
  const compaction = compactEverything();
  await start(compaction.compact);
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = bella(accountId);
  const media = await uploaded(accountId, conversationKey);
  await send(accountId, conversationKey, {
    clientMessageId: "m-1",
    text: "",
    images: [media],
  });
  expect(compaction.count).toBe(1);

  for (const attempt of [1, 2]) {
    const response = await download(accountId, conversationKey, media.id);
    expect([attempt, response.status, response.headers.get("Content-Type")]).toEqual([
      attempt,
      200,
      "image/png",
    ]);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  }

  expect((await history(conversationKey))[0]).toMatchObject({
    author: "user",
    text: "",
    images: [{ mediaId: media.id, mimeType: "image/png" }],
  });

  await send(accountId, conversationKey, { clientMessageId: "m-2", text: "Two" });
  expect(compaction.count).toBe(2);
  expect((await download(accountId, conversationKey, media.id)).status).toBe(200);

  // the third compaction drops the turn with the image
  await send(accountId, conversationKey, { clientMessageId: "m-3", text: "Three" });
  expect(compaction.count).toBe(3);
  const gone = await download(accountId, conversationKey, media.id);
  expect([gone.status, await gone.json()]).toEqual([410, { error: "Gone" }]);
  expect((await history(conversationKey))[0]).toMatchObject({
    author: "user",
    images: [{ mediaId: undefined, mimeType: "image/png" }],
  });
  await expectMediaGone(media.id);
});

test("an oversized, unsupported or mislabelled file is refused before anything is stored", async () => {
  useModel(true);
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = bella(accountId);
  const before = await readdir(mediaDir);
  const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
  oversized.set(PNG);
  // a body with no declared length, read up to the limit
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(PNG);
      controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES));
      controller.close();
    },
  });

  expect([
    await upload(accountId, conversationKey, oversized, "image/png"),
    await upload(accountId, conversationKey, stream, "image/png"),
    await upload(accountId, conversationKey, PNG, "image/bmp"),
    await upload(accountId, conversationKey, PNG, "application/pdf"),
    await upload(accountId, conversationKey, JPEG, "image/png"),
    await upload(accountId, conversationKey, "not an image", "image/gif"),
    await upload(accountId, conversationKey, new Uint8Array(), "image/webp"),
  ]).toEqual([
    [413, { error: "The image is larger than 5 MB" }],
    [413, { error: "The image is larger than 5 MB" }],
    [415, { error: "Unsupported image type" }],
    [415, { error: "Unsupported image type" }],
    [415, { error: "The content is not image/png" }],
    [415, { error: "The content is not image/gif" }],
    [415, { error: "The content is not image/webp" }],
  ]);
  expect(await readdir(mediaDir)).toEqual(before);
  expect((await mediaRows()).filter((row) => row.conversationKey === conversationKey)).toEqual([]);

  // a JPEG labelled as one is taken
  expect(await upload(accountId, conversationKey, JPEG, "image/jpeg")).toEqual([
    200,
    { id: expect.any(String), mimeType: "image/jpeg" },
  ]);
});

test("another account cannot upload to, download from or name the images of a conversation it does not own", async () => {
  useModel(true);
  await start();
  const alice = `acct-${crypto.randomUUID()}`;
  const bob = `acct-${crypto.randomUUID()}`;
  const media = await uploaded(alice, bella(alice));
  const notFound = { error: "Not found" };

  const answers = [];
  for (const response of [
    await download(bob, bella(alice), media.id),
    await download(bob, bella(bob), media.id),
    await download(alice, bella(alice), "no-such-image"),
  ]) {
    answers.push([response.status, await response.json()]);
  }
  expect(answers).toEqual([
    [404, notFound],
    [410, { error: "Gone" }],
    [410, { error: "Gone" }],
  ]);
  expect(await upload(bob, bella(alice), PNG, "image/png")).toEqual([404, notFound]);

  // a send names only an upload of its own account to the same conversation, by its type
  const refused = { error: "An image was not uploaded to this chat" };
  expect([
    await send(bob, bella(bob), { clientMessageId: "b-1", text: "Mine?", images: [media] }),
    await send(bob, bella(alice), { clientMessageId: "b-2", text: "Mine?", images: [media] }),
    await send(alice, bella(alice), {
      clientMessageId: "a-1",
      text: "Mine",
      images: [{ id: media.id, mimeType: "image/jpeg" }],
    }),
    await send(alice, bella(alice), {
      clientMessageId: "a-2",
      text: "Mine",
      images: [{ id: "no-such-image", mimeType: "image/png" }],
    }),
  ]).toEqual([
    [400, refused],
    [404, notFound],
    [400, refused],
    [400, refused],
  ]);
  const received = await DatabaseConnector.instance.database
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.type, EEventType.MessageReceived));
  expect(received).toEqual([]);
  expect((await download(alice, bella(alice), media.id)).status).toBe(200);
});

test("a deleted plain chat leaves no file behind, sent or only uploaded", async () => {
  useModel(true);
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const created = await request(
    "POST",
    gatewayAccountConversationsPath(accountId),
    null,
    "application/json",
  );
  const { conversationKey } = (await created.json()) as { conversationKey: string };
  const sent = await uploaded(accountId, conversationKey);
  const unsent = await uploaded(accountId, conversationKey);
  const kept = await uploaded(accountId, bella(accountId));
  expect(
    await send(accountId, conversationKey, {
      clientMessageId: "m-1",
      text: "Look",
      images: [sent],
      model: { provider: "openrouter", model: MODEL, effort: "low" },
    }),
  ).toEqual([200, { clientMessageId: "m-1" }]);
  expect(await readdir(mediaDir)).toEqual(expect.arrayContaining([sent.id, unsent.id, kept.id]));

  const deleted = await request(
    "DELETE",
    gatewayAccountConversationPath(accountId, conversationKey),
    null,
    "application/json",
  );
  expect(deleted.status).toBe(200);
  await EventBus.instance.idle();

  const files = await readdir(mediaDir);
  expect(files).not.toContain(sent.id);
  expect(files).not.toContain(unsent.id);
  expect(files).toContain(kept.id);
  const rows = await mediaRows();
  expect(rows.filter((row) => row.conversationKey === conversationKey)).toEqual([]);
  expect(rows.map((row) => row.id)).toContain(kept.id);
});

test("a sent image is in history while its turn still runs", async () => {
  useModel(true);
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = bella(accountId);
  const media = await uploaded(accountId, conversationKey);
  let during: THistoryMessage[] = [];
  handlerAi().runMain = async (args) => {
    during = await history(conversationKey);
    return AgentHarness.instance.runMain(args);
  };

  await send(accountId, conversationKey, { clientMessageId: "m-1", text: "Look", images: [media] });

  expect(during).toMatchObject([
    {
      author: "user",
      clientMessageId: "m-1",
      images: [{ mediaId: media.id, mimeType: "image/png" }],
    },
  ]);
});

test("a failed turn's image stays listed, is not replayed, and goes with the third compaction", async () => {
  const contexts = useModel(true);
  const compaction = compactEverything();
  await start(compaction.compact);
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = bella(accountId);
  const media = await uploaded(accountId, conversationKey);
  const ai = handlerAi();
  const runMain = ai.runMain;
  ai.runMain = async () => {
    throw new Error("The model is down");
  };

  await send(accountId, conversationKey, { clientMessageId: "m-1", text: "Look", images: [media] });
  ai.runMain = runMain;
  expect((await history(conversationKey))[0]).toMatchObject({
    author: "user",
    images: [{ mediaId: media.id, mimeType: "image/png" }],
  });

  await send(accountId, conversationKey, { clientMessageId: "m-2", text: "Two" });
  expect(contexts).toHaveLength(1);
  expect(JSON.stringify(contexts[0]?.messages)).not.toContain("Look");
  expect(JSON.stringify(contexts[0]?.messages)).not.toContain(Buffer.from(PNG).toString("base64"));

  await send(accountId, conversationKey, { clientMessageId: "m-3", text: "Three" });
  expect((await download(accountId, conversationKey, media.id)).status).toBe(200);
  await send(accountId, conversationKey, { clientMessageId: "m-4", text: "Four" });
  expect(compaction.count).toBe(3);
  expect((await download(accountId, conversationKey, media.id)).status).toBe(410);
  expect((await history(conversationKey))[0]).toMatchObject({
    author: "user",
    images: [{ mediaId: undefined, mimeType: "image/png" }],
  });
  await expectMediaGone(media.id);
});

test("a deleted message takes its image with it", async () => {
  useModel(true);
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = bella(accountId);
  const media = await uploaded(accountId, conversationKey);
  await send(accountId, conversationKey, { clientMessageId: "m-1", text: "Look", images: [media] });
  const row = (await history(conversationKey)).find((message) => message.author === "user");
  expect(row?.images).toEqual([{ mediaId: media.id, mimeType: "image/png" }]);

  const deleted = await request(
    "DELETE",
    gatewayAccountMessagePath(accountId, row?.id ?? 0),
    null,
    "application/json",
  );
  expect(deleted.status).toBe(200);

  expect((await download(accountId, conversationKey, media.id)).status).toBe(410);
  await expectMediaGone(media.id);
});

test("a command's image is deleted: a command takes none", async () => {
  useModel(true);
  await start();
  const accountId = `acct-${crypto.randomUUID()}`;
  const conversationKey = bella(accountId);
  const media = await uploaded(accountId, conversationKey);
  await send(accountId, conversationKey, {
    clientMessageId: "m-1",
    text: "!mcp-prompt",
    images: [media],
  });

  expect((await history(conversationKey)).map((message) => message.images)).toEqual([
    undefined,
    undefined,
  ]);
  expect((await download(accountId, conversationKey, media.id)).status).toBe(410);
  await expectMediaGone(media.id);
});
