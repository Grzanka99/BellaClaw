import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "@bellaclaw/shared";
import { asc, sql } from "drizzle-orm";
import { DatabaseConnector } from "../src/services/database";
import { factsTable } from "../src/services/database/schema";
import { FactEmbeddingRebuilder } from "./rebuild-embeddings";

const db = DatabaseConnector.instance.database;

function embedding(value: number): number[] {
  return Array.from({ length: 768 }, () => value);
}

async function readFacts() {
  return db.select().from(factsTable).orderBy(asc(factsTable.id));
}

beforeEach(async () => {
  await db.run(sql`DELETE FROM facts`);
  await db.insert(factsTable).values(
    Array.from({ length: 40 }, (_, index) => ({
      chatId: "chat-a",
      text: `fact ${index}`,
      embedding: embedding(0.25),
      createdAt: index,
      supersededBy: index === 0 ? 2 : null,
      forgottenAt: index === 1 ? 5 : null,
      sourceMessageId: index,
    })),
  );
});

afterEach(() => {
  mock.restore();
});

describe("FactEmbeddingRebuilder", () => {
  test("re-embeds every fact in batches and keeps other columns", async () => {
    const before = await readFacts();
    const embedMany = mock(async (inputs: string[]) => inputs.map(() => embedding(0.75)));

    await expect(new FactEmbeddingRebuilder(db, { embedMany }).rebuild()).resolves.toBe(40);

    expect(embedMany).toHaveBeenCalledTimes(2);
    expect(await readFacts()).toEqual(
      before.map((fact) => ({ ...fact, embedding: embedding(0.75) })),
    );
  });

  test("logs progress with speed and time left after each batch", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => undefined);
    const embedMany = mock(async (inputs: string[]) => inputs.map(() => embedding(0.75)));

    await new FactEmbeddingRebuilder(db, { embedMany }).rebuild();

    expect(info.mock.calls.map(([message]) => message)).toEqual([
      expect.stringMatching(
        /^\[EMBEDDING_REBUILD\] Embedded 32\/40 facts, [\d.]+ facts\/s, ~\d+s left$/,
      ),
      expect.stringMatching(
        /^\[EMBEDDING_REBUILD\] Embedded 40\/40 facts, [\d.]+ facts\/s, ~0s left$/,
      ),
    ]);
  });

  test("leaves every embedding unchanged when a batch fails", async () => {
    const before = await readFacts();
    let calls = 0;
    const embedMany = mock(async (inputs: string[]) => {
      calls += 1;
      if (calls === 2) {
        return undefined;
      }

      return inputs.map(() => embedding(0.75));
    });

    await expect(new FactEmbeddingRebuilder(db, { embedMany }).rebuild()).rejects.toThrow(
      "Failed to embed facts 33-40",
    );
    expect(await readFacts()).toEqual(before);
  });
});
