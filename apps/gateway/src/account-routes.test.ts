import { expect, setSystemTime, test } from "bun:test";
import { ACCOUNT_HEADER } from "./account-header";
import { createTestApp, deviceKeys, FAKE_MODEL_CATALOG, PASSWORD, registerApp } from "./test-utils";

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

test("the account routes reach only the signed-in account's keys, and need a session", async () => {
  const { send, register, reads, assistant } = createTestApp();
  const alice = await register("alice", "signal:+100");
  const bob = await register("bob", "signal:+200");
  const routes = [
    ["GET", "/api/messages"],
    ["GET", "/api/facts"],
    ["GET", "/api/model"],
    ["PUT", "/api/model"],
    ["GET", "/api/models"],
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
    "getModels",
    "getPersonality",
    "updatePersonality",
    "deleteMessage",
  ]);

  // the assistant's catalog, as it answered it
  const models = await send("GET", "/api/models", undefined, alice.cookie);
  expect(await models.json()).toEqual(FAKE_MODEL_CATALOG);

  reads.length = 0;
  await send("GET", "/api/messages", undefined, bob.cookie);
  expect(reads).toEqual([`bella:${bob.publicId}`]);
  expect(await (await send("GET", "/api/me", undefined, bob.cookie)).json()).toEqual({
    username: "bob",
    chats: [{ chatKey: "signal:+200", state: "active", linkedAt: 1_000 }],
  });
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
    ["GET", "/api/models"],
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

  const models = await sendApp("GET", "/api/models", undefined, aliceToken);
  expect(await models.json()).toEqual(FAKE_MODEL_CATALOG);

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
