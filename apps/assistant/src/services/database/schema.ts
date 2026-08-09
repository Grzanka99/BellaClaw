import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const EMBEDDING_DIMENSIONS = 768;

export const f32Blob = customType<{
  data: number[];
  driverData: ArrayBuffer | Uint8Array;
}>({
  dataType() {
    return `F32_BLOB(${EMBEDDING_DIMENSIONS})`;
  },
  toDriver(value) {
    if (value.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Fact embeddings must have ${EMBEDDING_DIMENSIONS} dimensions`);
    }

    return new Float32Array(value).buffer;
  },
  fromDriver(value) {
    // NOTE: selects hand back an ArrayBuffer, but insert .returning() hands back a Uint8Array
    let embedding: number[];
    if (value instanceof Uint8Array) {
      embedding = Array.from(
        new Float32Array(
          value.buffer,
          value.byteOffset,
          value.byteLength / Float32Array.BYTES_PER_ELEMENT,
        ),
      );
    } else {
      embedding = Array.from(new Float32Array(value));
    }

    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Stored fact embeddings must have ${EMBEDDING_DIMENSIONS} dimensions`);
    }

    return embedding;
  },
});

export const memoriesTable = sqliteTable(
  "memories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: text("chatId").notNull(),
    author: text("author").notNull(),
    importance: text("importance").notNull(),
    message: text("message").notNull(),
    createdAt: integer("createdAt").notNull(),
    lastReadAt: integer("lastReadAt").notNull(),
  },
  (table) => [index("memories_chat_id_idx").on(table.chatId, table.id)],
);

export const factsTable = sqliteTable(
  "facts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: text("chatId").notNull(),
    text: text("text").notNull(),
    embedding: f32Blob("embedding").notNull(),
    createdAt: integer("createdAt").notNull(),
    supersededBy: integer("supersededBy"),
    sourceMessageId: integer("sourceMessageId").notNull(),
  },
  (table) => [
    index("facts_chat_live_idx").on(table.chatId, table.supersededBy),
    index("facts_source_message_idx").on(table.sourceMessageId),
  ],
);

export const factDistillationStateTable = sqliteTable("fact_distillation_state", {
  chatId: text("chatId").primaryKey(),
  lastProcessedMessageId: integer("lastProcessedMessageId").notNull(),
  updatedAt: integer("updatedAt").notNull(),
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

export const calendarsTable = sqliteTable(
  "calendars",
  {
    userId: text("userId").notNull().default(""),
    calendarId: text("calendarId").notNull(),
    access: text("access").notNull(),
    addedAt: integer("addedAt").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.calendarId] }),
    check("calendars_access_check", sql`${table.access} in ('read', 'write')`),
    uniqueIndex("calendars_single_write_unique")
      .on(table.userId)
      .where(sql`${table.access} = 'write'`),
  ],
);

export const messageAuthorizationsTable = sqliteTable(
  "message_authorizations",
  {
    chatId: text("chatId").primaryKey(),
    status: text("status").notNull(),
    failedAttempts: integer("failedAttempts").notNull().default(0),
  },
  (table) => [
    check(
      "message_authorizations_status_check",
      sql`${table.status} in ('pending', 'authorized', 'locked')`,
    ),
    check(
      "message_authorizations_failed_attempts_check",
      sql`${table.failedAttempts} between 0 and 3`,
    ),
  ],
);

export type TInsertMemory = typeof memoriesTable.$inferInsert;
export type TSelectMemory = typeof memoriesTable.$inferSelect;

export type TInsertCronJob = typeof cronEngineJobsTable.$inferInsert;
export type TSelectCronJob = typeof cronEngineJobsTable.$inferSelect;

export type TInsertUserConfig = typeof userConfigsTable.$inferInsert;
export type TSelectUserConfig = typeof userConfigsTable.$inferSelect;

export type TInsertCalendar = typeof calendarsTable.$inferInsert;
export type TSelectCalendar = typeof calendarsTable.$inferSelect;
