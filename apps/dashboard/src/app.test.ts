import { expect, test } from "bun:test";
import { createDashboardLinkToken } from "@bellaclaw/shared";
import { AccountStore } from "./account-store";
import { createApp } from "./app";

const ORIGIN = "https://dashboard.test";
const SECRET = "test-secret";
const PASSWORD = "correct horse battery";

// an app on an in-memory store; readChatIds collects the chats whose data a route reached
function createTestApp() {
  const readChatIds: string[] = [];
  const unavailable = async (chatId: string) => {
    readChatIds.push(chatId);

    return { error: "unavailable", status: 502 as const };
  };
  const app = createApp({
    config: { publicOrigin: ORIGIN, secret: SECRET },
    store: new AccountStore(":memory:"),
    reader: {
      listMessages: async (chatId) => {
        readChatIds.push(chatId);

        return [];
      },
      listFacts: async (chatId) => {
        readChatIds.push(chatId);

        return [];
      },
    },
    internalApi: { getModel: unavailable, updateModel: unavailable, deleteMessage: unavailable },
    serveClient: async () => new Response("client"),
  });

  function send(method: string, path: string, body?: unknown, cookie?: string) {
    const headers = new Headers({ Origin: ORIGIN });

    if (cookie !== undefined) {
      headers.set("Cookie", cookie);
    }

    return app.request(path, { method, headers, body: JSON.stringify(body) });
  }

  // registers an account with a fresh link to the chat and returns its session cookie
  async function register(username: string, chatId: string) {
    const token = createDashboardLinkToken(SECRET, chatId, Date.now());
    const response = await send("POST", "/api/register", { token, username, password: PASSWORD });

    expect(response.status).toBe(200);

    return response.headers.get("Set-Cookie")?.split(";")[0] ?? "";
  }

  return { send, register, readChatIds };
}

test("a link token links its chat exactly once, and a failed registration does not use it up", async () => {
  const { send, register } = createTestApp();
  const token = createDashboardLinkToken(SECRET, "chat-a", Date.now());

  const tooShort = await send("POST", "/api/register", {
    token,
    username: "alice",
    password: "short",
  });
  expect(tooShort.status).toBe(400);
  expect(await (await send("POST", "/api/link/check", { token })).json()).toEqual({ valid: true });

  const registered = await send("POST", "/api/register", {
    token,
    username: "alice",
    password: PASSWORD,
  });
  expect(registered.status).toBe(200);
  expect(await registered.json()).toEqual({
    username: "alice",
    chats: [{ chatId: "chat-a", linkedAt: expect.any(Number) }],
  });

  // the same token again, by a new account and by a logged-in one
  const again = await send("POST", "/api/register", { token, username: "bob", password: PASSWORD });
  expect(again.status).toBe(400);
  const bobCookie = await register("bob", "chat-b");
  expect((await send("POST", "/api/link", { token }, bobCookie)).status).toBe(400);
  expect(await (await send("POST", "/api/link/check", { token })).json()).toEqual({ valid: false });
  expect(await (await send("GET", "/api/me", undefined, bobCookie)).json()).toEqual({
    username: "bob",
    chats: [{ chatId: "chat-b", linkedAt: expect.any(Number) }],
  });
});

test("a chat's routes answer 404 to another account and 401 without a session", async () => {
  const { send, register, readChatIds } = createTestApp();
  const aliceCookie = await register("alice", "chat-a");
  await register("bob", "chat-b");
  const routes = [
    ["GET", "messages"],
    ["GET", "facts"],
    ["GET", "model"],
    ["PUT", "model"],
    ["DELETE", "messages/1"],
  ] as const;

  for (const [method, route] of routes) {
    const foreign = await send(method, `/api/chats/chat-b/${route}`, undefined, aliceCookie);
    expect(foreign.status).toBe(404);

    const anonymous = await send(method, `/api/chats/chat-a/${route}`);
    expect(anonymous.status).toBe(401);
  }

  expect(readChatIds).toEqual([]);

  // her own chat is reachable, so the 404 above is the access check
  expect((await send("GET", "/api/chats/chat-a/messages", undefined, aliceCookie)).status).toBe(
    200,
  );
  expect(readChatIds).toEqual(["chat-a"]);
});
