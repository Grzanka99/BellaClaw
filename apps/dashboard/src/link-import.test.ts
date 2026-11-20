import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "./account-store";
import { importAccountChats } from "./link-import";
import { createFakeAssistant } from "./test-utils";

let directory: string;
let path: string;

// a dashboard database to import: accounts without a public id, and account_chats rows
// chats: [chatId, account row id, linkedAt]
function seedOldDatabase(chats: [string, number, number][]) {
  const db = new Database(path);
  db.run(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      passwordHash TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE account_chats (
      chatId TEXT PRIMARY KEY,
      accountId INTEGER NOT NULL,
      linkedAt INTEGER NOT NULL
    );
    INSERT INTO accounts (username, passwordHash, createdAt) VALUES ('alice', 'x', 1), ('bob', 'x', 2);
  `);

  for (const [chatId, accountId, linkedAt] of chats) {
    db.query("INSERT INTO account_chats (chatId, accountId, linkedAt) VALUES (?, ?, ?)").run(
      chatId,
      accountId,
      linkedAt,
    );
  }

  db.close();
}

function hasImportTable() {
  const db = new Database(path);
  const found =
    db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_chats'")
      .get() !== null;
  db.close();

  return found;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dashboard-import-"));
  path = join(directory, "dashboard.db");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("existing accounts get a public id when the store opens, kept across restarts", () => {
  seedOldDatabase([]);
  const first = new AccountStore(path);
  const alice = first.findCredentials("alice")?.publicId;
  const bob = first.findCredentials("bob")?.publicId;

  expect(alice).toBeString();
  expect(alice?.length).toBeGreaterThan(10);
  expect(alice).not.toBe(bob);

  const reopened = new AccountStore(path);
  expect(reopened.findCredentials("alice")?.publicId).toBe(alice);
  expect(reopened.findByPublicId(alice ?? "")?.username).toBe("alice");
});

test("a new account gets a public id of its own", () => {
  const store = new AccountStore(path);
  const link = { chatId: "signal:+1", nonce: "n", expiresAt: Date.now() + 60_000 };
  const registration = store.createAccount("carol", "x", link, Date.now());

  if (!("account" in registration)) {
    throw new Error("not registered");
  }

  expect(registration.account.publicId.length).toBeGreaterThan(10);
  expect(registration.account.publicId).not.toBe(String(registration.account.id));
  expect(new AccountStore(path).findCredentials("carol")?.publicId).toBe(
    registration.account.publicId,
  );
});

test("rows are imported oldest first, one at a time, each removed once its link is active", async () => {
  seedOldDatabase([
    ["signal:+300", 1, 3_000],
    ["signal:+100", 1, 1_000],
    ["discord:200", 2, 2_000],
  ]);
  const store = new AccountStore(path);
  const assistant = createFakeAssistant();
  const overlaps: string[] = [];
  const requestLink = assistant.internalApi.requestLink;
  const getChatLink = assistant.internalApi.getChatLink;
  assistant.internalApi.requestLink = async (accountId, chatKey) => {
    for (const [other, link] of assistant.links) {
      if (link.state !== "active") {
        overlaps.push(`${chatKey} while ${other}`);
      }
    }

    return requestLink(accountId, chatKey);
  };
  // a link is seen migrating once, and is active at the next look
  const seenMigrating = new Set<string>();
  assistant.internalApi.getChatLink = async (chatKey) => {
    if (seenMigrating.has(chatKey)) {
      assistant.activate(chatKey);
    }

    const result = await getChatLink(chatKey);

    if ("data" in result && result.data.link?.state === "migrating") {
      seenMigrating.add(chatKey);
    }

    return result;
  };

  await importAccountChats(store, assistant.internalApi, 1);

  expect(assistant.requests).toEqual([
    { accountId: store.findCredentials("alice")?.publicId ?? "", chatKey: "signal:+100" },
    { accountId: store.findCredentials("bob")?.publicId ?? "", chatKey: "discord:200" },
    { accountId: store.findCredentials("alice")?.publicId ?? "", chatKey: "signal:+300" },
  ]);
  expect(overlaps).toEqual([]);
  expect(hasImportTable()).toBe(false);
});

test("after a restart, a row whose link is active or migrating for its account finishes without a new request", async () => {
  seedOldDatabase([
    ["signal:+100", 1, 1_000],
    ["signal:+200", 1, 2_000],
  ]);
  const store = new AccountStore(path);
  const alice = store.findCredentials("alice")?.publicId ?? "";
  const assistant = createFakeAssistant();
  assistant.links.set("signal:+100", { accountId: alice, state: "active" });
  assistant.links.set("signal:+200", { accountId: alice, state: "migrating" });
  setTimeout(() => assistant.activate("signal:+200"), 20);

  await importAccountChats(store, assistant.internalApi, 5);

  expect(assistant.requests).toEqual([]);
  expect(hasImportTable()).toBe(false);
});

test("an unreachable assistant is retried", async () => {
  seedOldDatabase([["signal:+100", 1, 1_000]]);
  const store = new AccountStore(path);
  const assistant = createFakeAssistant();
  assistant.state.unreachableCalls = 3;
  const getChatLink = assistant.internalApi.getChatLink;
  assistant.internalApi.getChatLink = async (chatKey) => {
    const result = await getChatLink(chatKey);
    assistant.activate(chatKey);

    return result;
  };

  await importAccountChats(store, assistant.internalApi, 1);

  expect(assistant.state.unreachableCalls).toBe(0);
  expect(assistant.requests).toHaveLength(1);
  expect(hasImportTable()).toBe(false);
});

test("a row whose chat is linked to another account is left, and the next row goes on", async () => {
  seedOldDatabase([
    ["signal:+100", 1, 1_000],
    ["signal:+150", 1, 1_500],
    ["signal:+200", 2, 2_000],
  ]);
  const store = new AccountStore(path);
  const assistant = createFakeAssistant();
  assistant.links.set("signal:+100", { accountId: "someone-else", state: "active" });
  const getChatLink = assistant.internalApi.getChatLink;
  assistant.internalApi.getChatLink = async (chatKey) => {
    // signal:+150 is linked elsewhere between the read and the request
    if (chatKey === "signal:+150" && !assistant.links.has(chatKey)) {
      const result = await getChatLink(chatKey);
      assistant.links.set(chatKey, { accountId: "someone-else", state: "active" });

      return result;
    }

    const result = await getChatLink(chatKey);
    assistant.activate(chatKey);

    return result;
  };

  await importAccountChats(store, assistant.internalApi, 1);

  expect(assistant.requests.map((request) => request.chatKey)).toEqual([
    "signal:+150",
    "signal:+200",
  ]);
  expect(store.nextImportRow(new Set())?.chatId).toBe("signal:+100");
  expect(store.nextImportRow(new Set(["signal:+100"]))?.chatId).toBe("signal:+150");
  expect(store.nextImportRow(new Set(["signal:+100", "signal:+150"]))).toBeUndefined();
});

test("an account_chats table that is empty at the start is dropped", async () => {
  seedOldDatabase([]);
  const store = new AccountStore(path);
  const assistant = createFakeAssistant();

  await importAccountChats(store, assistant.internalApi, 1);

  expect(assistant.requests).toEqual([]);
  expect(hasImportTable()).toBe(false);
});

test("a row whose account does not exist stays, and so does the table", async () => {
  seedOldDatabase([
    ["signal:+100", 1, 1_000],
    ["signal:+900", 9, 900],
  ]);
  const store = new AccountStore(path);
  const assistant = createFakeAssistant();
  const getChatLink = assistant.internalApi.getChatLink;
  assistant.internalApi.getChatLink = async (chatKey) => {
    const result = await getChatLink(chatKey);
    assistant.activate(chatKey);

    return result;
  };

  await importAccountChats(store, assistant.internalApi, 1);

  expect(assistant.requests.map((request) => request.chatKey)).toEqual(["signal:+100"]);
  expect(hasImportTable()).toBe(true);
  const db = new Database(path);
  expect(db.query("SELECT chatId FROM account_chats").all()).toEqual([{ chatId: "signal:+900" }]);
  db.close();
});
