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
import type {
  EAutomationStatus,
  ECronFinishedReason,
  ECronJobStatus,
  ECronJobType,
  EEventType,
} from "./enums";

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
    author: text("author", { enum: ["system", "user", "assistant", "toolResult"] }).notNull(),
    message: text("message").notNull(),
    modelMessage: text("modelMessage"),
    kind: text("kind", { enum: ["message", "tool"] })
      .notNull()
      .default("message"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("memories_chat_id_idx").on(table.chatId, table.id)],
);

export const conversationSummariesTable = sqliteTable("conversation_summaries", {
  chatId: text("chatId").primaryKey(),
  summary: text("summary").notNull(),
  summarizedThroughId: integer("summarizedThroughId").notNull(),
  // the summarizedThroughId of the last compactions, oldest first
  compactionBoundaries: text("compactionBoundaries", { mode: "json" })
    .$type<number[]>()
    .notNull()
    .default(sql`'[]'`),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
});

export const factsTable = sqliteTable(
  "facts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: text("chatId").notNull(),
    text: text("text").notNull(),
    embedding: f32Blob("embedding").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    supersededBy: integer("supersededBy"),
    forgottenAt: integer("forgottenAt", { mode: "timestamp_ms" }),
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
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const cronEngineJobsTable = sqliteTable(
  "cron_engine_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    scope: text("scope").notNull(),
    type: text("type").$type<ECronJobType>().notNull(),
    pattern: text("pattern"),
    contentKind: text("contentKind", {
      enum: ["text", "generated", "task", "automations"],
    }).notNull(),
    contentBody: text("contentBody").notNull(),
    contentFallback: text("contentFallback"),
    nextRunAt: integer("nextRunAt", { mode: "timestamp_ms" }).notNull(),
    lastRunAt: integer("lastRunAt", { mode: "timestamp_ms" }),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    status: text("status").$type<ECronJobStatus>().notNull().default(sql`'active'`),
    finishedAt: integer("finishedAt", { mode: "timestamp_ms" }),
    finishedReason: text("finishedReason").$type<ECronFinishedReason>(),
    timezone: text("timezone"),
    automationIds: text("automationIds", { mode: "json" }).$type<number[]>(),
  },
  (table) => [
    uniqueIndex("cron_engine_jobs_name_scope_unique")
      .on(table.name, table.scope)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const automationsTable = sqliteTable(
  "automations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scope: text("scope").notNull(),
    name: text("name").notNull(),
    instructions: text("instructions"),
    source: text("source").notNull(),
    config: text("config", { mode: "json" }).$type<unknown>().notNull(),
    allowedOrigins: text("allowedOrigins", { mode: "json" }).$type<string[]>().notNull(),
    outputCapBytes: integer("outputCapBytes").notNull().default(16384),
    state: text("state", { mode: "json" }).$type<unknown>(),
    status: text("status").$type<EAutomationStatus>().notNull().default(sql`'active'`),
    failureCount: integer("failureCount").notNull().default(0),
    lastError: text("lastError"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("automations_scope_name_unique").on(table.scope, table.name)],
);

export const automationDraftsTable = sqliteTable("automation_drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scope: text("scope").notNull(),
  name: text("name").notNull(),
  instructions: text("instructions"),
  source: text("source").notNull(),
  config: text("config", { mode: "json" }).$type<unknown>().notNull(),
  allowedOrigins: text("allowedOrigins", { mode: "json" }).$type<string[]>().notNull(),
  outputCapBytes: integer("outputCapBytes").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
});

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

export const eventsTable = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    type: text("type").$type<EEventType>().notNull(),
    kind: text("kind", { enum: ["event", "command"] }).notNull(),
    source: text("source").notNull(),
    key: text("key").notNull(),
    turnId: text("turnId").notNull(),
    chatId: text("chatId"),
    platform: text("platform"),
    causationId: text("causationId"),
    dedupeKey: text("dedupeKey"),
    // NULL after scrubbing
    payload: text("payload", { mode: "json" }).$type<unknown>(),
    occurredAt: integer("occurredAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("events_id_unique").on(table.id),
    // SQLite treats NULLs as distinct, so events without a key never collide
    uniqueIndex("events_dedupe_key_unique").on(table.dedupeKey),
    index("events_causation_idx").on(table.causationId),
    index("events_turn_idx").on(table.turnId, table.seq),
  ],
);

export const eventDeliveriesTable = sqliteTable(
  "event_deliveries",
  {
    eventSeq: integer("eventSeq").notNull(),
    consumer: text("consumer").notNull(),
    status: text("status", { enum: ["pending", "done", "dead"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("lastError"),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventSeq, table.consumer] }),
    index("event_deliveries_pending_idx").on(table.status, table.eventSeq),
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

export type TSelectEvent = typeof eventsTable.$inferSelect;
export type TSelectEventDelivery = typeof eventDeliveriesTable.$inferSelect;
