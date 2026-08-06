import { sql } from "drizzle-orm";
import { DatabaseConnector } from "./index";

export async function resetCronEngineJobsTable() {
  if (Bun.env.BELLACLAW_DATABASE_MODE !== "test" && Bun.env.NODE_ENV !== "test") {
    throw new Error("resetCronEngineJobsTable can only run in test database mode");
  }

  const db = DatabaseConnector.instance.database;

  await db.run(sql`DELETE FROM cron_engine_jobs`);
  await db.run(sql`DELETE FROM sqlite_sequence WHERE name = 'cron_engine_jobs'`);
}

export async function resetUserConfigsTable() {
  if (Bun.env.BELLACLAW_DATABASE_MODE !== "test" && Bun.env.NODE_ENV !== "test") {
    throw new Error("resetUserConfigsTable can only run in test database mode");
  }

  const db = DatabaseConnector.instance.database;

  await db.run(sql`DELETE FROM user_configs`);
}

export async function resetMessageAuthorizationsTable() {
  if (Bun.env.BELLACLAW_DATABASE_MODE !== "test" && Bun.env.NODE_ENV !== "test") {
    throw new Error("resetMessageAuthorizationsTable can only run in test database mode");
  }

  const db = DatabaseConnector.instance.database;

  await db.run(sql`DELETE FROM message_authorizations`);
}
