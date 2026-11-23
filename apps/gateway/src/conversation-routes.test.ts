import { expect, test } from "bun:test";
import { appMediaTable, memoriesTable } from "@bellaclaw/database";
import { COMMAND_CATALOG, type TListOperation } from "@bellaclaw/shared";
import { eq } from "drizzle-orm";
import { createAssistantDatabase, createTestApp, PASSWORD, registerApp } from "./test-utils";

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
          scheduled: false,
        },
        {
          id: reply.id,
          author: "assistant",
          kind: "message",
          channel: "app",
          text: "Hi",
          createdAt: 1_000,
          scheduled: false,
        },
      ],
    });

    // a command and its reply are display rows; a fetch by cursor returns only the missing rows
    const command = await database.insertRow(
      conversationKey,
      "user",
      "display",
      "!connector list",
      "m-2",
    );
    const answer = await database.insertRow(
      conversationKey,
      "assistant",
      "display",
      "You have no added connectors.",
    );
    const run = { runId: "run-1", name: "connector", state: "done", outcome: "no connectors" };
    await database.db
      .update(memoriesTable)
      .set({ command: JSON.stringify(run) })
      .where(eq(memoriesTable.id, command.id));
    await database.db
      .update(memoriesTable)
      .set({ command: JSON.stringify(run) })
      .where(eq(memoriesTable.id, answer.id));
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
    expect(appended.messages[0].command).toEqual(run);
    expect(appended.messages[1].command).toEqual(run);

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
        text: "Look",
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

test("the app reads its own lists that have not ended, items in order, and needs a session", async () => {
  const database = await createAssistantDatabase();

  try {
    const { sendApp, store } = createTestApp(":memory:", database.reader);
    const alice = await registerApp(sendApp, store, "alice");
    const bob = await registerApp(sendApp, store, "bob");
    const later = Date.now() + 60_000;
    await database.insertList("shopping", `account:${alice.publicId}`, "Shopping", undefined, [
      "milk",
      "eggs",
    ]);
    await database.insertList("trip", `account:${alice.publicId}`, "Trip", later, ["tickets"]);
    await database.insertList("ended", `account:${alice.publicId}`, "Ended", Date.now() - 1, []);
    await database.insertList("bobs", `account:${bob.publicId}`, "Bob's", undefined, ["x"]);

    const response = await sendApp("GET", "/api/lists", undefined, alice.token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      lists: [
        {
          id: "shopping",
          name: "Shopping",
          expiresAt: null,
          createdAt: 1_000,
          updatedAt: 1_000,
          items: [
            { id: "shopping-0", text: "milk", done: false, position: 0 },
            { id: "shopping-1", text: "eggs", done: false, position: 1 },
          ],
        },
        {
          id: "trip",
          name: "Trip",
          expiresAt: later,
          createdAt: 1_000,
          updatedAt: 1_000,
          items: [{ id: "trip-0", text: "tickets", done: false, position: 0 }],
        },
      ],
    });

    expect((await sendApp("GET", "/api/lists", undefined, "wrong-token")).status).toBe(401);
  } finally {
    await database.remove();
  }
});

test("the app's list changes go to the assistant for its account and answer its lists; a missing list is 404, an invalid change 400, and a change needs a session", async () => {
  const database = await createAssistantDatabase();

  try {
    const { sendApp, store, assistant } = createTestApp(":memory:", database.reader);
    const alice = await registerApp(sendApp, store, "alice");
    await database.insertList("shopping", `account:${alice.publicId}`, "Shopping", undefined, []);
    const change = async (body: unknown, token = alice.token) => {
      const response = await sendApp("POST", "/api/lists/changes", body, token);
      return [response.status, await response.json()];
    };
    const operations: TListOperation[] = [
      { op: "add_items", listId: "shopping", items: ["milk"] },
      { op: "create_list", name: "Trip", expiresAt: null },
    ];

    const [status, body] = await change({ operations });
    expect(status).toBe(200);
    expect(body).toEqual({
      lists: [
        {
          id: "shopping",
          name: "Shopping",
          expiresAt: null,
          createdAt: 1_000,
          updatedAt: 1_000,
          items: [],
        },
      ],
    });
    expect(assistant.listUpdates).toEqual([{ accountId: alice.publicId, update: { operations } }]);

    expect(await change({ operations: [{ op: "delete_list", listId: "missing" }] })).toEqual([
      404,
      { error: "List missing not found" },
    ]);

    for (const invalid of [
      { operations: [] },
      { operations: [{ op: "rename_list", listId: "shopping", name: " " }] },
      { operations: [{ op: "update_item", itemId: "item" }] },
      { operations: [{ op: "explode" }] },
      { ownerKey: "account:other", operations },
    ]) {
      expect((await change(invalid))[0]).toBe(400);
    }

    expect((await change({ operations }, "wrong-token"))[0]).toBe(401);
    expect(assistant.listUpdates).toHaveLength(1);
  } finally {
    await database.remove();
  }
});

test("the app reads the command catalog in palette order, and needs a session", async () => {
  const { sendApp, store } = createTestApp();
  const alice = await registerApp(sendApp, store, "alice");

  expect((await sendApp("GET", "/api/commands")).status).toBe(401);

  const response = await sendApp("GET", "/api/commands", undefined, alice.token);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ commands: Object.values(COMMAND_CATALOG) });
  expect(body.commands[0]).toEqual({
    name: "connector",
    group: "Connectors",
    description: COMMAND_CATALOG.connector.description,
    usage: "!connector list | !connector approve|reject CONNECTOR",
  });
});
