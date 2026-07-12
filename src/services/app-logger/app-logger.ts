import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger, writeJsonLog } from "../../utils/logger";
import { getDefaultLogDbPath } from "./config";
import { MEMORY_LOG_CHATID_HMAC_KEY, readOrCreateChatIdHmacKey } from "./hmac-key";
import { buildSearchableText } from "./searchable-text";
import { booleanToSqlite, normalizeDurationMs, normalizeRowId, rowToEvent } from "./sqlite";
import {
  EBehaviorLogLevel,
  SBehaviorLogEvent,
  SBehaviorMetadata,
  SStoredBehaviorLogRow,
  type TBehaviorLogEvent,
  type TBehaviorLogInput,
  type TBehaviorMetadata,
  type TPersistedBehaviorLogEvent,
  type TStoredBehaviorLogRow,
} from "./types";

type TAppLoggerOptions = {
  dbPath?: string;
  stdout?: (event: TBehaviorLogEvent) => void;
};

const SCHEMA_VERSION = 1;

export class AppLogger {
  private static _instance: TOption<AppLogger>;
  private logger = createLogger("APP LOGGER");
  private queue = new AsyncQueue();
  private db: TOption<Database>;
  private initialized = false;
  private dbPath: string;
  private stdout: (event: TBehaviorLogEvent) => void;
  private persistedChatIdHmacKey: TOption<string>;

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
    } else {
      this.logger.error(`record: invalid metadata dropped: ${metadataParse.error.message}`);
    }

    const event: TBehaviorLogEvent = {
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      level: input.level ?? EBehaviorLogLevel.Info,
      event: input.event,
      turnId: input.trace.turnId,
      chatId: this.maskChatId(input.trace.chatId),
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
        searchableText
      );
    `);

    this.initialized = true;
  }

  private insertEvent(db: Database, event: TBehaviorLogEvent) {
    const insert = db.transaction(() => {
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
    });

    insert();
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

  private maskChatId(chatId: TOption<string>): string | null {
    if (chatId === undefined) {
      return null;
    }

    const key = this.getChatIdHmacKey();

    if (key === undefined) {
      return null;
    }

    const digest = createHmac("sha256", key).update(chatId).digest("hex");
    return `sha256:${digest}`;
  }

  private getChatIdHmacKey(): TOption<string> {
    const configuredKey = Bun.env.LOG_CHATID_HMAC_KEY?.trim();

    if (configuredKey !== undefined && configuredKey.length > 0) {
      return configuredKey;
    }

    if (this.dbPath === ":memory:") {
      return MEMORY_LOG_CHATID_HMAC_KEY;
    }

    if (this.persistedChatIdHmacKey !== undefined) {
      return this.persistedChatIdHmacKey;
    }

    try {
      this.ensureDatabaseDirectory();
      this.persistedChatIdHmacKey = readOrCreateChatIdHmacKey(this.dbPath);
      return this.persistedChatIdHmacKey;
    } catch (error) {
      this.logger.error(`record: failed to load chatId HMAC key: ${String(error)}`);
      return undefined;
    }
  }
}
