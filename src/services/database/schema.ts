import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const memoriesTable = sqliteTable("memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: text("chatId").notNull(),
  author: text("author").notNull(),
  importance: text("importance").notNull(),
  message: text("message").notNull(),
  createdAt: integer("createdAt").notNull(),
  lastReadAt: integer("lastReadAt").notNull(),
});

export const cronEngineJobsTable = sqliteTable(
  "cron_engine_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    scope: text("scope").notNull(),
    group: text("group"),
    type: text("type").notNull(),
    pattern: text("pattern"),
    reminderText: text("reminderText"),
    reminderPromptData: text("reminderPromptData"),
    reminderFallbackText: text("reminderFallbackText"),
    taskPrompt: text("taskPrompt"),
    taskFallbackText: text("taskFallbackText"),
    nextRunAt: integer("nextRunAt").notNull(),
    lastRunAt: integer("lastRunAt"),
    createdAt: integer("createdAt").notNull(),
    status: text("status").notNull().default("active"),
    finishedAt: integer("finishedAt"),
    finishedReason: text("finishedReason"),
    timezone: text("timezone"),
  },
  (table) => [
    uniqueIndex("cron_engine_jobs_name_scope_unique")
      .on(table.name, table.scope)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const userConfigsTable = sqliteTable(
  "user_configs",
  {
    ownerKey: text("ownerKey").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerKey, table.key] })],
);

export type TInsertMemory = typeof memoriesTable.$inferInsert;
export type TSelectMemory = typeof memoriesTable.$inferSelect;

export type TInsertCronJob = typeof cronEngineJobsTable.$inferInsert;
export type TSelectCronJob = typeof cronEngineJobsTable.$inferSelect;

export type TInsertUserConfig = typeof userConfigsTable.$inferInsert;
export type TSelectUserConfig = typeof userConfigsTable.$inferSelect;
