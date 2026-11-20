import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conversationsTable,
  EConversationKind,
  MIGRATIONS_FOLDER,
  memoriesTable,
} from "@bellaclaw/database";
import {
  ADDRESS_LINKED_ELSEWHERE,
  createGatewayLinkToken,
  type TGatewayAppMessage,
  type TGatewayChatLink,
  type TGatewayDeviceRegistration,
  type TGatewayLinkState,
  type TGatewayModelCatalog,
  type TGatewayPersonality,
  type TGatewayStreamEvent,
  type TOption,
} from "@bellaclaw/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { ACCOUNT_HEADER } from "./account-header";
import { AccountStore } from "./account-store";
import { createApp } from "./app";
import { createChatReader, type TChatReader } from "./chat-reader";
import type { TInternalApi } from "./internal-api";
import { createLiveStream } from "./live-stream";
import { CLIENT_HEADER } from "./route-support";

// the catalog the fake assistant's getModels answers
export const FAKE_MODEL_CATALOG: TGatewayModelCatalog = {
  providers: [
    {
      id: "openrouter",
      usable: true,
      models: [{ id: "openai/gpt-5", name: "GPT-5", supportedEfforts: ["low", "high"] }],
    },
    {
      id: "opencode-go",
      usable: false,
      reason: "opencode-go is not connected.",
      models: [{ id: "grok-4.7", name: "Grok 4.7", supportedEfforts: ["high"] }],
    },
  ],
};

// An in-memory stand-in for the assistant's internal API, for tests. links: by chat key.
// activationCode: the configured code, undefined for none; codeChecks: every code checked.
// unreachableCalls: how many next requestLink, getChatLink or getAccount calls answer 502. Links are made active by activate().
// sends: every message sent, accepted as the assistant does, without a turn. streams: the stream
// opened by each openStream call, oldest first; push writes an event to the newest, drop closes it.
// uploads: every image streamed on, with its bytes; the fake answers it with the id `media-<n>`,
// and a download of that id with the bytes. devices: by device id, as the assistant keeps them;
// unreachableCalls also counts registerDevice, unregisterDevice and unregisterAccountDevices.
// presence: every set reportPresence delivered, oldest first; failingPresenceReports: how many
// next reportPresence calls answer 502
export function createFakeAssistant() {
  const personalities = new Map<string, TGatewayPersonality>();
  const defaultPersonality: TGatewayPersonality = {
    bellaPersona: "You are Bella.",
    plainChatsUseBellaPersona: true,
    plainChatsPersona: "",
  };
  const links = new Map<string, { accountId: string; state: TGatewayLinkState }>();
  const requests: { accountId: string; chatKey: string }[] = [];
  const calls: { method: string; accountId: string }[] = [];
  const state: {
    unreachableCalls: number;
    activationCode: TOption<string>;
    failingPresenceReports: number;
  } = {
    unreachableCalls: 0,
    activationCode: "open-sesame",
    failingPresenceReports: 0,
  };
  const codeChecks: string[] = [];
  const sends: { accountId: string; conversationKey: string; message: TGatewayAppMessage }[] = [];
  const uploads: {
    accountId: string;
    conversationKey: string;
    mimeType: string;
    data: ArrayBuffer;
  }[] = [];
  const unavailable = { error: "The assistant is unavailable", status: 502 as const };
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const devices = new Map<
    string,
    { accountId: string; registration: TGatewayDeviceRegistration }
  >();
  const presence: string[][] = [];
  const encoder = new TextEncoder();

  function reachable(): boolean {
    if (state.unreachableCalls > 0) {
      state.unreachableCalls -= 1;
      return false;
    }

    return true;
  }

  const internalApi: TInternalApi = {
    checkActivationCode: async (code) => {
      codeChecks.push(code);

      if (state.activationCode === undefined) {
        return { data: { result: "unset" } };
      }

      if (code.trim() === state.activationCode) {
        return { data: { result: "valid" } };
      }

      return { data: { result: "invalid" } };
    },
    requestLink: async (accountId, chatKey) => {
      if (!reachable()) {
        return unavailable;
      }

      requests.push({ accountId, chatKey });
      const existing = links.get(chatKey);

      if (existing !== undefined && existing.accountId !== accountId) {
        return {
          error: "The address is linked to another account",
          status: 400,
          code: ADDRESS_LINKED_ELSEWHERE,
        };
      }

      if (existing?.state === "migrating") {
        return { error: "The address is already being linked", status: 400 };
      }

      if (existing === undefined) {
        links.set(chatKey, { accountId, state: "migrating" });
      }

      return { data: { state: "migrating" } };
    },
    getChatLink: async (chatKey) => {
      if (!reachable()) {
        return unavailable;
      }

      const data: TGatewayChatLink = { link: links.get(chatKey) };

      return { data };
    },
    getAccount: async (accountId) => {
      if (!reachable()) {
        return unavailable;
      }

      calls.push({ method: "getAccount", accountId });

      return {
        data: {
          conversationKey: `bella:${accountId}`,
          ownerKey: `account:${accountId}`,
          links: [...links.entries()]
            .filter(([, link]) => link.accountId === accountId)
            .map(([chatKey, link]) => ({ chatKey, state: link.state, linkedAt: 1_000 })),
        },
      };
    },
    getModel: async (accountId) => {
      calls.push({ method: "getModel", accountId });

      return unavailable;
    },
    updateModel: async (accountId) => {
      calls.push({ method: "updateModel", accountId });

      return unavailable;
    },
    getModels: async (accountId) => {
      calls.push({ method: "getModels", accountId });

      return { data: FAKE_MODEL_CATALOG };
    },
    getPersonality: async (accountId) => {
      calls.push({ method: "getPersonality", accountId });

      return { data: personalities.get(accountId) ?? defaultPersonality };
    },
    updatePersonality: async (accountId, update) => {
      calls.push({ method: "updatePersonality", accountId });

      const next = { ...(personalities.get(accountId) ?? defaultPersonality), ...update };
      personalities.set(accountId, next);

      return { data: next };
    },
    deleteMessage: async (accountId, messageId) => {
      calls.push({ method: "deleteMessage", accountId });

      return { data: { deletedMessageIds: [messageId] } };
    },
    sendMessage: async (accountId, conversationKey, message) => {
      sends.push({ accountId, conversationKey, message });

      return { data: { clientMessageId: message.clientMessageId } };
    },
    uploadMedia: async (accountId, conversationKey, mimeType, body) => {
      const data = await new Response(body).arrayBuffer();
      uploads.push({ accountId, conversationKey, mimeType, data });

      return { data: { id: `media-${uploads.length}`, mimeType } };
    },
    downloadMedia: async (accountId, conversationKey, mediaId) => {
      const upload = uploads[Number(mediaId.slice("media-".length)) - 1];

      if (
        upload === undefined ||
        upload.accountId !== accountId ||
        upload.conversationKey !== conversationKey
      ) {
        return { error: "Gone", status: 410 };
      }

      return { data: new Response(upload.data, { headers: { "Content-Type": upload.mimeType } }) };
    },
    createConversation: async (accountId) => {
      calls.push({ method: "createConversation", accountId });

      return { data: { conversationKey: `plain:${accountId}:${calls.length}`, createdAt: 1_000 } };
    },
    deleteConversation: async (accountId, conversationKey) => {
      calls.push({ method: "deleteConversation", accountId });

      return { data: { conversationKey } };
    },
    reportPresence: async (accountIds) => {
      if (state.failingPresenceReports > 0) {
        state.failingPresenceReports -= 1;
        return unavailable;
      }

      presence.push(accountIds);

      return { data: { ok: true } };
    },
    registerDevice: async (accountId, deviceId, registration) => {
      if (!reachable()) {
        return unavailable;
      }

      devices.set(deviceId, { accountId, registration });

      return { data: { deviceId } };
    },
    unregisterDevice: async (accountId, deviceId) => {
      if (!reachable()) {
        return unavailable;
      }

      if (devices.get(deviceId)?.accountId !== accountId) {
        return { error: "Not found", status: 404 };
      }

      devices.delete(deviceId);

      return { data: { deviceId } };
    },
    unregisterAccountDevices: async (accountId) => {
      if (!reachable()) {
        return unavailable;
      }

      const deviceIds = [...devices]
        .filter(([, device]) => device.accountId === accountId)
        .map(([deviceId]) => deviceId);

      for (const deviceId of deviceIds) {
        devices.delete(deviceId);
      }

      return { data: { deviceIds } };
    },
    openStream: async (signal) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          signal.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {
              // dropped already
            }
          });
        },
      });

      return { data: body };
    },
  };

  return {
    internalApi,
    links,
    requests,
    calls,
    codeChecks,
    sends,
    uploads,
    state,
    streams,
    devices,
    presence,
    push(event: TGatewayStreamEvent) {
      streams.at(-1)?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    drop() {
      streams.at(-1)?.close();
    },
    activate(chatKey: string) {
      const link = links.get(chatKey);

      if (link !== undefined) {
        link.state = "active";
      }
    },
  };
}

const ORIGIN = "https://dashboard.test";
const SECRET = "test-secret";
export const PASSWORD = "correct horse battery";

// an app on a store at path, in memory by default, and a fake assistant; reads collects the keys
// the fake reader got. reader: a real one instead
export function createTestApp(path = ":memory:", reader?: TChatReader, streamSilenceMs = 60_000) {
  const reads: string[] = [];
  const assistant = createFakeAssistant();
  const store = new AccountStore(path);
  // reconnects after 1 ms, so a test barely waits
  const liveStream = createLiveStream(assistant.internalApi, 1, streamSilenceMs);
  const app = createApp({
    config: { publicOrigin: ORIGIN, secret: SECRET },
    store,
    reader: reader ?? {
      listMessages: async (conversationKey) => {
        reads.push(conversationKey);

        return [];
      },
      listFacts: async (ownerKey) => {
        reads.push(ownerKey);

        return [];
      },
      findConversation: async () => undefined,
      listConversations: async () => [],
      listHistory: async () => [],
    },
    internalApi: assistant.internalApi,
    liveStream,
    serveClient: async () => new Response("client"),
  });

  // account: the username of the account header, as a page that shows it sends
  function send(method: string, path: string, body?: unknown, cookie?: string, account?: string) {
    const headers = new Headers({ Origin: ORIGIN });

    if (cookie !== undefined) {
      headers.set("Cookie", cookie);
    }

    if (account !== undefined) {
      headers.set(ACCOUNT_HEADER, account);
    }

    return app.request(path, { method, headers, body: JSON.stringify(body) });
  }

  // a request of the app: no Origin and no cookie unless headers has one; the bearer token, or the
  // client header that asks for one
  function sendApp(
    method: string,
    path: string,
    body?: unknown,
    bearer?: string,
    headers: Record<string, string> = {},
  ) {
    const appHeaders = new Headers(headers);

    if (bearer !== undefined) {
      appHeaders.set("Authorization", `Bearer ${bearer}`);
    } else {
      appHeaders.set(CLIENT_HEADER, "app");
    }

    return app.request(path, { method, headers: appHeaders, body: JSON.stringify(body) });
  }

  function cookieOf(response: Response) {
    return response.headers.get("Set-Cookie")?.split(";")[0] ?? "";
  }

  function token(chatKey: string) {
    return createGatewayLinkToken(SECRET, chatKey, Date.now());
  }

  // registers an account with a fresh link to the chat; its link becomes active
  async function register(username: string, chatKey: string) {
    const response = await send("POST", "/api/register", {
      token: token(chatKey),
      username,
      password: PASSWORD,
    });

    expect(response.status).toBe(200);
    assistant.activate(chatKey);

    return { cookie: cookieOf(response), publicId: store.findCredentials(username)?.publicId };
  }

  // the edge follows the assistant's stream from when its first stream is open; the returned stop
  // ends it
  async function startFollowing(): Promise<() => Promise<void>> {
    const following = new AbortController();
    const follow = liveStream.follow(following.signal);

    try {
      await waitUntil(() => assistant.streams.length >= 1);
    } catch (error) {
      following.abort();
      await follow;
      throw error;
    }

    return async () => {
      following.abort();
      await follow;
    };
  }

  return {
    app,
    send,
    sendApp,
    register,
    token,
    cookieOf,
    reads,
    assistant,
    store,
    liveStream,
    startFollowing,
  };
}

// polls until check holds; a few seconds at most
export async function waitUntil(check: () => boolean) {
  for (let attempt = 0; attempt < 1_000 && !check(); attempt++) {
    await Bun.sleep(1);
  }

  expect(check()).toBe(true);
}

// the assistant's database in a temporary file, migrated, with the reader the gateway uses on it
export async function createAssistantDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "bellaclaw-gateway-history-"));
  const url = `file:${join(dir, "assistant.db")}`;
  const db = drizzle({ connection: { url } });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  // rows as the assistant writes them; createdAt: epoch ms
  function insertRow(
    chatId: string,
    author: "user" | "assistant",
    kind: "message" | "tool" | "display",
    message: string,
    clientMessageId?: string,
  ) {
    return db
      .insert(memoriesTable)
      .values({
        chatId,
        channel: "app",
        author,
        kind,
        message,
        createdAt: new Date(1_000),
        clientMessageId,
      })
      .returning({ id: memoriesTable.id })
      .get();
  }

  function setRevision(
    conversationKey: string,
    ownerKey: string,
    revision: number,
    rewriteRevision: number,
  ) {
    return db
      .insert(conversationsTable)
      .values({ conversationKey, ownerKey, revision, rewriteRevision })
      .onConflictDoUpdate({
        target: conversationsTable.conversationKey,
        set: { revision, rewriteRevision },
      });
  }

  // a plain chat as the assistant lists it on creation, and its removal with its rows
  function createPlain(conversationKey: string, ownerKey: string) {
    return db.insert(conversationsTable).values({
      conversationKey,
      ownerKey,
      kind: EConversationKind.Plain,
      createdAt: new Date(500),
    });
  }

  async function removeConversation(conversationKey: string) {
    await db.delete(memoriesTable).where(eq(memoriesTable.chatId, conversationKey));
    await db
      .delete(conversationsTable)
      .where(eq(conversationsTable.conversationKey, conversationKey));
  }

  return {
    db,
    reader: createChatReader(url, ""),
    insertRow,
    setRevision,
    createPlain,
    removeConversation,
    deleteRow: (id: number) => db.delete(memoriesTable).where(eq(memoriesTable.id, id)),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

// registers an app account with the activation code; its bearer token and public id
export async function registerApp(
  sendApp: ReturnType<typeof createTestApp>["sendApp"],
  store: AccountStore,
  username: string,
) {
  const response = await sendApp("POST", "/api/register", {
    username,
    password: PASSWORD,
    activationCode: "open-sesame",
  });
  expect(response.status).toBe(200);
  const body = await response.json();

  return { token: String(body.token), publicId: String(store.findCredentials(username)?.publicId) };
}

// real P-256 public keys, uncompressed, base64url
const PUBLIC_KEYS = [
  "BA45xSmkpu16iOb3SDdemng3MY0BBUBpXQTZ9_u_XrgBhMbbDrSUSmJs3hm6zHVYq1DuFSV7hLcvavZQMDe4UkM",
  "BK0NaeMoGRCI4PAxQ1dSlLqaFvREgqUAxC-3HUWgt3y8p-tA24e65EW5mBBtfZ4psKk118_YVeyD9_YEMuKyxWM",
];

// RFC 8291 key material of PUBLIC_KEYS[index], base64url
export function deviceKeys(index: number) {
  return {
    fcmToken: `token-${index}`,
    publicKey: PUBLIC_KEYS[index] ?? "",
    authSecret: Buffer.from(new Uint8Array(16).fill(index + 1)).toString("base64url"),
  };
}
