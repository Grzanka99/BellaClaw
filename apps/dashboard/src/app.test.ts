import { Database } from "bun:sqlite";
import { expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardLinkToken } from "@bellaclaw/shared";
import { ACCOUNT_HEADER } from "./account-header";
import { AccountStore } from "./account-store";
import { CLIENT_HEADER, createApp } from "./app";
import { createFakeAssistant } from "./test-utils";

const ORIGIN = "https://dashboard.test";
const SECRET = "test-secret";
const PASSWORD = "correct horse battery";

// an app on a store at path, in memory by default, and a fake assistant; reads collects the keys
// the reader got
function createTestApp(path = ":memory:") {
  const reads: string[] = [];
  const assistant = createFakeAssistant();
  const store = new AccountStore(path);
  const app = createApp({
    config: { publicOrigin: ORIGIN, secret: SECRET },
    store,
    reader: {
      listMessages: async (conversationKey) => {
        reads.push(conversationKey);

        return [];
      },
      listFacts: async (ownerKey) => {
        reads.push(ownerKey);

        return [];
      },
    },
    internalApi: assistant.internalApi,
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

  return { app, send, sendApp, register, token, cookieOf, reads, assistant, store };
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

test("a login link whose account read fails uses nothing: no session, password and link unchanged", async () => {
  const { send, register, token, assistant } = createTestApp();
  await register("alice", "signal:+100");
  const link = token("signal:+100");
  const getAccount = assistant.internalApi.getAccount;
  let failures = 1;
  assistant.internalApi.getAccount = async (accountId) => {
    if (failures > 0) {
      failures -= 1;

      return { error: "The assistant is unavailable", status: 502 };
    }

    return getAccount(accountId);
  };

  const failed = await send("POST", "/api/link/login", {
    token: link,
    password: "a brand new password",
  });
  expect(failed.status).toBe(502);
  expect(failed.headers.get("Set-Cookie")).toBeNull();
  expect((await send("POST", "/api/login", { username: "alice", password: PASSWORD })).status).toBe(
    200,
  );
  expect(await (await send("POST", "/api/link/check", { token: link })).json()).toEqual({
    valid: true,
    chatKey: "signal:+100",
    username: "alice",
  });

  const again = await send("POST", "/api/link/login", { token: link });
  expect(again.status).toBe(200);
});

// the number of session rows of the store
function countSessions(store: AccountStore) {
  // biome-ignore lint/complexity/useLiteralKeys: a private field, read for the check
  return store["db"].query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions").get()
    ?.count;
}

// the next getAccount call of the assistant answers 502
function failNextAccountRead(assistant: ReturnType<typeof createFakeAssistant>) {
  const getAccount = assistant.internalApi.getAccount;
  let failures = 1;
  assistant.internalApi.getAccount = async (accountId) => {
    if (failures > 0) {
      failures -= 1;

      return { error: "The assistant is unavailable", status: 502 };
    }

    return getAccount(accountId);
  };
}

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

test("a failed account read leaves no session on any route that starts one", async () => {
  const { send, register, token, assistant, store } = createTestApp();
  await register("alice", "signal:+100");
  // biome-ignore lint/complexity/useLiteralKeys: a private field, written for the check
  store["db"].run("DELETE FROM sessions");

  const attempts = [
    ["/api/register", { token: token("signal:+200"), username: "bob", password: PASSWORD }],
    ["/api/login", { username: "alice", password: PASSWORD }],
    ["/api/login", { username: "alice", password: PASSWORD, token: token("signal:+300") }],
    ["/api/link/login", { token: token("signal:+100") }],
  ] as const;

  for (const [path, body] of attempts) {
    failNextAccountRead(assistant);
    const response = await send("POST", path, body);
    expect(response.status).toBe(502);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(countSessions(store)).toBe(0);
  }
});

test("a token of a chat linked to another account is refused unused, and still logs into that account", async () => {
  const { send, register, token, assistant } = createTestApp();
  await register("alice", "signal:+100");
  const bob = await register("bob", "signal:+200");
  const link = token("signal:+100");

  const linked = await send("POST", "/api/link", { token: link }, bob.cookie, "bob");
  expect(linked.status).toBe(409);
  const loggedIn = await send("POST", "/api/login", {
    username: "bob",
    password: PASSWORD,
    token: link,
  });
  expect(loggedIn.status).toBe(409);
  expect(assistant.requests).toHaveLength(2);

  const linkLogin = await send("POST", "/api/link/login", { token: link });
  expect(linkLogin.status).toBe(200);
  expect((await linkLogin.json()).username).toBe("alice");
});

// the next call of the method waits for release(); entered resolves once it waits
function holdNextCall<T extends (...args: never[]) => Promise<unknown>>(call: T) {
  let release = () => {};
  let enter = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let held = false;
  const wrapped = (async (...args: Parameters<T>) => {
    if (!held) {
      held = true;
      enter();
      await released;
    }

    return call(...args);
  }) as T;

  return { wrapped, entered, release };
}

test("a login whose account read is held open while a login link sets a new password is refused and starts no session", async () => {
  const { send, register, token, assistant, store } = createTestApp();
  await register("alice", "signal:+100");
  // biome-ignore lint/complexity/useLiteralKeys: a private field, written for the check
  store["db"].run("DELETE FROM sessions");
  const hold = holdNextCall(assistant.internalApi.getAccount);
  assistant.internalApi.getAccount = hold.wrapped;

  const login = send("POST", "/api/login", { username: "alice", password: PASSWORD });
  await hold.entered;
  const reset = await send("POST", "/api/link/login", {
    token: token("signal:+100"),
    password: "a brand new password",
  });
  expect(reset.status).toBe(200);
  hold.release();

  const response = await login;
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Wrong username or password" });
  expect(response.headers.get("Set-Cookie")).toBeNull();
  expect(countSessions(store)).toBe(1);
});

test("a login with a token whose chat read is held open while a login link sets a new password is refused, leaving the token unused", async () => {
  const { send, register, token, assistant, store } = createTestApp();
  await register("alice", "signal:+100");
  // biome-ignore lint/complexity/useLiteralKeys: a private field, written for the check
  store["db"].run("DELETE FROM sessions");
  const link = token("signal:+300");
  const hold = holdNextCall(assistant.internalApi.getChatLink);
  assistant.internalApi.getChatLink = hold.wrapped;

  const login = send("POST", "/api/login", { username: "alice", password: PASSWORD, token: link });
  await hold.entered;
  const reset = await send("POST", "/api/link/login", {
    token: token("signal:+100"),
    password: "a brand new password",
  });
  expect(reset.status).toBe(200);
  hold.release();

  const response = await login;
  expect(response.status).toBe(401);
  expect(response.headers.get("Set-Cookie")).toBeNull();
  expect(countSessions(store)).toBe(1);
  expect(await (await send("POST", "/api/link/check", { token: link })).json()).toEqual({
    valid: true,
    chatKey: "signal:+300",
  });
  expect(assistant.requests.map((request) => request.chatKey)).toEqual(["signal:+100"]);
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
