import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS_FOLDER, memoriesTable } from "@bellaclaw/database";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { ERole } from "../ai/types";
import { DatabaseConnector } from "../database";
import { EMessagePlatform } from "../messaging/types";
import { ConversationStore } from ".";
import { attachmentBlock } from "./types";

const CHANNEL_MIGRATION = "0016_transcript_channel";

describe("transcript channel backfill", () => {
  let directory: string;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bellaclaw-channel-"));
    db = drizzle({ connection: { url: `file:${join(directory, "test.db")}` } });
  });

  afterEach(async () => {
    db.$client.close();
    await rm(directory, { recursive: true, force: true });
  });

  // migrates to the schema before the channel column, leaving out every later migration too
  async function migrateBeforeChannel() {
    const folder = join(directory, "migrations");
    await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry) => entry.tag === CHANNEL_MIGRATION),
    );
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: folder });
  }

  test("old rows get the channel of their key and their attachment references name it", async () => {
    await migrateBeforeChannel();
    const image = {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "text", text: "[Image]", attachment: { id: "file-1", mimeType: "image/png" } },
      ],
      timestamp: 1,
    };
    await db.run(sql`
      INSERT INTO memories (id, chatId, author, message, modelMessage, kind, createdAt) VALUES
        (1, 'signal:+100', 'user', 'look [Image]', ${JSON.stringify(image)}, 'message', 1),
        (2, 'signal:+100', 'assistant', 'A cat.', NULL, 'message', 2),
        (3, 'discord:user-1', 'user', 'hi', NULL, 'message', 3),
        (9, 'discord:user-1', 'assistant', 'deleted later', NULL, 'message', 4)
    `);
    await db.run(sql`DELETE FROM memories WHERE id = 9`);

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const rows = await db
      .select({ id: memoriesTable.id, channel: memoriesTable.channel })
      .from(memoriesTable)
      .orderBy(memoriesTable.id);
    expect(rows).toEqual([
      { id: 1, channel: "signal" },
      { id: 2, channel: "signal" },
      { id: 3, channel: "discord" },
    ]);
    const stored = await db
      .select({ modelMessage: memoriesTable.modelMessage })
      .from(memoriesTable)
      .where(eq(memoriesTable.id, 1))
      .get();
    expect(JSON.parse(stored?.modelMessage ?? "null")).toEqual({
      ...image,
      content: [
        { type: "text", text: "look" },
        {
          type: "text",
          text: "[Image]",
          attachment: {
            id: "file-1",
            mimeType: "image/png",
            channel: EMessagePlatform.Signal,
            sourceAddress: "+100",
          },
        },
      ],
    });

    // a deleted id is not handed out again
    await db.run(sql`
      INSERT INTO memories (chatId, channel, author, message, kind, createdAt)
      VALUES ('signal:+100', 'signal', 'user', 'next', 'message', 5)
    `);
    const next = await db
      .select({ id: memoriesTable.id })
      .from(memoriesTable)
      .where(eq(memoriesTable.message, "next"))
      .get();
    expect(next?.id).toBe(10);
  });
});

test("every transcript write stores its channel", async () => {
  const chatId = "discord:channel-writes";
  const store = new ConversationStore();
  const database = DatabaseConnector.instance.database;
  const source = await store.saveUserMessage(
    database,
    chatId,
    EMessagePlatform.Discord,
    ERole.User,
    "[Image]",
    new Date(),
    undefined,
  );
  const ref = {
    id: "message-1:attachment-1",
    mimeType: "image/png",
    channel: EMessagePlatform.Discord,
    sourceAddress: "channel-writes",
  };
  await store.saveTurn(
    database,
    chatId,
    EMessagePlatform.Discord,
    [
      { role: "user", content: [attachmentBlock(ref)], timestamp: 1 },
      fauxAssistantMessage("A cat."),
    ],
    source.id,
    undefined,
  );
  await store.saveDeliveredMessage(
    database,
    chatId,
    EMessagePlatform.Discord,
    "Reminder",
    "notice",
    Date.now(),
  );

  const rows = await database
    .select({ channel: memoriesTable.channel })
    .from(memoriesTable)
    .where(eq(memoriesTable.chatId, chatId));
  expect(rows.map((row) => row.channel)).toEqual(Array(4).fill(EMessagePlatform.Discord));
});
