import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { ECronEngineJobType } from "../../lib/cron-engine";
import { ERole } from "../ai/types";
import { DatabaseConnector } from "../database";
import { cronEngineJobsTable, memoriesTable } from "../database/schema";
import { resetCronEngineJobsTable } from "../database/test-utils";
import { EMemoryImportance } from "../memory/types";
import { MessagingDataMigration } from "./migration";

async function resetMemoriesTable() {
  const db = DatabaseConnector.instance.database;

  await db.run(sql`DELETE FROM memories`);
  await db.run(sql`DELETE FROM sqlite_sequence WHERE name = 'memories'`);
}

describe("MessagingDataMigration", () => {
  beforeEach(async () => {
    await resetMemoriesTable();
    await resetCronEngineJobsTable();
  });

  test("idempotently prefixes raw Discord memory chat IDs and cron scopes", async () => {
    const db = DatabaseConnector.instance.database;
    const now = Date.now();

    await db.insert(memoriesTable).values([
      {
        chatId: "user-1",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "raw memory",
        createdAt: now,
        lastReadAt: now,
      },
      {
        chatId: "discord:user-2",
        author: ERole.User,
        importance: EMemoryImportance.Low,
        message: "canonical memory",
        createdAt: now,
        lastReadAt: now,
      },
    ]);

    await db.insert(cronEngineJobsTable).values([
      {
        name: "raw-job",
        scope: "user-1",
        type: ECronEngineJobType.Recurring,
        pattern: "*/5 * * * *",
        nextRunAt: now,
        createdAt: now,
      },
      {
        name: "canonical-job",
        scope: "discord:user-2",
        type: ECronEngineJobType.Recurring,
        pattern: "*/5 * * * *",
        nextRunAt: now,
        createdAt: now,
      },
    ]);

    const migration = new MessagingDataMigration();
    await migration.migrateRawDiscordScopes();
    await migration.migrateRawDiscordScopes();

    const memories = await db.select().from(memoriesTable).orderBy(memoriesTable.id);
    const jobs = await db.select().from(cronEngineJobsTable).orderBy(cronEngineJobsTable.id);

    expect(memories.map((memory) => memory.chatId)).toEqual(["discord:user-1", "discord:user-2"]);
    expect(jobs.map((job) => job.scope)).toEqual(["discord:user-1", "discord:user-2"]);
  });

  test("deletes raw cron scope when canonical row already exists", async () => {
    const db = DatabaseConnector.instance.database;
    const now = Date.now();

    await db.insert(cronEngineJobsTable).values([
      {
        name: "duplicate-job",
        scope: "user-1",
        type: ECronEngineJobType.Recurring,
        pattern: "*/5 * * * *",
        nextRunAt: now,
        createdAt: now,
      },
      {
        name: "duplicate-job",
        scope: "discord:user-1",
        type: ECronEngineJobType.Recurring,
        pattern: "*/5 * * * *",
        nextRunAt: now,
        createdAt: now,
      },
      {
        name: "raw-job",
        scope: "user-2",
        type: ECronEngineJobType.Recurring,
        pattern: "*/5 * * * *",
        nextRunAt: now,
        createdAt: now,
      },
    ]);

    const migration = new MessagingDataMigration();
    await migration.migrateRawDiscordScopes();
    await migration.migrateRawDiscordScopes();

    const jobs = await db.select().from(cronEngineJobsTable).orderBy(cronEngineJobsTable.id);

    expect(jobs.map((job) => ({ name: job.name, scope: job.scope }))).toEqual([
      { name: "duplicate-job", scope: "discord:user-1" },
      { name: "raw-job", scope: "discord:user-2" },
    ]);
  });
});
