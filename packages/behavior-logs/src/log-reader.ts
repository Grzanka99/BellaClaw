import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { AsyncQueue, createLogger, type TOption } from "@bellaclaw/shared";
import { z } from "zod";
import type {
  TBehaviorLogSearchQuery,
  TLogFilterOptions,
  TLogPage,
  TLogReaderError,
  TLogReaderResult,
  TRecentTurn,
} from "./reader-types";
import { rowToEvent } from "./sqlite";
import {
  SBehaviorMetadata,
  SStoredBehaviorLogRow,
  type TPersistedBehaviorLogEvent,
  type TStoredBehaviorLogRow,
} from "./types";

type TSqlBinding = string | number | null;

type TWhereClause = {
  join: string;
  sql: string;
  bindings: TSqlBinding[];
};

const SRecentTurnRow = z.object({
  turnId: z.string(),
  latestCreatedAtMs: z.number(),
  eventCount: z.number(),
  hasFailure: z.number(),
});

const SFilterValueRow = z.object({ value: z.string() });
const PAGE_SIZE = 100;
const EVENT_COLUMNS = `
  l.id, l.createdAt, l.schemaVersion, l.level, l.event, l.turnId, l.chatId,
  l.platform, l.component, l.provider, l.model, l.purpose, l.toolName, l.success,
  l.durationMs, l.summary, l.metadataJson, l.error
`;

export class LogReader {
  private logger = createLogger("LOG VIEWER");
  private queue = new AsyncQueue();
  private db: TOption<Database>;

  public constructor(private dbPath: string) {}

  public async readLogPage(query: TBehaviorLogSearchQuery): Promise<TLogReaderResult<TLogPage>> {
    return this.queue.enqueue(async (): Promise<TLogReaderResult<TLogPage>> => {
      try {
        const db = this.getDatabase();
        const eventPage = this.selectEvents(db, query);

        return {
          success: true,
          data: {
            events: eventPage.events,
            hasMore: eventPage.hasMore,
            recentTurns: this.selectRecentTurns(db),
            filters: this.selectFilters(db),
          },
        };
      } catch (error) {
        return { success: false, error: this.describeError(error) };
      }
    });
  }

  public async countNewEvents(
    query: TBehaviorLogSearchQuery,
    afterCreatedAt: number,
    afterId: number,
  ): Promise<TLogReaderResult<number>> {
    return this.queue.enqueue(async (): Promise<TLogReaderResult<number>> => {
      try {
        const db = this.getDatabase();
        const where = this.buildWhere(query, false);
        where.bindings.push(afterCreatedAt, afterCreatedAt, afterId);
        const row = db
          .query<unknown, TSqlBinding[]>(
            `
              SELECT COUNT(*) AS count
              FROM app_event_logs l
              ${where.join}
              WHERE ${where.sql}
                AND (l.createdAt > ? OR (l.createdAt = ? AND l.id > ?))
            `,
          )
          .get(...where.bindings);
        const parsed = z.object({ count: z.number() }).safeParse(row);

        if (!parsed.success) {
          throw new Error(`Invalid live count row: ${parsed.error.message}`);
        }

        return { success: true, data: parsed.data.count };
      } catch (error) {
        return { success: false, error: this.describeError(error) };
      }
    });
  }

  public async health(): Promise<TLogReaderResult<undefined>> {
    return this.queue.enqueue(async (): Promise<TLogReaderResult<undefined>> => {
      try {
        const db = this.getDatabase();
        this.verifySchema(db);
        return { success: true, data: undefined };
      } catch (error) {
        return { success: false, error: this.describeError(error) };
      }
    });
  }

  public async close(): Promise<void> {
    await this.queue.enqueue(async () => {
      try {
        this.db?.close();
      } catch (error) {
        this.logger.warning(`close: ${String(error)}`);
      }

      this.db = undefined;
    });
  }

  private getDatabase(): Database {
    if (this.db !== undefined) {
      return this.db;
    }

    if (!existsSync(this.dbPath)) {
      throw new Error("Behavior log database does not exist");
    }

    const db = new Database(this.dbPath, { readonly: true, create: false });
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 2000");

    try {
      this.verifySchema(db);
    } catch (error) {
      db.close();
      throw error;
    }

    this.db = db;

    return db;
  }

  private verifySchema(db: Database) {
    db.query(`SELECT ${EVENT_COLUMNS} FROM app_event_logs l LIMIT 1`).get();
    db.query("SELECT rowid FROM app_event_logs_fts WHERE app_event_logs_fts MATCH ? LIMIT 1").get(
      "bellaclaw_health_check",
    );
  }

  private selectEvents(db: Database, query: TBehaviorLogSearchQuery) {
    const where = this.buildWhere(query, true);

    if (query.beforeCreatedAt !== undefined && query.beforeId !== undefined) {
      where.sql += " AND (l.createdAt < ? OR (l.createdAt = ? AND l.id < ?))";
      where.bindings.push(query.beforeCreatedAt, query.beforeCreatedAt, query.beforeId);
    }

    where.bindings.push(PAGE_SIZE + 1);
    const rows = db
      .query<unknown, TSqlBinding[]>(
        `
          SELECT ${EVENT_COLUMNS}
          FROM app_event_logs l
          ${where.join}
          WHERE ${where.sql}
          ORDER BY l.createdAt DESC, l.id DESC
          LIMIT ?
        `,
      )
      .all(...where.bindings);
    let hasMore = false;

    if (rows.length > PAGE_SIZE) {
      rows.pop();
      hasMore = true;
    }

    return { events: this.parseEvents(rows), hasMore };
  }

  private selectRecentTurns(db: Database): TRecentTurn[] {
    const rows = db
      .query<unknown, number>(
        `
          SELECT turnId, MAX(createdAt) AS latestCreatedAtMs, COUNT(*) AS eventCount,
            MAX(CASE WHEN success = 0 OR level = 'error' THEN 1 ELSE 0 END) AS hasFailure
          FROM app_event_logs
          GROUP BY turnId
          ORDER BY latestCreatedAtMs DESC
          LIMIT ?
        `,
      )
      .all(50);
    const turns: TRecentTurn[] = [];

    for (const row of rows) {
      const parsed = SRecentTurnRow.safeParse(row);

      if (!parsed.success) {
        throw new Error(`Invalid recent turn row: ${parsed.error.message}`);
      }

      turns.push({
        turnId: parsed.data.turnId,
        latestCreatedAtMs: parsed.data.latestCreatedAtMs,
        eventCount: parsed.data.eventCount,
        hasFailure: parsed.data.hasFailure === 1,
      });
    }

    return turns;
  }

  private selectFilters(db: Database): TLogFilterOptions {
    return {
      events: this.selectFilterValues(db, "event"),
      components: this.selectFilterValues(db, "component"),
      toolNames: this.selectFilterValues(db, "toolName"),
    };
  }

  private selectFilterValues(db: Database, column: "event" | "component" | "toolName") {
    const rows = db
      .query<unknown, []>(
        `
          SELECT DISTINCT ${column} AS value
          FROM app_event_logs
          WHERE ${column} IS NOT NULL AND ${column} <> ''
          ORDER BY value ASC
        `,
      )
      .all();
    const values: string[] = [];

    for (const row of rows) {
      const parsed = SFilterValueRow.safeParse(row);

      if (!parsed.success) {
        throw new Error(`Invalid filter row: ${parsed.error.message}`);
      }

      values.push(parsed.data.value);
    }

    return values;
  }

  private buildWhere(query: TBehaviorLogSearchQuery, includeUpperBound: boolean): TWhereClause {
    const conditions = ["1 = 1"];
    const bindings: TSqlBinding[] = [];
    let join = "";
    const ftsQuery = this.buildFtsQuery(query.q);

    if (ftsQuery !== undefined) {
      join = "JOIN app_event_logs_fts ON app_event_logs_fts.rowid = l.id";
      conditions.push("app_event_logs_fts MATCH ?");
      bindings.push(ftsQuery);
    }

    const start = this.getRangeStart(query.range, query.until);

    if (start !== undefined) {
      conditions.push("l.createdAt >= ?");
      bindings.push(start);
    }

    if (includeUpperBound) {
      conditions.push("l.createdAt <= ?");
      bindings.push(query.until);
    }

    if (query.level !== undefined) {
      conditions.push("l.level = ?");
      bindings.push(query.level);
    }

    if (query.success === "success") {
      conditions.push("l.success = 1");
    }

    if (query.success === "failure") {
      conditions.push("l.success = 0");
    }

    this.addExactFilter(conditions, bindings, "event", query.event);
    this.addExactFilter(conditions, bindings, "component", query.component);
    this.addExactFilter(conditions, bindings, "toolName", query.toolName);
    this.addExactFilter(conditions, bindings, "turnId", query.turnId);

    return { join, sql: conditions.join(" AND "), bindings };
  }

  private addExactFilter(
    conditions: string[],
    bindings: TSqlBinding[],
    column: "event" | "component" | "toolName" | "turnId",
    value: TOption<string>,
  ) {
    if (value === undefined) {
      return;
    }

    conditions.push(`l.${column} = ?`);
    bindings.push(value);
  }

  private buildFtsQuery(query: TOption<string>): TOption<string> {
    if (query === undefined) {
      return undefined;
    }

    const terms = query
      .trim()
      .split(/\s+/)
      .map((term) => term.replaceAll('"', '""'))
      .filter((term) => term.length > 0);

    if (terms.length === 0) {
      return undefined;
    }

    return terms.map((term) => `"${term}"*`).join(" AND ");
  }

  private getRangeStart(range: TBehaviorLogSearchQuery["range"], until: number): TOption<number> {
    switch (range) {
      case "15m": {
        return until - 15 * 60 * 1000;
      }
      case "1h": {
        return until - 60 * 60 * 1000;
      }
      case "24h": {
        return until - 24 * 60 * 60 * 1000;
      }
      case "7d": {
        return until - 7 * 24 * 60 * 60 * 1000;
      }
      case "all": {
        return undefined;
      }
    }
  }

  private parseEvents(rows: unknown[]): TPersistedBehaviorLogEvent[] {
    const events: TPersistedBehaviorLogEvent[] = [];

    for (const row of rows) {
      const rowParse = SStoredBehaviorLogRow.safeParse(row);

      if (!rowParse.success) {
        throw new Error(`Invalid log row: ${rowParse.error.message}`);
      }

      const metadata = this.parseMetadata(rowParse.data);
      events.push(rowToEvent(rowParse.data, metadata));
    }

    return events;
  }

  private parseMetadata(row: TStoredBehaviorLogRow) {
    let metadataJson: unknown;

    try {
      metadataJson = JSON.parse(row.metadataJson);
    } catch (error) {
      throw new Error(`Invalid metadata JSON: ${String(error)}`);
    }

    const parsed = SBehaviorMetadata.safeParse(metadataJson);

    if (!parsed.success) {
      throw new Error(`Invalid metadata: ${parsed.error.message}`);
    }

    return parsed.data;
  }

  private describeError(error: unknown): TLogReaderError {
    let detail = String(error);

    if (error instanceof Error) {
      detail = error.message;
    }

    if (!existsSync(this.dbPath)) {
      return {
        kind: "missing",
        message: "Behavior log database not found",
        detail,
        dbPath: this.dbPath,
      };
    }

    if (detail.includes("no such table") || detail.includes("no such module: fts5")) {
      return {
        kind: "schema",
        message: "Behavior log database schema is unavailable",
        detail,
        dbPath: this.dbPath,
      };
    }

    return {
      kind: "unavailable",
      message: "Behavior log database cannot be queried",
      detail,
      dbPath: this.dbPath,
    };
  }
}
