import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncQueue } from "@bellaclaw/shared";
import { type Client, createClient } from "@libsql/client";
import { asc, sql } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { factsTable } from "../src/services/database/schema";
import { FactEmbeddingRebuilder } from "./rebuild-embeddings";

const queue = new AsyncQueue();
let client: Client;
let db: LibSQLDatabase;
let directory: string;

function embedding(value: number): number[] {
  return Array.from({ length: 768 }, () => value);
}

async function readFacts() {
  return queue.enqueue(async () => db.select().from(factsTable).orderBy(asc(factsTable.id)));
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-embedding-rebuild-"));
  client = createClient({ url: `file:${join(directory, "facts.db")}` });
  db = drizzle(client);
  await queue.enqueue(async () => {
    await db.run(sql`CREATE TABLE facts (
      id INTEGER PRIMARY KEY,
      chatId TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding F32_BLOB(768) NOT NULL,
      createdAt INTEGER NOT NULL,
      supersededBy INTEGER,
      forgottenAt INTEGER,
      sourceMessageId INTEGER NOT NULL
    )`);
    await db.insert(factsTable).values([
      {
        id: 1,
        chatId: "chat-a",
        text: "The user owns a red bicycle.",
        embedding: embedding(0.25),
        createdAt: 1,
        supersededBy: 2,
        sourceMessageId: 10,
      },
      {
        id: 2,
        chatId: "chat-a",
        text: "The user owns a blue bicycle.",
        embedding: embedding(0.25),
        createdAt: 2,
        sourceMessageId: 11,
      },
      {
        id: 3,
        chatId: "chat-b",
        text: "The user prefers short answers.",
        embedding: embedding(0.25),
        createdAt: 3,
        forgottenAt: 4,
        sourceMessageId: 12,
      },
    ]);
  });
});

afterEach(async () => {
  client.close();
  await rm(directory, { recursive: true, force: true });
});

describe("fact embedding rebuild", () => {
  test("replaces every embedding while preserving fact text, IDs, and lifecycle metadata", async () => {
    const before = await readFacts();
    const embed = mock(async () => embedding(0.75));

    expect(await new FactEmbeddingRebuilder(db, { embed }).rebuild()).toBe(3);
    expect(await readFacts()).toEqual(
      before.map((fact) => ({ ...fact, embedding: embedding(0.75) })),
    );
    for (const fact of before) {
      expect(embed).toHaveBeenCalledWith(fact.text);
    }
  });

  test("leaves every embedding unchanged when generation fails partway through", async () => {
    const before = await readFacts();
    const embed = mock(async (text: string) => {
      if (text.includes("blue")) {
        return undefined;
      }
      return embedding(0.75);
    });

    await expect(new FactEmbeddingRebuilder(db, { embed }).rebuild()).rejects.toThrow(
      "Failed to embed fact 2",
    );
    expect(await readFacts()).toEqual(before);
  });

  test("rolls back earlier updates if a database write fails", async () => {
    const before = await readFacts();
    await queue.enqueue(async () => {
      await db.run(sql`CREATE TRIGGER fail_rebuild BEFORE UPDATE OF embedding ON facts
        WHEN OLD.id = 2 BEGIN SELECT RAISE(ABORT, 'rebuild rejected'); END`);
    });

    await expect(
      new FactEmbeddingRebuilder(db, { embed: async () => embedding(0.75) }).rebuild(),
    ).rejects.toThrow();
    expect(await readFacts()).toEqual(before);
  });
});
