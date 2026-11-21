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
  EConversationKind,
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
    // the channel the message came in or went out on
    channel: text("channel", { enum: ["signal", "discord", "app"] }).notNull(),
    author: text("author", { enum: ["system", "user", "assistant", "toolResult"] }).notNull(),
    message: text("message").notNull(),
    modelMessage: text("modelMessage"),
    // display: a command, its reply, a notice or a failure reply, shown in history and never
    // replayed to the model
    kind: text("kind", { enum: ["message", "tool", "display"] })
      .notNull()
      .default("message"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    // the id the sending client gave the inbound message the row holds
    clientMessageId: text("clientMessageId"),
    // a user message's attachment references as a JSON array, stored with the row at the turn's
    // start, so a turn that never completes keeps them too
    attachments: text("attachments"),
    // a reply's tool calls as a JSON array, stored with the turn's final assistant row; none when
    // the turn used no tools
    steps: text("steps"),
  },
  (table) => [index("memories_chat_id_idx").on(table.chatId, table.id)],
);

// the conversations with their owner; revision: raised on every change of the transcript;
// rewriteRevision: the revision of the latest change that was not an append (a delete, or rows
// moved in by a merge); kind: an account's Bella conversation or an unlinked chat (bella), or a
// plain chat, listed from its creation; title: a plain chat's title, none until one is written;
// createdAt: when a plain chat was created, none for the others
export const conversationsTable = sqliteTable("conversations", {
  conversationKey: text("conversationKey").primaryKey(),
  ownerKey: text("ownerKey").notNull(),
  revision: integer("revision").notNull().default(0),
  rewriteRevision: integer("rewriteRevision").notNull().default(0),
  kind: text("kind").$type<EConversationKind>().notNull().default(sql`'bella'`),
  title: text("title"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
});

// the images the app uploaded, whose bytes the App channel keeps on its data volume under the id;
// accountId: the uploading account; conversationKey: the conversation it was uploaded to. A row
// goes with its file
export const appMediaTable = sqliteTable(
  "app_media",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    conversationKey: text("conversationKey").notNull(),
    mimeType: text("mimeType").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("app_media_conversation_idx").on(table.conversationKey)],
);

// the app's devices, one per app session, by the id the edge made for the session; accountId: the
// session's account. fcmToken: its FCM registration token; publicKey and authSecret: its RFC 8291
// key material, the P-256 public key and the auth secret, base64url
export const appDevicesTable = sqliteTable(
  "app_devices",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    fcmToken: text("fcmToken").notNull(),
    publicKey: text("publicKey").notNull(),
    authSecret: text("authSecret").notNull(),
    registeredAt: integer("registeredAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("app_devices_account_idx").on(table.accountId)],
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

// an address (channel and address) linked to an account; the account id is opaque
export const identityLinksTable = sqliteTable(
  "identity_links",
  {
    channel: text("channel").notNull(),
    address: text("address").notNull(),
    accountId: text("accountId").notNull(),
    state: text("state").notNull(),
    linkedAt: integer("linkedAt", { mode: "timestamp_ms" }).notNull(),
    // the owners that have moved the address's rows to the account
    movedOwners: text("movedOwners", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
  },
  (table) => [
    primaryKey({ columns: [table.channel, table.address] }),
    check("identity_links_state_check", sql`${table.state} in ('migrating', 'active')`),
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
