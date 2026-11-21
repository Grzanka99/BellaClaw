import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, deviceKeys, PASSWORD, registerApp } from "./test-utils";

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

test("a row of account_chats the import still holds counts as its account's link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-app-"));
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
