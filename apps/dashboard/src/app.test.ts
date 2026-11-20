import { Database } from "bun:sqlite";
import { expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appMediaTable,
  conversationsTable,
  EConversationKind,
  MIGRATIONS_FOLDER,
  memoriesTable,
} from "@bellaclaw/database";
import { createDashboardLinkToken } from "@bellaclaw/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { ACCOUNT_HEADER } from "./account-header";
import { AccountStore } from "./account-store";
import { CLIENT_HEADER, createApp } from "./app";
import { createChatReader, type TChatReader } from "./chat-reader";
import { createLiveStream } from "./live-stream";
import { createFakeAssistant } from "./test-utils";

const ORIGIN = "https://dashboard.test";
const SECRET = "test-secret";
const PASSWORD = "correct horse battery";

// an app on a store at path, in memory by default, and a fake assistant; reads collects the keys
// the fake reader got. reader: a real one instead
function createTestApp(path = ":memory:", reader?: TChatReader, streamSilenceMs = 60_000) {
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
    return createDashboardLinkToken(SECRET, chatKey, Date.now());
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
  };
}

test("registering sends a link request for the new account and uses the token once", async () => {
  const { send, token, assistant, store } = createTestApp();
  const link = token("signal:+100");

  const tooShort = await send("POST", "/api/register", {
    token: link,
    username: "alice",
    password: "short",
  });
  expect(tooShort.status).toBe(400);
  expect(await (await send("POST", "/api/link/check", { token: link })).json()).toEqual({
    valid: true,
    chatKey: "signal:+100",
  });

  const registered = await send("POST", "/api/register", {
    token: link,
    username: "alice",
    password: PASSWORD,
  });
  expect(registered.status).toBe(200);
  expect(await registered.json()).toEqual({
    username: "alice",
    chats: [{ chatKey: "signal:+100", state: "migrating", linkedAt: 1_000 }],
  });
  const publicId = store.findCredentials("alice")?.publicId;
  expect(assistant.requests).toEqual([{ accountId: publicId ?? "", chatKey: "signal:+100" }]);

  const again = await send("POST", "/api/register", {
    token: link,
    username: "bob",
    password: PASSWORD,
  });
  expect(again.status).toBe(400);
  expect(await (await send("POST", "/api/link/check", { token: link })).json()).toEqual({
    valid: false,
  });
  expect(assistant.requests).toHaveLength(1);
});

test("logging in with a token and the signed-in link action send a link request for that account", async () => {
  const { send, register, token, cookieOf, assistant } = createTestApp();
  const alice = await register("alice", "signal:+100");

  const loggedIn = await send("POST", "/api/login", {
    username: "alice",
    password: PASSWORD,
    token: token("discord:200"),
  });
  expect(loggedIn.status).toBe(200);

  const linked = await send(
    "POST",
    "/api/link",
    { token: token("signal:+300") },
    cookieOf(loggedIn),
    "alice",
  );
  expect(linked.status).toBe(200);
  expect((await linked.json()).chats.map((chat: { chatKey: string }) => chat.chatKey)).toEqual([
    "signal:+100",
    "discord:200",
    "signal:+300",
  ]);
  expect(assistant.requests.slice(1)).toEqual([
    { accountId: alice.publicId ?? "", chatKey: "discord:200" },
    { accountId: alice.publicId ?? "", chatKey: "signal:+300" },
  ]);
});

test("a chat linked to another account is refused as such", async () => {
  const { send, register, token, assistant, store } = createTestApp();
  const alice = await register("alice", "signal:+100");
  const bob = await register("bob", "signal:+200");

  const linked = await send(
    "POST",
    "/api/link",
    { token: token("signal:+100") },
    bob.cookie,
    "bob",
  );
  expect(linked.status).toBe(409);
  expect(await linked.json()).toEqual({ error: "This chat is linked to another account" });

  const loggedIn = await send("POST", "/api/login", {
    username: "bob",
    password: PASSWORD,
    token: token("signal:+100"),
  });
  expect(loggedIn.status).toBe(409);
  expect(assistant.links.get("signal:+100")?.accountId).toBe(alice.publicId);

  // registering checks first, so no account is left behind
  const registered = await send("POST", "/api/register", {
    token: token("signal:+100"),
    username: "carol",
    password: PASSWORD,
  });
  expect(registered.status).toBe(409);
  expect(store.findCredentials("carol")).toBeUndefined();
});

test("a token of a linked chat logs into its account once, and can set a new password", async () => {
  const { send, register, token, cookieOf, assistant } = createTestApp();
  await register("alice", "signal:+100");
  const link = token("signal:+100");

  expect(await (await send("POST", "/api/link/check", { token: link })).json()).toEqual({
    valid: true,
    chatKey: "signal:+100",
    username: "alice",
  });

  const loggedIn = await send("POST", "/api/link/login", {
    token: link,
    password: "a brand new password",
  });
  expect(loggedIn.status).toBe(200);
  expect((await loggedIn.json()).username).toBe("alice");
  expect((await send("GET", "/api/me", undefined, cookieOf(loggedIn))).status).toBe(200);

  const again = await send("POST", "/api/link/login", { token: link });
  expect(again.status).toBe(400);

  expect((await send("POST", "/api/login", { username: "alice", password: PASSWORD })).status).toBe(
    401,
  );
  expect(
    (await send("POST", "/api/login", { username: "alice", password: "a brand new password" }))
      .status,
  ).toBe(200);

  // a link of an unlinked chat logs into nothing
  expect((await send("POST", "/api/link/login", { token: token("signal:+999") })).status).toBe(400);
  // the login link sent no link request
  expect(assistant.requests).toHaveLength(1);
});

test("a token of a linked chat logs in without changing the password", async () => {
  const { send, register, token } = createTestApp();
  await register("alice", "signal:+100");

  expect((await send("POST", "/api/link/login", { token: token("signal:+100") })).status).toBe(200);
  expect((await send("POST", "/api/login", { username: "alice", password: PASSWORD })).status).toBe(
    200,
  );
});

test("the account routes reach only the signed-in account's keys, and need a session", async () => {
  const { send, register, reads, assistant } = createTestApp();
  const alice = await register("alice", "signal:+100");
  const bob = await register("bob", "signal:+200");
  const routes = [
    ["GET", "/api/messages"],
    ["GET", "/api/facts"],
    ["GET", "/api/model"],
    ["PUT", "/api/model"],
    ["GET", "/api/personality"],
    ["PUT", "/api/personality"],
    ["DELETE", "/api/messages/1"],
  ] as const;

  for (const [method, path] of routes) {
    expect((await send(method, path, {})).status).toBe(401);
  }

  expect(reads).toEqual([]);
  assistant.calls.length = 0;

  for (const [method, path] of routes) {
    await send(method, path, {}, alice.cookie);
  }

  expect(reads).toEqual([`bella:${alice.publicId}`, `account:${alice.publicId}`]);
  expect(assistant.calls.every((call) => call.accountId === alice.publicId)).toBe(true);
  expect(assistant.calls.map((call) => call.method)).toEqual([
    "getAccount",
    "getAccount",
    "getModel",
    "updateModel",
    "getPersonality",
    "updatePersonality",
    "deleteMessage",
  ]);

  reads.length = 0;
  await send("GET", "/api/messages", undefined, bob.cookie);
  expect(reads).toEqual([`bella:${bob.publicId}`]);
  expect(await (await send("GET", "/api/me", undefined, bob.cookie)).json()).toEqual({
    username: "bob",
    chats: [{ chatKey: "signal:+200", state: "active", linkedAt: 1_000 }],
  });
});

test("a row of account_chats the import still holds counts as its account's link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-app-"));
  const path = join(directory, "dashboard.db");

  try {
    const { send, register, token, assistant, store } = createTestApp(path);
    const alice = await register("alice", "signal:+100");
    const bob = await register("bob", "signal:+200");
    const db = new Database(path);
    db.run(
      "CREATE TABLE account_chats (chatId TEXT PRIMARY KEY, accountId INTEGER NOT NULL, linkedAt INTEGER NOT NULL)",
    );
    db.query("INSERT INTO account_chats VALUES ('signal:+500', ?, 1)").run(
      store.findCredentials("alice")?.id ?? 0,
    );
    db.close();
    const link = token("signal:+500");

    expect(await (await send("POST", "/api/link/check", { token: link })).json()).toEqual({
      valid: true,
      chatKey: "signal:+500",
      username: "alice",
    });

    const registered = await send("POST", "/api/register", {
      token: link,
      username: "carol",
      password: PASSWORD,
    });
    expect(registered.status).toBe(409);
    expect(store.findCredentials("carol")).toBeUndefined();

    const linked = await send("POST", "/api/link", { token: link }, bob.cookie, "bob");
    expect(linked.status).toBe(409);
    const loggedIn = await send("POST", "/api/login", {
      username: "bob",
      password: PASSWORD,
      token: link,
    });
    expect(loggedIn.status).toBe(409);
    expect(assistant.requests.map((request) => request.chatKey)).toEqual([
      "signal:+100",
      "signal:+200",
    ]);

    // the refusals used nothing: the link logs into alice
    const linkLogin = await send("POST", "/api/link/login", { token: link });
    expect(linkLogin.status).toBe(200);
    expect((await linkLogin.json()).username).toBe("alice");

    // alice takes the chat into her own account
    const own = await send(
      "POST",
      "/api/link",
      { token: token("signal:+500") },
      alice.cookie,
      "alice",
    );
    expect(own.status).toBe(200);
    expect(assistant.links.get("signal:+500")?.accountId).toBe(alice.publicId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the link action refuses an account other than the one the confirmation named, using nothing", async () => {
  const { send, register, token, assistant } = createTestApp();
  await register("alice", "signal:+100");
  const bob = await register("bob", "signal:+200");
  const link = token("signal:+300");

  const refused = await send("POST", "/api/link", { token: link }, bob.cookie, "alice");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: "You are signed in to another account now",
    code: "otherAccount",
  });
  expect(assistant.requests).toHaveLength(2);
  expect(await (await send("POST", "/api/link/check", { token: link })).json()).toEqual({
    valid: true,
    chatKey: "signal:+300",
  });

  const linked = await send("POST", "/api/link", { token: link }, bob.cookie, "bob");
  expect(linked.status).toBe(200);
  expect(assistant.links.get("signal:+300")?.accountId).toBe(bob.publicId);
});

test("a new password set through a login link ends the account's other sessions; a plain login link does not", async () => {
  const { send, register, token, cookieOf } = createTestApp();
  const alice = await register("alice", "signal:+100");

  const plain = await send("POST", "/api/link/login", { token: token("signal:+100") });
  expect(plain.status).toBe(200);
  expect((await send("GET", "/api/me", undefined, alice.cookie)).status).toBe(200);

  const reset = await send("POST", "/api/link/login", {
    token: token("signal:+100"),
    password: "a brand new password",
  });
  expect(reset.status).toBe(200);
  expect((await send("GET", "/api/me", undefined, alice.cookie)).status).toBe(401);
  expect((await send("GET", "/api/me", undefined, cookieOf(plain))).status).toBe(401);
  expect((await send("GET", "/api/me", undefined, cookieOf(reset))).status).toBe(200);
});

test("an account route naming another account than the session's is refused; one naming it, or none, is served", async () => {
  const { send, register, assistant } = createTestApp();
  const alice = await register("alice", "signal:+100");
  const routes = [
    ["GET", "/api/me"],
    ["GET", "/api/messages"],
    ["GET", "/api/facts"],
    ["GET", "/api/model"],
    ["PUT", "/api/model"],
    ["GET", "/api/personality"],
    ["PUT", "/api/personality"],
    ["DELETE", "/api/messages/1"],
    ["POST", "/api/link"],
    ["POST", "/api/logout"],
  ] as const;
  assistant.calls.length = 0;

  for (const [method, path] of routes) {
    const refused = await send(method, path, {}, alice.cookie, "bob");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "You are signed in to another account now",
      code: "otherAccount",
    });
  }

  expect(assistant.calls).toEqual([]);

  for (const account of ["alice", undefined]) {
    expect((await send("GET", "/api/messages", undefined, alice.cookie, account)).status).toBe(200);
    expect((await send("GET", "/api/facts", undefined, alice.cookie, account)).status).toBe(200);
    expect((await send("GET", "/api/me", undefined, alice.cookie, account)).status).toBe(200);
    expect((await send("DELETE", "/api/messages/1", undefined, alice.cookie, account)).status).toBe(
      200,
    );
    // the fake assistant answers 502 for the model, past the session check
    expect((await send("GET", "/api/model", undefined, alice.cookie, account)).status).toBe(502);
    expect((await send("PUT", "/api/model", {}, alice.cookie, account)).status).not.toBe(409);
  }

  expect((await send("POST", "/api/logout", undefined, alice.cookie, "alice")).status).toBe(200);
  expect((await send("GET", "/api/me", undefined, alice.cookie)).status).toBe(401);
});

test("the app registers with the activation code and gets a bearer session for an account with no chat", async () => {
  const { sendApp, assistant, store } = createTestApp();

  const registered = await sendApp("POST", "/api/register", {
    username: "alice",
    password: PASSWORD,
    activationCode: " open-sesame ",
  });
  expect(registered.status).toBe(200);
  expect(registered.headers.get("Set-Cookie")).toBeNull();
  const body = await registered.json();
  expect(body).toEqual({ username: "alice", chats: [], token: expect.any(String) });
  expect(assistant.requests).toEqual([]);

  const me = await sendApp("GET", "/api/me", undefined, body.token);
  expect(await me.json()).toEqual({ username: "alice", chats: [] });

  // a token and a code together, or neither, is no registration
  for (const proof of [{}, { token: "x", activationCode: "open-sesame" }]) {
    const refused = await sendApp("POST", "/api/register", {
      username: "bob",
      password: PASSWORD,
      ...proof,
    });
    expect(refused.status).toBe(400);
  }

  expect(store.findCredentials("bob")).toBeUndefined();
});

test("the app's registration is refused with a wrong code, after too many wrong codes, and with no code configured", async () => {
  const { sendApp, assistant, store } = createTestApp();
  const register = (username: string, activationCode: string) =>
    sendApp("POST", "/api/register", { username, password: PASSWORD, activationCode });

  try {
    const wrong = await register("alice", "open-sesam");
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "Wrong activation code" });

    // a right code in between counts no failure
    expect((await register("bob", "open-sesame")).status).toBe(200);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await register("alice", `guess-${attempt}`)).status).toBe(400);
    }

    // five wrong codes close registration by code for everyone, even with the right one, and the
    // assistant is not asked
    const checks = assistant.codeChecks.length;
    const locked = await register("carol", "open-sesame");
    expect(locked.status).toBe(429);
    expect(assistant.codeChecks).toHaveLength(checks);
    expect(store.findCredentials("carol")).toBeUndefined();

    setSystemTime(new Date(Date.now() + 15 * 60 * 1000));
    expect((await register("carol", "open-sesame")).status).toBe(200);

    assistant.state.activationCode = undefined;
    const closed = await register("dave", "open-sesame");
    expect(closed.status).toBe(403);
    expect(await closed.json()).toEqual({
      error: "Registration with an activation code is closed",
    });
    expect(store.findCredentials("dave")).toBeUndefined();
    expect(store.findCredentials("alice")).toBeUndefined();

    // an attempt with no code configured counts no failure
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await register("dave", "open-sesame")).status).toBe(403);
    }
  } finally {
    setSystemTime();
  }
});

test("the app logs in by password and gets a bearer token, which stops working after logout", async () => {
  const { send, sendApp, register } = createTestApp();
  const alice = await register("alice", "signal:+100");

  const wrongPassword = await sendApp("POST", "/api/login", {
    username: "alice",
    password: "not the password",
  });
  const unknownUser = await sendApp("POST", "/api/login", {
    username: "nobody",
    password: PASSWORD,
  });
  expect(wrongPassword.status).toBe(401);
  expect(unknownUser.status).toBe(401);
  expect(await wrongPassword.json()).toEqual(await unknownUser.json());

  const loggedIn = await sendApp("POST", "/api/login", { username: "alice", password: PASSWORD });
  expect(loggedIn.status).toBe(200);
  expect(loggedIn.headers.get("Set-Cookie")).toBeNull();
  const { token, ...me } = await loggedIn.json();
  expect(me).toEqual({
    username: "alice",
    chats: [{ chatKey: "signal:+100", state: "active", linkedAt: 1_000 }],
  });

  expect((await sendApp("GET", "/api/me", undefined, token)).status).toBe(200);
  expect(await (await sendApp("POST", "/api/logout", undefined, token)).json()).toEqual({
    ok: true,
  });
  expect((await sendApp("GET", "/api/me", undefined, token)).status).toBe(401);
  // the web session lives on
  expect((await send("GET", "/api/me", undefined, alice.cookie)).status).toBe(200);
});

test("a link logs the app into the account of a linked chat, optionally with a new password that ends every other session", async () => {
  const { send, sendApp, register, token, assistant } = createTestApp();
  const alice = await register("alice", "signal:+100");
  const before = (
    await (await sendApp("POST", "/api/login", { username: "alice", password: PASSWORD })).json()
  ).token;
  const link = token("signal:+100");

  expect(await (await sendApp("POST", "/api/link/check", { token: link })).json()).toEqual({
    valid: true,
    chatKey: "signal:+100",
    username: "alice",
  });

  const plain = await sendApp("POST", "/api/link/login", { token: token("signal:+100") });
  expect(plain.status).toBe(200);
  expect(plain.headers.get("Set-Cookie")).toBeNull();
  const plainToken = (await plain.json()).token;
  expect((await sendApp("GET", "/api/me", undefined, before)).status).toBe(200);

  const reset = await sendApp("POST", "/api/link/login", {
    token: link,
    password: "a brand new password",
  });
  expect(reset.status).toBe(200);
  const { token: resetToken, username } = await reset.json();
  expect(username).toBe("alice");
  expect((await sendApp("POST", "/api/link/login", { token: link })).status).toBe(400);

  expect((await sendApp("GET", "/api/me", undefined, resetToken)).status).toBe(200);
  expect((await sendApp("GET", "/api/me", undefined, before)).status).toBe(401);
  expect((await sendApp("GET", "/api/me", undefined, plainToken)).status).toBe(401);
  expect((await send("GET", "/api/me", undefined, alice.cookie)).status).toBe(401);
  expect(
    (
      await sendApp("POST", "/api/login", {
        username: "alice",
        password: "a brand new password",
      })
    ).status,
  ).toBe(200);
  expect(assistant.requests).toHaveLength(1);
});

test("a link of an unlinked chat registers the app's account with that chat, or links it to the signed-in account", async () => {
  const { sendApp, token, assistant, store } = createTestApp();

  const registered = await sendApp("POST", "/api/register", {
    token: token("signal:+200"),
    username: "bob",
    password: PASSWORD,
  });
  expect(registered.status).toBe(200);
  const bob = await registered.json();
  expect(bob.chats).toEqual([{ chatKey: "signal:+200", state: "migrating", linkedAt: 1_000 }]);
  const bobId = store.findCredentials("bob")?.publicId ?? "";

  const linked = await sendApp("POST", "/api/link", { token: token("signal:+300") }, bob.token);
  expect(linked.status).toBe(200);
  expect((await linked.json()).chats.map((chat: { chatKey: string }) => chat.chatKey)).toEqual([
    "signal:+200",
    "signal:+300",
  ]);

  // a password login with a link links the chat too
  const loggedIn = await sendApp("POST", "/api/login", {
    username: "bob",
    password: PASSWORD,
    token: token("discord:400"),
  });
  expect(loggedIn.status).toBe(200);
  expect(typeof (await loggedIn.json()).token).toBe("string");
  expect(assistant.requests).toEqual([
    { accountId: bobId, chatKey: "signal:+200" },
    { accountId: bobId, chatKey: "signal:+300" },
    { accountId: bobId, chatKey: "discord:400" },
  ]);
});

test("every account route serves the bearer token without Origin, for its own account only", async () => {
  const { app, send, sendApp, register, reads, assistant } = createTestApp();
  const alice = await register("alice", "signal:+100");
  const bob = await register("bob", "signal:+200");
  const bearerOf = async (username: string) =>
    (await (await sendApp("POST", "/api/login", { username, password: PASSWORD })).json()).token;
  const aliceToken = await bearerOf("alice");
  const bobToken = await bearerOf("bob");
  const routes = [
    ["GET", "/api/me"],
    ["GET", "/api/messages"],
    ["GET", "/api/facts"],
    ["GET", "/api/model"],
    ["PUT", "/api/model"],
    ["DELETE", "/api/messages/1"],
    ["POST", "/api/link"],
  ] as const;

  // an app request never uses the cookie, and a wrong token is no session
  for (const [method, path] of routes) {
    expect((await sendApp(method, path, {}, undefined, { Cookie: alice.cookie })).status).toBe(401);
    expect((await sendApp(method, path, {}, "not-a-session")).status).toBe(401);
    expect((await sendApp(method, path, {}, alice.cookie.split("=")[1])).status).toBe(401);
  }

  expect(reads).toEqual([]);
  assistant.calls.length = 0;

  for (const [method, path] of routes) {
    // the account header guards browser pages only
    const response = await sendApp(method, path, {}, aliceToken, { [ACCOUNT_HEADER]: "bob" });
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(409);
  }

  expect(reads).toEqual([`bella:${alice.publicId}`, `account:${alice.publicId}`]);
  expect(assistant.calls.every((call) => call.accountId === alice.publicId)).toBe(true);

  reads.length = 0;
  await sendApp("GET", "/api/messages", undefined, bobToken);
  expect(reads).toEqual([`bella:${bob.publicId}`]);
  expect(await (await sendApp("GET", "/api/me", undefined, bobToken)).json()).toEqual({
    username: "bob",
    chats: [{ chatKey: "signal:+200", state: "active", linkedAt: 1_000 }],
  });

  // a cookie request keeps the Origin rule
  const noOrigin = await app.request("/api/model", {
    method: "PUT",
    headers: { Cookie: alice.cookie },
    body: "{}",
  });
  expect(noOrigin.status).toBe(403);
  expect((await send("PUT", "/api/model", {}, alice.cookie)).status).not.toBe(403);
});

test("the app reads its personality settings, changes each and reads the change back; an invalid change answers 400 and changes nothing; another account's are its own", async () => {
  const { sendApp, store } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");
  const bob = await registerApp(sendApp, store, "bob");
  const read = async (token: string) => {
    const response = await sendApp("GET", "/api/personality", undefined, token);
    return [response.status, await response.json()];
  };
  const change = async (token: string, body: unknown) => {
    const response = await sendApp("PUT", "/api/personality", body, token);
    return [response.status, await response.json()];
  };
  const defaults = {
    bellaPersona: "You are Bella.",
    plainChatsUseBellaPersona: true,
    plainChatsPersona: "",
  };

  expect(await read(alice.token)).toEqual([200, defaults]);
  expect((await change(alice.token, { bellaPersona: "Be brief." }))[0]).toBe(200);
  expect((await change(alice.token, { plainChatsUseBellaPersona: false }))[0]).toBe(200);
  expect((await change(alice.token, { plainChatsPersona: "Code in Kotlin." }))[0]).toBe(200);
  const changed = {
    bellaPersona: "Be brief.",
    plainChatsUseBellaPersona: false,
    plainChatsPersona: "Code in Kotlin.",
  };
  expect(await read(alice.token)).toEqual([200, changed]);

  // refused at the edge
  for (const body of [{ plainChatsUseBellaPersona: "no" }, { bellaPersona: 1 }, { mood: "dark" }]) {
    expect((await change(alice.token, body))[0]).toBe(400);
  }
  expect(await read(alice.token)).toEqual([200, changed]);

  // another account reads and changes only its own
  expect(await read(bob.token)).toEqual([200, defaults]);
  expect((await change(bob.token, { plainChatsPersona: "Bob's" }))[0]).toBe(200);
  expect(await read(alice.token)).toEqual([200, changed]);
});

// the assistant's database in a temporary file, migrated, with the reader the dashboard uses on it
async function createAssistantDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "bellaclaw-dashboard-history-"));
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
async function registerApp(
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

test("an app account with no chat lists its Bella conversation, sends, and reads its history by cursor with the revisions", async () => {
  const database = await createAssistantDatabase();

  try {
    const { sendApp, assistant, store } = createTestApp(":memory:", database.reader);
    const alice = await registerApp(sendApp, store, "alice");
    const conversationKey = `bella:${alice.publicId}`;
    const path = `/api/conversations/${encodeURIComponent(conversationKey)}/messages`;

    // before its first message the conversation is listed, empty, at revision 0
    const list = await sendApp("GET", "/api/conversations", undefined, alice.token);
    expect(await list.json()).toEqual({
      conversations: [{ conversationKey, kind: "bella", revision: 0, rewriteRevision: 0 }],
    });
    expect(await (await sendApp("GET", path, undefined, alice.token)).json()).toEqual({
      revision: 0,
      rewriteRevision: 0,
      messages: [],
    });

    // the same message twice: forwarded with the client's id, answered the same
    const message = { clientMessageId: "m-1", text: "Hello" };
    const first = await sendApp("POST", path, message, alice.token);
    const second = await sendApp("POST", path, message, alice.token);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual({ clientMessageId: "m-1" });
    expect(await second.json()).toEqual({ clientMessageId: "m-1" });
    expect(assistant.sends).toEqual([
      { accountId: alice.publicId, conversationKey, message },
      { accountId: alice.publicId, conversationKey, message },
    ]);

    // the assistant stores the turn and its reply, and raises the revision
    const user = await database.insertRow(conversationKey, "user", "message", "Hello", "m-1");
    await database.insertRow(conversationKey, "assistant", "tool", "a tool call");
    const reply = await database.insertRow(conversationKey, "assistant", "message", "Hi");
    await database.setRevision(conversationKey, `account:${alice.publicId}`, 2, 0);

    const history = await sendApp("GET", path, undefined, alice.token);
    expect(await history.json()).toEqual({
      revision: 2,
      rewriteRevision: 0,
      messages: [
        {
          id: user.id,
          author: "user",
          kind: "message",
          channel: "app",
          text: "Hello",
          createdAt: 1_000,
          clientMessageId: "m-1",
        },
        {
          id: reply.id,
          author: "assistant",
          kind: "message",
          channel: "app",
          text: "Hi",
          createdAt: 1_000,
        },
      ],
    });

    // a command and its reply are display rows; a fetch by cursor returns only the missing rows
    const command = await database.insertRow(conversationKey, "user", "display", "!help", "m-2");
    const answer = await database.insertRow(conversationKey, "assistant", "display", "Commands");
    await database.setRevision(conversationKey, `account:${alice.publicId}`, 3, 0);
    const appended = await (
      await sendApp("GET", `${path}?after=${reply.id}`, undefined, alice.token)
    ).json();
    expect(appended.revision).toBe(3);
    expect(appended.rewriteRevision).toBe(0);
    expect(
      appended.messages.map((row: { id: number; kind: string }) => [row.id, row.kind]),
    ).toEqual([
      [command.id, "display"],
      [answer.id, "display"],
    ]);

    const both = await sendApp("GET", `${path}?after=1&before=9`, undefined, alice.token);
    expect(both.status).toBe(400);
  } finally {
    await database.remove();
  }
});

test("history pages older rows by before and newer rows by after", async () => {
  const database = await createAssistantDatabase();

  try {
    const { sendApp, store } = createTestApp(":memory:", database.reader);
    const alice = await registerApp(sendApp, store, "alice");
    const conversationKey = `bella:${alice.publicId}`;
    const path = `/api/conversations/${encodeURIComponent(conversationKey)}/messages`;
    const ids: number[] = [];

    for (let index = 0; index < 52; index++) {
      ids.push((await database.insertRow(conversationKey, "user", "message", `m${index}`)).id);
    }

    await database.setRevision(conversationKey, `account:${alice.publicId}`, 52, 0);
    const idsOf = (body: { messages: { id: number }[] }) => body.messages.map((row) => row.id);

    const newest = await (await sendApp("GET", path, undefined, alice.token)).json();
    expect(idsOf(newest)).toEqual(ids.slice(2));
    expect(newest.nextBefore).toBe(ids[2]);

    const older = await (
      await sendApp("GET", `${path}?before=${newest.nextBefore}`, undefined, alice.token)
    ).json();
    expect(idsOf(older)).toEqual(ids.slice(0, 2));
    expect(older.nextBefore).toBeUndefined();

    const after = await (
      await sendApp("GET", `${path}?after=${ids[0]}`, undefined, alice.token)
    ).json();
    expect(idsOf(after)).toEqual(ids.slice(1, 51));
    expect(after.nextAfter).toBe(ids[50]);
  } finally {
    await database.remove();
  }
});

test("another account's conversation is answered like one that does not exist, for reading and sending", async () => {
  const database = await createAssistantDatabase();

  try {
    const { sendApp, assistant, store } = createTestApp(":memory:", database.reader);
    const alice = await registerApp(sendApp, store, "alice");
    const bob = await registerApp(sendApp, store, "bob");
    const aliceConversation = `bella:${alice.publicId}`;
    await database.insertRow(aliceConversation, "user", "message", "secret");
    await database.setRevision(aliceConversation, `account:${alice.publicId}`, 1, 0);
    // an unlinked Signal chat owns itself
    await database.insertRow("signal:+100", "user", "message", "other secret");
    await database.setRevision("signal:+100", "signal:+100", 1, 0);
    const message = { clientMessageId: "m-1", text: "Hello" };
    const answers: [number, unknown][] = [];

    for (const conversationKey of [aliceConversation, "signal:+100", "bella:nobody"]) {
      const path = `/api/conversations/${encodeURIComponent(conversationKey)}/messages`;

      for (const response of [
        await sendApp("GET", path, undefined, bob.token),
        await sendApp("GET", `${path}?after=1`, undefined, bob.token),
        await sendApp("POST", path, message, bob.token),
      ]) {
        answers.push([response.status, await response.json()]);
      }
    }

    expect(answers).toEqual(Array(9).fill([404, { error: "Not found" }]));
    expect(assistant.sends).toEqual([]);

    // the list names only the account's own conversation
    const list = await (await sendApp("GET", "/api/conversations", undefined, bob.token)).json();
    expect(
      list.conversations.map((row: { conversationKey: string }) => row.conversationKey),
    ).toEqual([`bella:${bob.publicId}`]);

    // no session, no conversation
    const path = `/api/conversations/${encodeURIComponent(aliceConversation)}/messages`;
    expect((await sendApp("GET", path, undefined, "not-a-session")).status).toBe(401);
    expect((await sendApp("POST", path, message, "not-a-session")).status).toBe(401);
  } finally {
    await database.remove();
  }
});

test("the app creates a plain chat, lists it, sends with a model, reads the reply, deletes it and gets 404 after; another account's plain chat does not exist for it", async () => {
  const database = await createAssistantDatabase();

  try {
    const { sendApp, assistant, store } = createTestApp(":memory:", database.reader);
    const alice = await registerApp(sendApp, store, "alice");
    const bob = await registerApp(sendApp, store, "bob");
    const chat = `plain:${alice.publicId}:chat-1`;
    const deleted: string[] = [];
    // the assistant's side: Conversation lists the chat, and deletes it with its rows
    assistant.internalApi.createConversation = async (accountId) => {
      await database.createPlain(chat, `account:${accountId}`);
      return { data: { conversationKey: chat, createdAt: 500 } };
    };
    assistant.internalApi.deleteConversation = async (_accountId, conversationKey) => {
      deleted.push(conversationKey);
      await database.removeConversation(conversationKey);
      return { data: { conversationKey } };
    };

    const created = await sendApp("POST", "/api/conversations", undefined, alice.token);
    expect([created.status, await created.json()]).toEqual([
      200,
      { conversationKey: chat, createdAt: 500 },
    ]);
    const list = async (token: string) =>
      (await (await sendApp("GET", "/api/conversations", undefined, token)).json()).conversations;
    expect(await list(alice.token)).toEqual([
      {
        conversationKey: `bella:${alice.publicId}`,
        kind: "bella",
        revision: 0,
        rewriteRevision: 0,
      },
      { conversationKey: chat, kind: "plain", revision: 0, rewriteRevision: 0, createdAt: 500 },
    ]);

    const path = `/api/conversations/${encodeURIComponent(chat)}/messages`;
    const model = { provider: "openrouter", model: "openai/gpt-5", effort: "low" as const };
    const message = { clientMessageId: "m-1", text: "Hello", model };
    const sent = await sendApp("POST", path, message, alice.token);
    expect([sent.status, await sent.json()]).toEqual([200, { clientMessageId: "m-1" }]);
    expect(assistant.sends).toEqual([
      { accountId: alice.publicId, conversationKey: chat, message },
    ]);
    const badEffort = { ...message, model: { ...model, effort: "loud" } };
    expect((await sendApp("POST", path, badEffort, alice.token)).status).toBe(400);

    // the assistant stores the turn and its reply
    await database.insertRow(chat, "user", "message", "Hello", "m-1");
    const reply = await database.insertRow(chat, "assistant", "message", "Hi from the model");
    await database.setRevision(chat, `account:${alice.publicId}`, 2, 0);
    const history = await (await sendApp("GET", path, undefined, alice.token)).json();
    expect(history.revision).toBe(2);
    expect(history.messages.map((row: { text: string }) => row.text)).toEqual([
      "Hello",
      "Hi from the model",
    ]);
    expect((await list(alice.token))[1]).toMatchObject({
      conversationKey: chat,
      kind: "plain",
      lastMessage: { id: reply.id, text: "Hi from the model" },
    });

    // another account: reading, sending and deleting answer like a chat that does not exist
    const chatPath = `/api/conversations/${encodeURIComponent(chat)}`;
    const answers: [number, unknown][] = [];

    for (const response of [
      await sendApp("GET", path, undefined, bob.token),
      await sendApp("POST", path, { ...message, clientMessageId: "m-2" }, bob.token),
      await sendApp("DELETE", chatPath, undefined, bob.token),
    ]) {
      answers.push([response.status, await response.json()]);
    }

    expect(answers).toEqual(Array(3).fill([404, { error: "Not found" }]));
    expect(assistant.sends).toHaveLength(1);
    expect(deleted).toEqual([]);
    expect((await list(bob.token)).map((row: { kind: string }) => row.kind)).toEqual(["bella"]);

    const removed = await sendApp("DELETE", chatPath, undefined, alice.token);
    expect([removed.status, await removed.json()]).toEqual([200, { conversationKey: chat }]);
    expect(deleted).toEqual([chat]);

    // gone: history, sends and a second delete are 404, and the list holds only Bella
    for (const response of [
      await sendApp("GET", path, undefined, alice.token),
      await sendApp("POST", path, { ...message, clientMessageId: "m-3" }, alice.token),
      await sendApp("DELETE", chatPath, undefined, alice.token),
    ]) {
      expect([response.status, await response.json()]).toEqual([404, { error: "Not found" }]);
    }

    expect((await list(alice.token)).map((row: { kind: string }) => row.kind)).toEqual(["bella"]);
    expect((await sendApp("POST", "/api/conversations", undefined, "not-a-session")).status).toBe(
      401,
    );
  } finally {
    await database.remove();
  }
});

test("a deleted plain chat reaches the phone's stream", async () => {
  const following = new AbortController();

  try {
    const { sendApp, assistant, store, liveStream } = createTestApp();
    const alice = await registerApp(sendApp, store, "alice");
    const follow = liveStream.follow(following.signal);
    await waitUntil(() => assistant.streams.length === 1);
    const stream = await openAppStream(sendApp, alice.token);
    expect(await stream.drain()).toEqual([{ type: "check" }]);

    const conversationKey = `plain:${alice.publicId}:chat-1`;
    assistant.push({ type: "deleted", accountId: alice.publicId, conversationKey });
    expect(await stream.drain()).toEqual([{ type: "deleted", conversationKey }]);

    await stream.close();
    following.abort();
    await follow;
  } finally {
    following.abort();
  }
});

test("a confidential reply reaches the account's app streams only", async () => {
  const following = new AbortController();

  try {
    const { send, sendApp, register, assistant, store, liveStream } = createTestApp();
    const alice = await register("alice", "signal:+100");
    const loggedIn = await sendApp("POST", "/api/login", { username: "alice", password: PASSWORD });
    const aliceToken = String((await loggedIn.json()).token);
    const bob = await registerApp(sendApp, store, "bob");
    const follow = liveStream.follow(following.signal);
    await waitUntil(() => assistant.streams.length === 1);

    const aliceApp = await openAppStream(sendApp, aliceToken);
    const bobApp = await openAppStream(sendApp, bob.token);
    const browser = await send("GET", "/api/stream", undefined, alice.cookie);
    const browserReader = browser.body?.getReader();
    expect(await aliceApp.drain()).toEqual([{ type: "check" }]);
    expect(await bobApp.drain()).toEqual([{ type: "check" }]);

    const conversationKey = `bella:${alice.publicId}`;
    assistant.push({
      type: "reply",
      accountId: alice.publicId ?? "",
      conversationKey,
      text: "https://example.test/login",
    });
    // the browser's stream reads up to this nudge, after the reply
    assistant.push({
      type: "changed",
      accountId: alice.publicId ?? "",
      conversationKey,
      revision: 1,
      rewriteRevision: 0,
    });

    expect((await aliceApp.drain())[0]).toEqual({
      type: "reply",
      conversationKey,
      text: "https://example.test/login",
    });
    expect(await bobApp.drain()).toEqual([]);

    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("event: changed")) {
      const chunk = await browserReader?.read();
      received += decoder.decode(chunk?.value);
    }
    expect(received).not.toContain("event: reply");

    await aliceApp.close();
    await bobApp.close();
    await browserReader?.cancel();
    following.abort();
    await follow;
  } finally {
    following.abort();
  }
});

// polls until check holds; a few seconds at most
async function waitUntil(check: () => boolean) {
  for (let attempt = 0; attempt < 1_000 && !check(); attempt++) {
    await Bun.sleep(1);
  }

  expect(check()).toBe(true);
}

// a phone's event stream: events holds what was read so far, drain reads what has arrived;
// state.ended: the stream ended
async function openAppStream(sendApp: ReturnType<typeof createTestApp>["sendApp"], bearer: string) {
  const response = await sendApp("GET", "/api/stream", undefined, bearer);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  const reader = response.body?.getReader();

  if (reader === undefined) {
    throw new Error("The stream has no body");
  }

  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  const state = { ended: false };
  let buffered = "";
  let pending = reader.read();

  return {
    events,
    state,
    // reads until nothing more arrives within a moment; returns the events read by this call
    async drain() {
      const start = events.length;

      while (true) {
        const chunk = await Promise.race([pending, Bun.sleep(20).then(() => undefined)]);

        if (chunk === undefined || chunk.done) {
          state.ended = chunk?.done === true;
          return events.slice(start);
        }

        pending = reader.read();
        buffered += decoder.decode(chunk.value);
        const blocks = buffered.split("\n\n");
        buffered = blocks.pop() ?? "";

        for (const block of blocks) {
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];

          if (type !== undefined && data !== undefined) {
            events.push({ type, ...JSON.parse(data) });
          }
        }
      }
    },
    close: () => reader.cancel(),
  };
}

// counts the open subscriptions of the edge's fan-out
function countSubscriptions(liveStream: ReturnType<typeof createLiveStream>) {
  const counter = { open: 0 };
  const subscribe = liveStream.subscribe;
  liveStream.subscribe = (accountId, listener, app) => {
    counter.open += 1;
    const close = subscribe(accountId, listener, app);

    return () => {
      counter.open -= 1;
      close();
    };
  };

  return counter;
}

test("the phone sees typing start and stop, then a nudge, then the reply in history; another account's stream carries none of it", async () => {
  const database = await createAssistantDatabase();
  const following = new AbortController();

  try {
    const { sendApp, assistant, store, liveStream } = createTestApp(":memory:", database.reader);
    const subscriptions = countSubscriptions(liveStream);
    const alice = await registerApp(sendApp, store, "alice");
    const bob = await registerApp(sendApp, store, "bob");
    const conversationKey = `bella:${alice.publicId}`;
    const path = `/api/conversations/${encodeURIComponent(conversationKey)}/messages`;
    const follow = liveStream.follow(following.signal);
    await waitUntil(() => assistant.streams.length === 1);

    const aliceStream = await openAppStream(sendApp, alice.token);
    const bobStream = await openAppStream(sendApp, bob.token);
    // each opens with a check: compare revisions for what changed before it connected
    expect(await aliceStream.drain()).toEqual([{ type: "check" }]);
    expect(await bobStream.drain()).toEqual([{ type: "check" }]);
    const synced = await (await sendApp("GET", path, undefined, alice.token)).json();
    expect(synced).toEqual({ revision: 0, rewriteRevision: 0, messages: [] });

    await sendApp("POST", path, { clientMessageId: "m-1", text: "Hello" }, alice.token);
    // the turn, as the assistant streams it: typing on, the user's row, typing off, the reply
    const user = await database.insertRow(conversationKey, "user", "message", "Hello", "m-1");
    await database.setRevision(conversationKey, `account:${alice.publicId}`, 1, 0);
    const accountId = alice.publicId;
    assistant.push({ type: "typing", accountId, conversationKey, typing: true });
    assistant.push({
      type: "changed",
      accountId,
      conversationKey,
      revision: 1,
      rewriteRevision: 0,
    });
    const reply = await database.insertRow(conversationKey, "assistant", "message", "Hi");
    await database.setRevision(conversationKey, `account:${alice.publicId}`, 2, 0);
    assistant.push({ type: "typing", accountId, conversationKey, typing: false });
    assistant.push({
      type: "changed",
      accountId,
      conversationKey,
      revision: 2,
      rewriteRevision: 0,
    });

    expect(await aliceStream.drain()).toEqual([
      { type: "typing", conversationKey, typing: true },
      { type: "changed", conversationKey, revision: 1, rewriteRevision: 0 },
      { type: "typing", conversationKey, typing: false },
      { type: "changed", conversationKey, revision: 2, rewriteRevision: 0 },
    ]);
    expect(await bobStream.drain()).toEqual([]);

    // synced at 0, at or above the rewrite revision 0: a fetch by cursor has the reply
    const fetched = await (await sendApp("GET", path, undefined, alice.token)).json();
    expect(fetched.revision).toBe(2);
    expect(fetched.messages.map((row: { id: number; text: string }) => [row.id, row.text])).toEqual(
      [
        [user.id, "Hello"],
        [reply.id, "Hi"],
      ],
    );

    // closed streams leave no subscription behind
    expect(subscriptions.open).toBe(2);
    await aliceStream.close();
    await bobStream.close();
    expect(subscriptions.open).toBe(0);
    following.abort();
    await follow;
  } finally {
    following.abort();
    await database.remove();
  }
});

test("a phone that reconnects is told to check, sees the revision differ, and fetches the rows it missed; a delete is noticed by its rewrite revision", async () => {
  const database = await createAssistantDatabase();
  const following = new AbortController();

  try {
    const { sendApp, assistant, store, liveStream } = createTestApp(":memory:", database.reader);
    const alice = await registerApp(sendApp, store, "alice");
    const accountId = alice.publicId;
    const ownerKey = `account:${accountId}`;
    const conversationKey = `bella:${accountId}`;
    const path = `/api/conversations/${encodeURIComponent(conversationKey)}/messages`;
    const follow = liveStream.follow(following.signal);
    await waitUntil(() => assistant.streams.length === 1);
    const first = await database.insertRow(conversationKey, "user", "message", "Hello");
    await database.setRevision(conversationKey, ownerKey, 1, 0);

    const before = await openAppStream(sendApp, alice.token);
    expect(await before.drain()).toEqual([{ type: "check" }]);
    const synced = await (await sendApp("GET", path, undefined, alice.token)).json();
    expect(synced.revision).toBe(1);
    await before.close();

    // with the stream closed, a Signal message of the linked address is answered on Signal and
    // stored in the account's conversation; its events reach no phone
    await database.insertRow(conversationKey, "user", "message", "Hi from Signal");
    const reply = await database.insertRow(conversationKey, "assistant", "message", "Reply");
    await database.setRevision(conversationKey, ownerKey, 3, 0);
    const seen: unknown[] = [];
    const stopWatching = liveStream.subscribe(accountId, (event) => seen.push(event), false);
    assistant.push({
      type: "changed",
      accountId,
      conversationKey,
      revision: 3,
      rewriteRevision: 0,
    });
    await waitUntil(() => seen.length === 1);
    stopWatching();

    const after = await openAppStream(sendApp, alice.token);
    expect(await after.drain()).toEqual([{ type: "check" }]);
    const list = await (await sendApp("GET", "/api/conversations", undefined, alice.token)).json();
    expect(list.conversations[0]).toMatchObject({ revision: 3, rewriteRevision: 0 });
    // the rewrite revision is at or below the synced revision: fetch by cursor
    const missed = await (
      await sendApp("GET", `${path}?after=${synced.messages.at(-1).id}`, undefined, alice.token)
    ).json();
    expect(missed.messages.map((row: { text: string }) => row.text)).toEqual([
      "Hi from Signal",
      "Reply",
    ]);

    // a message deleted in the dashboard: a nudge whose rewrite revision passed the synced one
    await database.deleteRow(reply.id);
    await database.setRevision(conversationKey, ownerKey, 4, 4);
    assistant.push({
      type: "changed",
      accountId,
      conversationKey,
      revision: 4,
      rewriteRevision: 4,
    });
    expect(await after.drain()).toEqual([
      { type: "changed", conversationKey, revision: 4, rewriteRevision: 4 },
    ]);
    // synced at 3, below 4: a reload
    const reloaded = await (await sendApp("GET", path, undefined, alice.token)).json();
    expect(reloaded.messages.map((row: { id: number }) => row.id)).not.toContain(reply.id);
    expect(reloaded.messages[0].id).toBe(first.id);

    await after.close();
    following.abort();
    await follow;
  } finally {
    following.abort();
    await database.remove();
  }
});

test("when the edge loses the assistant's stream, connected phones are told to check, and the edge connects again", async () => {
  const following = new AbortController();
  const { sendApp, assistant, store, liveStream } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");
  const accountId = alice.publicId;
  const conversationKey = `bella:${accountId}`;
  const follow = liveStream.follow(following.signal);
  await waitUntil(() => assistant.streams.length === 1);
  const stream = await openAppStream(sendApp, alice.token);
  expect(await stream.drain()).toEqual([{ type: "check" }]);

  assistant.drop();
  await waitUntil(() => assistant.streams.length === 2);
  // one check when the stream drops, one when it opens again
  expect(await stream.drain()).toEqual([{ type: "check" }, { type: "check" }]);

  assistant.push({ type: "typing", accountId, conversationKey, typing: true });
  expect(await stream.drain()).toEqual([{ type: "typing", conversationKey, typing: true }]);

  await stream.close();
  following.abort();
  await follow;
  expect(assistant.streams).toHaveLength(2);
});

test("when the assistant's stream stays open but silent, the edge drops it, tells phones to check and connects again", async () => {
  const following = new AbortController();
  const { sendApp, assistant, store, liveStream } = createTestApp(":memory:", undefined, 100);
  const alice = await registerApp(sendApp, store, "alice");
  const stream = await openAppStream(sendApp, alice.token);
  const follow = liveStream.follow(following.signal);

  await waitUntil(() => assistant.streams.length === 2);
  // the phone's own check, then: opened, dropped as silent, opened again
  expect(await stream.drain()).toEqual([
    { type: "check" },
    { type: "check" },
    { type: "check" },
    { type: "check" },
  ]);

  await stream.close();
  following.abort();
  await follow;
});

test("the stream needs a session", async () => {
  const { sendApp } = createTestApp();
  const response = await sendApp("GET", "/api/stream", undefined, "not-a-session");

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});

test("a stream ends with its session: logout and a new password set through a login link stop its events", async () => {
  const following = new AbortController();
  const { sendApp, register, token, assistant, liveStream } = createTestApp();
  const subscriptions = countSubscriptions(liveStream);
  const alice = await register("alice", "signal:+100");
  const login = async () =>
    String(
      (
        await (
          await sendApp("POST", "/api/login", { username: "alice", password: PASSWORD })
        ).json()
      ).token,
    );
  const first = await login();
  const second = await login();
  const accountId = String(alice.publicId);
  const conversationKey = `bella:${accountId}`;
  const follow = liveStream.follow(following.signal);
  await waitUntil(() => assistant.streams.length === 1);
  const firstStream = await openAppStream(sendApp, first);
  const secondStream = await openAppStream(sendApp, second);
  expect(await firstStream.drain()).toEqual([{ type: "check" }]);
  expect(await secondStream.drain()).toEqual([{ type: "check" }]);

  expect((await sendApp("POST", "/api/logout", undefined, second)).status).toBe(200);
  assistant.push({ type: "typing", accountId, conversationKey, typing: true });
  expect(await secondStream.drain()).toEqual([]);
  expect(secondStream.state.ended).toBe(true);
  expect(await firstStream.drain()).toEqual([{ type: "typing", conversationKey, typing: true }]);
  expect(subscriptions.open).toBe(1);

  const reset = await sendApp("POST", "/api/link/login", {
    token: token("signal:+100"),
    password: "a brand new password",
  });
  expect(reset.status).toBe(200);
  assistant.push({ type: "typing", accountId, conversationKey, typing: false });
  expect(await firstStream.drain()).toEqual([]);
  expect(firstStream.state.ended).toBe(true);
  expect(subscriptions.open).toBe(0);

  following.abort();
  await follow;
});

test("an account's fifth stream ends its oldest; another account's streams stay", async () => {
  const { sendApp, store, liveStream } = createTestApp();
  const subscriptions = countSubscriptions(liveStream);
  const alice = await registerApp(sendApp, store, "alice");
  const bob = await registerApp(sendApp, store, "bob");
  const bobStream = await openAppStream(sendApp, bob.token);
  const streams = [];

  for (let opened = 0; opened < 5; opened += 1) {
    streams.push(await openAppStream(sendApp, alice.token));
  }

  for (const stream of [bobStream, ...streams]) {
    await stream.drain();
  }

  expect(streams.map((stream) => stream.state.ended)).toEqual([true, false, false, false, false]);
  expect(bobStream.state.ended).toBe(false);
  expect(subscriptions.open).toBe(5);

  for (const stream of [bobStream, ...streams.slice(1)]) {
    await stream.close();
  }

  expect(subscriptions.open).toBe(0);
});

test("HEAD of the stream opens no stream and no subscription", async () => {
  const { sendApp, store, liveStream } = createTestApp();
  const subscriptions = countSubscriptions(liveStream);
  const alice = await registerApp(sendApp, store, "alice");

  const response = await sendApp("HEAD", "/api/stream", undefined, alice.token);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  expect(subscriptions.open).toBe(0);
});

test("the app uploads an image through the edge, sends it, downloads it again with a fresh session, and another account reaches none of it", async () => {
  const database = await createAssistantDatabase();

  try {
    const { app, sendApp, assistant, store } = createTestApp(":memory:", database.reader);
    const alice = await registerApp(sendApp, store, "alice");
    const bob = await registerApp(sendApp, store, "bob");
    const conversationKey = `bella:${alice.publicId}`;
    const mediaPath = `/api/conversations/${encodeURIComponent(conversationKey)}/media`;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const upload = (token: string) =>
      app.request(mediaPath, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
        body: png,
      });
    const download = (token: string, mediaId: string) =>
      app.request(`${mediaPath}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });

    const uploaded = await upload(alice.token);
    expect([uploaded.status, await uploaded.json()]).toEqual([
      200,
      { id: "media-1", mimeType: "image/png" },
    ]);
    // the bytes stream on unchanged, with the declared type
    expect(assistant.uploads).toMatchObject([
      { accountId: alice.publicId, conversationKey, mimeType: "image/png" },
    ]);
    expect(new Uint8Array(assistant.uploads[0]?.data ?? new ArrayBuffer(0))).toEqual(png);

    const message = {
      clientMessageId: "m-1",
      text: "",
      images: [{ id: "media-1", mimeType: "image/png" }],
    };
    const sent = await sendApp(
      "POST",
      `/api/conversations/${encodeURIComponent(conversationKey)}/messages`,
      message,
      alice.token,
    );
    expect(sent.status).toBe(200);
    expect(assistant.sends).toEqual([{ accountId: alice.publicId, conversationKey, message }]);

    // a new session after a logout downloads the same bytes
    await sendApp("POST", "/api/logout", undefined, alice.token);
    expect((await download(alice.token, "media-1")).status).toBe(401);
    const loggedIn = await sendApp("POST", "/api/login", { username: "alice", password: PASSWORD });
    const { token } = await loggedIn.json();
    const again = await download(token, "media-1");
    expect([again.status, again.headers.get("Content-Type")]).toEqual([200, "image/png"]);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(png);

    // an image the assistant no longer keeps is gone
    const gone = await download(token, "media-9");
    expect([gone.status, await gone.json()]).toEqual([410, { error: "Gone" }]);

    // another account: its own session, the first account's conversation
    const bobUpload = await upload(bob.token);
    const bobDownload = await download(bob.token, "media-1");
    expect([bobUpload.status, bobDownload.status]).toEqual([404, 404]);
    expect(assistant.uploads).toHaveLength(1);
  } finally {
    await database.remove();
  }
});

test("only an upload may carry a body over 64 KiB", async () => {
  const database = await createAssistantDatabase();

  try {
    const { app, sendApp, assistant, store } = createTestApp(":memory:", database.reader);
    const alice = await registerApp(sendApp, store, "alice");
    const conversationKey = encodeURIComponent(`bella:${alice.publicId}`);
    const large = new Uint8Array(65_537);
    const post = (path: string) =>
      app.request(path, {
        method: "POST",
        // as the server receives it; a request built here has no such header
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "image/png",
          "Content-Length": String(large.byteLength),
        },
        body: large,
      });

    const message = await post(`/api/conversations/${conversationKey}/messages`);
    expect([message.status, await message.json()]).toEqual([
      413,
      { error: "Request body too large" },
    ]);
    expect((await post(`/api/conversations/${conversationKey}/media`)).status).toBe(200);
    expect(assistant.uploads).toHaveLength(1);

    // a chunked body declares no length
    const chunked = await app.request(`/api/conversations/${conversationKey}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
      body: new Blob([
        JSON.stringify({ clientMessageId: "m-1", text: "a".repeat(65_537) }),
      ]).stream(),
    });
    expect(chunked.status).toBe(400);
    expect(assistant.sends).toHaveLength(0);
  } finally {
    await database.remove();
  }
});

test("history lists a user message's images: an app image while the assistant keeps it, else a placeholder, and always a placeholder for a Signal image", async () => {
  const database = await createAssistantDatabase();

  try {
    const { sendApp, store } = createTestApp(":memory:", database.reader);
    const alice = await registerApp(sendApp, store, "alice");
    const conversationKey = `bella:${alice.publicId}`;
    const image = (id: string, channel: string) => ({
      id,
      mimeType: "image/png",
      channel,
      sourceAddress: alice.publicId,
    });
    await database.db.insert(memoriesTable).values({
      chatId: conversationKey,
      channel: "app",
      author: "user",
      kind: "message",
      message: "Look [Image] [Image] [Image]",
      attachments: JSON.stringify([
        image("kept", "app"),
        image("deleted", "app"),
        image("signal-1", "signal"),
      ]),
      createdAt: new Date(1_000),
    });
    await database.insertRow(conversationKey, "assistant", "message", "Nice");
    await database.db.insert(appMediaTable).values({
      id: "kept",
      accountId: alice.publicId,
      conversationKey,
      mimeType: "image/png",
      createdAt: new Date(1_000),
    });

    const response = await sendApp(
      "GET",
      `/api/conversations/${encodeURIComponent(conversationKey)}/messages`,
      undefined,
      alice.token,
    );
    const { messages } = await response.json();
    expect(messages).toMatchObject([
      {
        author: "user",
        text: "Look [Image] [Image] [Image]",
        images: [
          { mediaId: "kept", mimeType: "image/png" },
          { mimeType: "image/png" },
          { mimeType: "image/png" },
        ],
      },
      { author: "assistant", text: "Nice" },
    ]);
    expect(messages[0].images[1].mediaId).toBeUndefined();
    expect(messages[0].images[2].mediaId).toBeUndefined();
    expect(messages[1].images).toBeUndefined();
  } finally {
    await database.remove();
  }
});

// real P-256 public keys, uncompressed, base64url
const PUBLIC_KEYS = [
  "BA45xSmkpu16iOb3SDdemng3MY0BBUBpXQTZ9_u_XrgBhMbbDrSUSmJs3hm6zHVYq1DuFSV7hLcvavZQMDe4UkM",
  "BK0NaeMoGRCI4PAxQ1dSlLqaFvREgqUAxC-3HUWgt3y8p-tA24e65EW5mBBtfZ4psKk118_YVeyD9_YEMuKyxWM",
];

// RFC 8291 key material of PUBLIC_KEYS[index], base64url
function deviceKeys(index: number) {
  return {
    fcmToken: `token-${index}`,
    publicKey: PUBLIC_KEYS[index] ?? "",
    authSecret: Buffer.from(new Uint8Array(16).fill(index + 1)).toString("base64url"),
  };
}

test("each app session registers its own device and unregisters it; the web client and malformed or off-curve keys are refused", async () => {
  const { send, sendApp, register, store, assistant } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");
  const web = await register("bob", "signal:+100");
  const deviceId = store.findAppSessionDevice(alice.token) ?? "";

  const registered = await sendApp("PUT", "/api/device", deviceKeys(0), alice.token);
  expect(registered.status).toBe(200);
  expect(await registered.json()).toEqual({ ok: true });
  // again with a refreshed token: the assistant replaces it
  expect((await sendApp("PUT", "/api/device", deviceKeys(1), alice.token)).status).toBe(200);
  expect([...assistant.devices]).toEqual([
    [deviceId, { accountId: alice.publicId, registration: deviceKeys(1) }],
  ]);

  // another session of the account is another device
  const phone = (
    await (await sendApp("POST", "/api/login", { username: "alice", password: PASSWORD })).json()
  ).token;
  expect((await sendApp("PUT", "/api/device", deviceKeys(0), phone)).status).toBe(200);
  expect(assistant.devices.size).toBe(2);
  expect(store.findAppSessionDevice(phone)).not.toBe(deviceId);

  expect((await send("PUT", "/api/device", deviceKeys(0), web.cookie)).status).toBe(403);
  expect((await send("DELETE", "/api/device", undefined, web.cookie)).status).toBe(403);
  const offCurve = new Uint8Array(65);
  offCurve[0] = 0x04;
  for (const body of [
    { ...deviceKeys(0), publicKey: deviceKeys(0).authSecret },
    { ...deviceKeys(0), publicKey: Buffer.from(offCurve).toString("base64url") },
    { ...deviceKeys(0), authSecret: deviceKeys(0).publicKey },
    { ...deviceKeys(0), fcmToken: "" },
  ]) {
    expect((await sendApp("PUT", "/api/device", body, alice.token)).status).toBe(400);
  }
  expect(assistant.devices.get(deviceId)?.registration).toEqual(deviceKeys(1));

  expect((await sendApp("DELETE", "/api/device", undefined, alice.token)).status).toBe(200);
  expect(assistant.devices.has(deviceId)).toBe(false);
  expect((await sendApp("DELETE", "/api/device", undefined, alice.token)).status).toBe(404);
});

test("logout unregisters the session's device; when the assistant cannot, the session stays for another try", async () => {
  const { sendApp, store, assistant } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");
  const deviceId = store.findAppSessionDevice(alice.token) ?? "";
  await sendApp("PUT", "/api/device", deviceKeys(0), alice.token);

  assistant.state.unreachableCalls = 1;
  expect((await sendApp("POST", "/api/logout", undefined, alice.token)).status).toBe(502);
  expect(assistant.devices.has(deviceId)).toBe(true);
  expect((await sendApp("GET", "/api/me", undefined, alice.token)).status).toBe(200);

  expect((await sendApp("POST", "/api/logout", undefined, alice.token)).status).toBe(200);
  expect(assistant.devices.has(deviceId)).toBe(false);
  expect((await sendApp("GET", "/api/me", undefined, alice.token)).status).toBe(401);

  // a session that registered no device logs out too
  const bob = await registerApp(sendApp, store, "bob");
  expect((await sendApp("POST", "/api/logout", undefined, bob.token)).status).toBe(200);
});

test("a new password set through a login link unregisters the account's devices first; when the assistant cannot, nothing changes", async () => {
  const { sendApp, register, token, store, assistant } = createTestApp();
  await register("alice", "signal:+100");
  const phone = (
    await (await sendApp("POST", "/api/login", { username: "alice", password: PASSWORD })).json()
  ).token;
  await sendApp("PUT", "/api/device", deviceKeys(0), phone);
  const plain = (
    await (await sendApp("POST", "/api/link/login", { token: token("signal:+100") })).json()
  ).token;
  await sendApp("PUT", "/api/device", deviceKeys(1), plain);
  const bob = await registerApp(sendApp, store, "bob");
  await sendApp("PUT", "/api/device", deviceKeys(0), bob.token);
  const passwordHash = store.findCredentials("alice")?.passwordHash;

  // a login link without a password ends nothing
  await sendApp("POST", "/api/link/login", { token: token("signal:+100") });
  expect(assistant.devices.size).toBe(3);

  const unregisterAccountDevices = assistant.internalApi.unregisterAccountDevices;
  assistant.internalApi.unregisterAccountDevices = async () => ({
    error: "The assistant is unavailable",
    status: 502,
  });
  const link = token("signal:+100");
  const refused = await sendApp("POST", "/api/link/login", {
    token: link,
    password: "a brand new password",
  });
  expect(refused.status).toBe(502);
  expect(store.findCredentials("alice")?.passwordHash).toBe(passwordHash);
  expect((await sendApp("GET", "/api/me", undefined, phone)).status).toBe(200);
  expect((await sendApp("GET", "/api/me", undefined, plain)).status).toBe(200);
  expect(assistant.devices.size).toBe(3);

  assistant.internalApi.unregisterAccountDevices = unregisterAccountDevices;
  const reset = await sendApp("POST", "/api/link/login", {
    token: link,
    password: "a brand new password",
  });
  expect(reset.status).toBe(200);
  expect((await sendApp("GET", "/api/me", undefined, phone)).status).toBe(401);
  expect([...assistant.devices.values()].map((device) => device.accountId)).toEqual([bob.publicId]);
});

test("the edge reports every account with an open stream on each connection and when an account's first stream opens or last closes", async () => {
  const following = new AbortController();
  const { sendApp, assistant, store, liveStream } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");
  const bob = await registerApp(sendApp, store, "bob");
  // no connection yet: nothing is reported
  const early = await openAppStream(sendApp, alice.token);
  expect(assistant.presence).toEqual([]);

  const follow = liveStream.follow(following.signal);
  await waitUntil(() => assistant.presence.length === 1);
  expect(assistant.presence).toEqual([[alice.publicId]]);

  const second = await openAppStream(sendApp, alice.token);
  const other = await openAppStream(sendApp, bob.token);
  await waitUntil(() => assistant.presence.length === 2);
  expect(assistant.presence[1]).toEqual([alice.publicId, bob.publicId]);

  // alice still has a stream open
  await early.close();
  await Bun.sleep(5);
  expect(assistant.presence).toHaveLength(2);
  await other.close();
  await waitUntil(() => assistant.presence.length === 3);
  expect(assistant.presence[2]).toEqual([alice.publicId]);

  // a new connection reports the whole set again
  assistant.drop();
  await waitUntil(() => assistant.presence.length === 4);
  expect(assistant.presence[3]).toEqual([alice.publicId]);

  await second.close();
  await waitUntil(() => assistant.presence.length === 5);
  expect(assistant.presence[4]).toEqual([]);

  following.abort();
  await follow;
});

test("a browser's stream receives events but does not count toward presence", async () => {
  const following = new AbortController();
  const { send, register, assistant, liveStream } = createTestApp();
  const web = await register("bob", "signal:+100");
  const follow = liveStream.follow(following.signal);
  await waitUntil(() => assistant.presence.length === 1);

  const response = await send("GET", "/api/stream", undefined, web.cookie);
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let received = "";
  assistant.push({
    type: "changed",
    accountId: web.publicId ?? "",
    conversationKey: "bella:bob",
    revision: 1,
    rewriteRevision: 0,
  });
  while (!received.includes("event: changed")) {
    const chunk = await reader?.read();
    received += decoder.decode(chunk?.value);
  }
  await Bun.sleep(5);
  expect(assistant.presence).toEqual([[]]);

  await reader?.cancel();
  following.abort();
  await follow;
});

test("a failed presence report is sent again until one succeeds", async () => {
  const following = new AbortController();
  const { sendApp, assistant, store, liveStream } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");
  const follow = liveStream.follow(following.signal);
  await waitUntil(() => assistant.presence.length === 1);

  assistant.state.failingPresenceReports = 1;
  const stream = await openAppStream(sendApp, alice.token);
  await waitUntil(() => assistant.presence.length === 2);
  expect(assistant.presence[1]).toEqual([alice.publicId]);
  expect(assistant.state.failingPresenceReports).toBe(0);

  await stream.close();
  following.abort();
  await follow;
});
