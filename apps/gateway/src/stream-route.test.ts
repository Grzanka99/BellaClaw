import { expect, test } from "bun:test";
import type { createLiveStream } from "./live-stream";
import {
  createAssistantDatabase,
  createTestApp,
  PASSWORD,
  registerApp,
  waitUntil,
} from "./test-utils";

// a phone's event stream: next reads the next events; state.ended: the stream ended
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
  let taken = 0;

  return {
    state,
    // reads until count events arrived after those taken before, or the stream ended; returns them
    async next(count: number) {
      while (events.length - taken < count && !state.ended) {
        const chunk = await reader.read();

        if (chunk.done) {
          state.ended = true;
        } else {
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
      }

      const read = events.slice(taken, taken + count);
      taken += read.length;

      return read;
    },
    close: () => reader.cancel(),
  };
}

// a new app session of username; its bearer token
async function loginApp(sendApp: ReturnType<typeof createTestApp>["sendApp"], username: string) {
  const response = await sendApp("POST", "/api/login", { username, password: PASSWORD });
  expect(response.status).toBe(200);

  return String((await response.json()).token);
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

test("a deleted plain chat reaches the phone's stream", async () => {
  const { sendApp, assistant, store, startFollowing } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");
  const stopFollowing = await startFollowing();

  try {
    const stream = await openAppStream(sendApp, alice.token);
    expect(await stream.next(1)).toEqual([{ type: "check" }]);

    const conversationKey = `plain:${alice.publicId}:chat-1`;
    assistant.push({ type: "deleted", accountId: alice.publicId, conversationKey });
    expect(await stream.next(1)).toEqual([{ type: "deleted", conversationKey }]);

    await stream.close();
  } finally {
    await stopFollowing();
  }
});

test("a confidential reply reaches the account's app streams only", async () => {
  const { send, sendApp, register, assistant, store, startFollowing } = createTestApp();
  const alice = await register("alice", "signal:+100");
  const loggedIn = await sendApp("POST", "/api/login", { username: "alice", password: PASSWORD });
  const aliceToken = String((await loggedIn.json()).token);
  const bob = await registerApp(sendApp, store, "bob");
  const stopFollowing = await startFollowing();

  try {
    const aliceApp = await openAppStream(sendApp, aliceToken);
    const bobApp = await openAppStream(sendApp, bob.token);
    const browser = await send("GET", "/api/stream", undefined, alice.cookie);
    const browserReader = browser.body?.getReader();
    expect(await aliceApp.next(1)).toEqual([{ type: "check" }]);
    expect(await bobApp.next(1)).toEqual([{ type: "check" }]);

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
    // bob's stream reads up to this event, after the reply
    const bobKey = `bella:${bob.publicId}`;
    assistant.push({
      type: "typing",
      accountId: bob.publicId,
      conversationKey: bobKey,
      typing: true,
    });

    expect(await aliceApp.next(1)).toEqual([
      { type: "reply", conversationKey, text: "https://example.test/login" },
    ]);
    expect(await bobApp.next(1)).toEqual([
      { type: "typing", conversationKey: bobKey, typing: true },
    ]);

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
  } finally {
    await stopFollowing();
  }
});

test("the phone sees typing start and stop, then a nudge, then the reply in history; another account's stream carries none of it", async () => {
  const database = await createAssistantDatabase();
  let stopFollowing = async () => {};

  try {
    const { sendApp, assistant, store, liveStream, startFollowing } = createTestApp(
      ":memory:",
      database.reader,
    );
    const subscriptions = countSubscriptions(liveStream);
    const alice = await registerApp(sendApp, store, "alice");
    const bob = await registerApp(sendApp, store, "bob");
    const conversationKey = `bella:${alice.publicId}`;
    const path = `/api/conversations/${encodeURIComponent(conversationKey)}/messages`;
    stopFollowing = await startFollowing();

    const aliceStream = await openAppStream(sendApp, alice.token);
    const bobStream = await openAppStream(sendApp, bob.token);
    // each opens with a check: compare revisions for what changed before it connected
    expect(await aliceStream.next(1)).toEqual([{ type: "check" }]);
    expect(await bobStream.next(1)).toEqual([{ type: "check" }]);
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
    // bob's stream reads up to this event, after alice's
    const bobKey = `bella:${bob.publicId}`;
    assistant.push({
      type: "typing",
      accountId: bob.publicId,
      conversationKey: bobKey,
      typing: true,
    });

    expect(await aliceStream.next(4)).toEqual([
      { type: "typing", conversationKey, typing: true },
      { type: "changed", conversationKey, revision: 1, rewriteRevision: 0 },
      { type: "typing", conversationKey, typing: false },
      { type: "changed", conversationKey, revision: 2, rewriteRevision: 0 },
    ]);
    expect(await bobStream.next(1)).toEqual([
      { type: "typing", conversationKey: bobKey, typing: true },
    ]);

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
  } finally {
    await stopFollowing();
    await database.remove();
  }
});

test("a phone that reconnects is told to check, sees the revision differ, and fetches the rows it missed; a delete is noticed by its rewrite revision", async () => {
  const database = await createAssistantDatabase();
  let stopFollowing = async () => {};

  try {
    const { sendApp, assistant, store, liveStream, startFollowing } = createTestApp(
      ":memory:",
      database.reader,
    );
    const alice = await registerApp(sendApp, store, "alice");
    const accountId = alice.publicId;
    const ownerKey = `account:${accountId}`;
    const conversationKey = `bella:${accountId}`;
    const path = `/api/conversations/${encodeURIComponent(conversationKey)}/messages`;
    stopFollowing = await startFollowing();
    const first = await database.insertRow(conversationKey, "user", "message", "Hello");
    await database.setRevision(conversationKey, ownerKey, 1, 0);

    const before = await openAppStream(sendApp, alice.token);
    expect(await before.next(1)).toEqual([{ type: "check" }]);
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
    expect(await after.next(1)).toEqual([{ type: "check" }]);
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
    expect(await after.next(1)).toEqual([
      { type: "changed", conversationKey, revision: 4, rewriteRevision: 4 },
    ]);
    // synced at 3, below 4: a reload
    const reloaded = await (await sendApp("GET", path, undefined, alice.token)).json();
    expect(reloaded.messages.map((row: { id: number }) => row.id)).not.toContain(reply.id);
    expect(reloaded.messages[0].id).toBe(first.id);

    await after.close();
  } finally {
    await stopFollowing();
    await database.remove();
  }
});

test("when the edge loses the assistant's stream, connected phones are told to check, and the edge connects again", async () => {
  const { sendApp, assistant, store, startFollowing } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");
  const accountId = alice.publicId;
  const conversationKey = `bella:${accountId}`;
  const stopFollowing = await startFollowing();
  const stream = await openAppStream(sendApp, alice.token);
  expect(await stream.next(1)).toEqual([{ type: "check" }]);

  assistant.drop();
  await waitUntil(() => assistant.streams.length === 2);
  // one check when the stream drops, one when it opens again
  expect(await stream.next(2)).toEqual([{ type: "check" }, { type: "check" }]);

  assistant.push({ type: "typing", accountId, conversationKey, typing: true });
  expect(await stream.next(1)).toEqual([{ type: "typing", conversationKey, typing: true }]);

  await stream.close();
  await stopFollowing();
  expect(assistant.streams).toHaveLength(2);
});

test("when the assistant's stream stays open but silent, the edge drops it, tells phones to check and connects again", async () => {
  const { sendApp, assistant, store, startFollowing } = createTestApp(":memory:", undefined, 100);
  const alice = await registerApp(sendApp, store, "alice");
  const stream = await openAppStream(sendApp, alice.token);
  const stopFollowing = await startFollowing();

  await waitUntil(() => assistant.streams.length === 2);
  const conversationKey = `bella:${alice.publicId}`;
  // a sentinel on the second connection: later connections cannot supply a missing check
  assistant.streams[1]?.enqueue(
    new TextEncoder().encode(
      `${JSON.stringify({ type: "typing", accountId: alice.publicId, conversationKey, typing: true })}\n`,
    ),
  );
  // the phone's own check, then: opened, dropped as silent, opened again
  expect(await stream.next(5)).toEqual([
    { type: "check" },
    { type: "check" },
    { type: "check" },
    { type: "check" },
    { type: "typing", conversationKey, typing: true },
  ]);

  await stream.close();
  await stopFollowing();
});

test("the stream needs a session", async () => {
  const { sendApp } = createTestApp();
  const response = await sendApp("GET", "/api/stream", undefined, "not-a-session");

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});

test("a stream ends with its session: logout and a new password set through a login link stop its events", async () => {
  const { sendApp, register, token, assistant, liveStream, startFollowing } = createTestApp();
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
  const stopFollowing = await startFollowing();
  const firstStream = await openAppStream(sendApp, first);
  const secondStream = await openAppStream(sendApp, second);
  expect(await firstStream.next(1)).toEqual([{ type: "check" }]);
  expect(await secondStream.next(1)).toEqual([{ type: "check" }]);

  expect((await sendApp("POST", "/api/logout", undefined, second)).status).toBe(200);
  assistant.push({ type: "typing", accountId, conversationKey, typing: true });
  expect(await secondStream.next(1)).toEqual([]);
  expect(secondStream.state.ended).toBe(true);
  expect(await firstStream.next(1)).toEqual([{ type: "typing", conversationKey, typing: true }]);
  expect(subscriptions.open).toBe(1);

  const reset = await sendApp("POST", "/api/link/login", {
    token: token("signal:+100"),
    password: "a brand new password",
  });
  expect(reset.status).toBe(200);
  assistant.push({ type: "typing", accountId, conversationKey, typing: false });
  expect(await firstStream.next(1)).toEqual([]);
  expect(firstStream.state.ended).toBe(true);
  expect(subscriptions.open).toBe(0);

  await stopFollowing();
});

test("an account's fifth stream ends its oldest; another account's streams stay", async () => {
  const { sendApp, assistant, store, liveStream, startFollowing } = createTestApp();
  const subscriptions = countSubscriptions(liveStream);
  const alice = await registerApp(sendApp, store, "alice");
  const bob = await registerApp(sendApp, store, "bob");
  const bobStream = await openAppStream(sendApp, bob.token);
  const streams = [];

  // each in its own session: a session holds one stream
  for (let opened = 0; opened < 5; opened += 1) {
    streams.push(await openAppStream(sendApp, await loginApp(sendApp, "alice")));
  }

  // each opened with a check; the oldest then ended
  for (const stream of [bobStream, ...streams]) {
    await stream.next(1);
  }

  await streams[0]?.next(1);

  expect(streams.map((stream) => stream.state.ended)).toEqual([true, false, false, false, false]);
  expect(bobStream.state.ended).toBe(false);
  expect(subscriptions.open).toBe(5);

  // a marker of each account reaches the streams still open, after the edge's check on connecting
  const stopFollowing = await startFollowing();

  try {
    const aliceKey = `bella:${alice.publicId}`;
    const bobKey = `bella:${bob.publicId}`;
    assistant.push({
      type: "typing",
      accountId: alice.publicId,
      conversationKey: aliceKey,
      typing: true,
    });
    assistant.push({
      type: "typing",
      accountId: bob.publicId,
      conversationKey: bobKey,
      typing: true,
    });

    expect(await bobStream.next(2)).toEqual([
      { type: "check" },
      { type: "typing", conversationKey: bobKey, typing: true },
    ]);

    for (const stream of streams.slice(1)) {
      expect(await stream.next(2)).toEqual([
        { type: "check" },
        { type: "typing", conversationKey: aliceKey, typing: true },
      ]);
    }

    expect(await streams[0]?.next(1)).toEqual([]);
    expect(streams[0]?.state.ended).toBe(true);
  } finally {
    for (const stream of [bobStream, ...streams.slice(1)]) {
      await stream.close();
    }

    await stopFollowing();
  }

  expect(subscriptions.open).toBe(0);
});

test("a second stream of an app session ends the first; once it closes the account has no app stream", async () => {
  const { sendApp, assistant, store, startFollowing } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");
  const stopFollowing = await startFollowing();
  await waitUntil(() => assistant.presence.length === 1);

  // the phone left Wi-Fi: its old connection died without a close, and it reconnects
  const dead = await openAppStream(sendApp, alice.token);
  await waitUntil(() => assistant.presence.length === 2);
  const reconnected = await openAppStream(sendApp, alice.token);
  expect(await dead.next(2)).toEqual([{ type: "check" }]);
  expect(dead.state.ended).toBe(true);
  expect(await reconnected.next(1)).toEqual([{ type: "check" }]);

  await reconnected.close();
  await waitUntil(() => assistant.presence.length === 3);
  expect(assistant.presence).toEqual([[], [alice.publicId], []]);

  await stopFollowing();
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

test("the edge reports every account with an open stream on each connection and when an account's first stream opens or last closes", async () => {
  const { sendApp, assistant, store, startFollowing } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");
  const bob = await registerApp(sendApp, store, "bob");
  // no connection yet: nothing is reported
  const early = await openAppStream(sendApp, alice.token);
  expect(assistant.presence).toEqual([]);

  const stopFollowing = await startFollowing();
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

  await stopFollowing();
});

test("a browser's stream receives events but does not count toward presence", async () => {
  const { send, register, assistant, startFollowing } = createTestApp();
  const web = await register("bob", "signal:+100");
  const stopFollowing = await startFollowing();
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
  await stopFollowing();
});

test("a failed presence report is sent again until one succeeds", async () => {
  const { sendApp, assistant, store, startFollowing } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");
  const stopFollowing = await startFollowing();
  await waitUntil(() => assistant.presence.length === 1);

  assistant.state.failingPresenceReports = 1;
  const stream = await openAppStream(sendApp, alice.token);
  await waitUntil(() => assistant.presence.length === 2);
  expect(assistant.presence[1]).toEqual([alice.publicId]);
  expect(assistant.state.failingPresenceReports).toBe(0);

  await stream.close();
  await stopFollowing();
});
