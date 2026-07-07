import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger, writeJsonLog } from "../../utils/logger";
import {
  EBehaviorLogLevel,
  SBehaviorLogEvent,
  SBehaviorMetadata,
  SStoredBehaviorLogRow,
  type TBehaviorLogEvent,
  type TBehaviorLogInput,
  type TBehaviorMetadata,
  type TBehaviorTraceContext,
  type TPersistedBehaviorLogEvent,
  type TStoredBehaviorLogRow,
} from "./types";

type TAppLoggerOptions = {
  dbPath?: string;
  stdout?: (event: TBehaviorLogEvent) => void;
};

const APP_DATA_DIR = "/app-data";
const DEFAULT_LOG_DB_FILE = "bellaclaw-logs.db";
const SCHEMA_VERSION = 1;

const SEARCHABLE_METADATA_KEYS = new Set([
  "author",
  "component",
  "cronPattern",
  "event",
  "handler",
  "importance",
  "intent",
  "mediaKind",
  "messageType",
  "model",
  "operation",
  "platform",
  "provider",
  "purpose",
  "settingKeys",
  "status",
  "stopReason",
  "toolName",
  "timezone",
]);

export type { TBehaviorLogEvent, TBehaviorMetadata, TBehaviorTraceContext };
export { EBehaviorLogLevel } from "./types";

export function createMessageTurnId(): string {
  return `msg:${crypto.randomUUID()}`;
}

export function createCronTurnId(): string {
  return `cron:${crypto.randomUUID()}`;
}

export function getDefaultLogDbPath(): string {
  const configuredPath = Bun.env.BELLACLAW_LOG_DB_PATH?.trim();

  if (configuredPath !== undefined && configuredPath.length > 0) {
    return configuredPath;
  }

  if (Bun.env.BELLACLAW_DATABASE_MODE === "test" || Bun.env.NODE_ENV === "test") {
    return ":memory:";
  }

  if (existsSync(APP_DATA_DIR)) {
    return `${APP_DATA_DIR}/${DEFAULT_LOG_DB_FILE}`;
  }

  return `./${DEFAULT_LOG_DB_FILE}`;
}

export function formatBehaviorEventForStdout(event: TBehaviorLogEvent): string {
  return JSON.stringify(event);
}

export class AppLogger {
  private static _instance: TOption<AppLogger>;
  private logger = createLogger("APP LOGGER");
  private queue = new AsyncQueue();
  private db: TOption<Database>;
  private initialized = false;
  private dbPath: string;
  private stdout: (event: TBehaviorLogEvent) => void;

  public constructor(options: TAppLoggerOptions = {}) {
    this.dbPath = options.dbPath ?? getDefaultLogDbPath();
    this.stdout = options.stdout ?? writeJsonLog;
  }

  public static get instance() {
    if (!AppLogger._instance) {
      AppLogger._instance = new AppLogger();
    }

    return AppLogger._instance;
  }

  public record(input: TBehaviorLogInput): TBehaviorLogEvent {
    const metadataParse = SBehaviorMetadata.safeParse(input.metadata ?? {});
    let metadata: TBehaviorMetadata = {};

    if (metadataParse.success) {
      metadata = metadataParse.data;
    }

    const event: TBehaviorLogEvent = {
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      level: input.level ?? EBehaviorLogLevel.Info,
      event: input.event,
      turnId: input.trace.turnId,
      chatId: maskChatId(input.trace.chatId),
      platform: input.trace.platform ?? null,
      component: input.component,
      provider: input.provider ?? null,
      model: input.model ?? null,
      purpose: input.purpose ?? null,
      toolName: input.toolName ?? null,
      success: input.success ?? null,
      durationMs: normalizeDurationMs(input.durationMs) ?? null,
      summary: input.summary ?? null,
      metadata,
      error: input.error ?? null,
    };

    const parsed = SBehaviorLogEvent.safeParse(event);

    if (!parsed.success) {
      this.logger.error(`record: invalid event ${parsed.error.message}`);
      return event;
    }

    this.writeStdout(parsed.data);
    this.enqueuePersist(parsed.data);

    return parsed.data;
  }

  public async findByTurnId(turnId: string): Promise<TPersistedBehaviorLogEvent[]> {
    return this.queue.enqueue(async () => {
      const db = this.getDatabase();
      this.initializeSchema(db);

      const rows = db
        .query<TStoredBehaviorLogRow, string>(
          `
          SELECT id, createdAt, schemaVersion, level, event, turnId, chatId, platform, component,
            provider, model, purpose, toolName, success, durationMs, summary, metadataJson, error
          FROM app_event_logs
          WHERE turnId = ?
          ORDER BY createdAt ASC, id ASC
        `,
        )
        .all(turnId);

      return this.parseRows(rows);
    });
  }

  public async flush(): Promise<void> {
    await this.queue.enqueue(async () => undefined);
  }

  public async close(): Promise<void> {
    await this.queue.enqueue(async () => {
      this.db?.close();
      this.db = undefined;
      this.initialized = false;
    });
  }

  private writeStdout(event: TBehaviorLogEvent) {
    try {
      this.stdout(event);
    } catch (error) {
      this.logger.error(`writeStdout: failed to emit behavior event: ${String(error)}`);
    }
  }

  private enqueuePersist(event: TBehaviorLogEvent) {
    this.queue
      .enqueue(async () => {
        try {
          const db = this.getDatabase();
          this.initializeSchema(db);
          this.insertEvent(db, event);
        } catch (error) {
          this.logger.error(`persist: failed to write behavior event: ${String(error)}`);
        }
      })
      .catch((error) => {
        this.logger.error(`persist: queue failed: ${String(error)}`);
      });
  }

  private getDatabase(): Database {
    if (this.db !== undefined) {
      return this.db;
    }

    this.ensureDatabaseDirectory();
    this.db = new Database(this.dbPath, { create: true, readwrite: true });

    return this.db;
  }

  private ensureDatabaseDirectory() {
    if (this.dbPath === ":memory:") {
      return;
    }

    const directory = dirname(this.dbPath);

    if (directory === "." || directory.length === 0) {
      return;
    }

    mkdirSync(directory, { recursive: true });
  }

  private initializeSchema(db: Database) {
    if (this.initialized) {
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS app_event_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        createdAt INTEGER NOT NULL,
        schemaVersion INTEGER NOT NULL,
        level TEXT NOT NULL,
        event TEXT NOT NULL,
        turnId TEXT NOT NULL,
        chatId TEXT,
        platform TEXT,
        component TEXT,
        provider TEXT,
        model TEXT,
        purpose TEXT,
        toolName TEXT,
        success INTEGER,
        durationMs INTEGER,
        summary TEXT,
        metadataJson TEXT NOT NULL,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_app_event_logs_created_at
        ON app_event_logs(createdAt);
      CREATE INDEX IF NOT EXISTS idx_app_event_logs_turn_id
        ON app_event_logs(turnId);
      CREATE INDEX IF NOT EXISTS idx_app_event_logs_chat_created_at
        ON app_event_logs(chatId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_app_event_logs_event_created_at
        ON app_event_logs(event, createdAt);
      CREATE INDEX IF NOT EXISTS idx_app_event_logs_tool_created_at
        ON app_event_logs(toolName, createdAt);
      CREATE INDEX IF NOT EXISTS idx_app_event_logs_success_created_at
        ON app_event_logs(success, createdAt);

      CREATE VIRTUAL TABLE IF NOT EXISTS app_event_logs_fts USING fts5(
        summary,
        searchableText,
        content='app_event_logs',
        content_rowid='id'
      );
    `);

    this.initialized = true;
  }

  private insertEvent(db: Database, event: TBehaviorLogEvent) {
    const createdAt = Date.parse(event.createdAt);
    const metadataJson = JSON.stringify(event.metadata);
    const success = booleanToSqlite(event.success);

    const changes = db
      .query(
        `
        INSERT INTO app_event_logs (
          createdAt, schemaVersion, level, event, turnId, chatId, platform, component, provider,
          model, purpose, toolName, success, durationMs, summary, metadataJson, error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        createdAt,
        event.schemaVersion,
        event.level,
        event.event,
        event.turnId,
        event.chatId,
        event.platform,
        event.component,
        event.provider,
        event.model,
        event.purpose,
        event.toolName,
        success,
        event.durationMs,
        event.summary,
        metadataJson,
        event.error,
      );

    const rowId = normalizeRowId(changes.lastInsertRowid);
    const searchableText = buildSearchableText(event);

    db.query(
      `
      INSERT INTO app_event_logs_fts(rowid, summary, searchableText)
      VALUES (?, ?, ?)
    `,
    ).run(rowId, event.summary, searchableText);
  }

  private parseRows(rows: TStoredBehaviorLogRow[]): TPersistedBehaviorLogEvent[] {
    const events: TPersistedBehaviorLogEvent[] = [];

    for (const row of rows) {
      const rowParse = SStoredBehaviorLogRow.safeParse(row);

      if (!rowParse.success) {
        this.logger.error(`findByTurnId: invalid row ${rowParse.error.message}`);
        continue;
      }

      let metadataJson: unknown;

      try {
        metadataJson = JSON.parse(rowParse.data.metadataJson);
      } catch (error) {
        this.logger.error(`findByTurnId: invalid metadata JSON ${String(error)}`);
        continue;
      }
      const metadataParse = SBehaviorMetadata.safeParse(metadataJson);

      if (!metadataParse.success) {
        this.logger.error(`findByTurnId: invalid metadata ${metadataParse.error.message}`);
        continue;
      }

      const event = rowToEvent(rowParse.data, metadataParse.data);
      events.push(event);
    }

    return events;
  }
}

function normalizeDurationMs(value: TOption<number>): TOption<number> {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value)) {
    return undefined;
  }

  if (value < 0) {
    return 0;
  }

  return Math.round(value);
}

function maskChatId(chatId: TOption<string>): string | null {
  if (chatId === undefined) {
    return null;
  }

  const digest = createHash("sha256").update(chatId).digest("hex");
  return `sha256:${digest}`;
}

function booleanToSqlite(value: boolean | null): number | null {
  if (value === null) {
    return null;
  }

  if (value) {
    return 1;
  }

  return 0;
}

function sqliteToBoolean(value: number | null): TOption<boolean> {
  if (value === null) {
    return undefined;
  }

  return value === 1;
}

function normalizeRowId(value: number | bigint): number {
  if (typeof value === "bigint") {
    return Number(value);
  }

  return value;
}

function rowToEvent(
  row: TStoredBehaviorLogRow,
  metadata: TBehaviorMetadata,
): TPersistedBehaviorLogEvent {
  return {
    id: row.id,
    createdAtMs: row.createdAt,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date(row.createdAt).toISOString(),
    level: row.level,
    event: row.event,
    turnId: row.turnId,
    chatId: row.chatId,
    platform: row.platform,
    component: row.component,
    provider: row.provider,
    model: row.model,
    purpose: row.purpose,
    toolName: row.toolName,
    success: sqliteToBoolean(row.success) ?? null,
    durationMs: row.durationMs,
    summary: row.summary,
    metadata,
    error: row.error,
  };
}

function buildSearchableText(event: TBehaviorLogEvent): string {
  const parts: string[] = [
    event.event,
    event.component ?? "",
    event.provider ?? "",
    event.model ?? "",
    event.purpose ?? "",
    event.toolName ?? "",
  ];

  collectSearchableMetadata(event.metadata, parts);

  return parts
    .filter((part) => part.trim().length > 0)
    .join(" ")
    .trim();
}

function collectSearchableMetadata(metadata: TBehaviorMetadata, parts: string[]) {
  for (const [key, value] of Object.entries(metadata)) {
    if (!SEARCHABLE_METADATA_KEYS.has(key)) {
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
      continue;
    }

    if (Array.isArray(value)) {
      collectSearchableArray(value, parts);
    }
  }
}

function collectSearchableArray(values: TBehaviorMetadata[string][], parts: string[]) {
  for (const value of values) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
    }
  }
}
