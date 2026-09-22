import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { AsyncQueue, createLogger, type TOption } from "@bellaclaw/shared";
import { z } from "zod";
import { maskCanonicalChatId } from "./hmac-key";
import type {
  TBehaviorLogSearchQuery,
  TCacheHitRate,
  TChatMetricOptions,
  TLogFilterOptions,
  TLogPage,
  TLogReaderError,
  TLogReaderResult,
  TRecentFailuresOptions,
  TRecentTurn,
  TTurnLatency,
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
const SCompletedTurnRow = z.object({
  turnId: z.string(),
  startedAtMs: z.number(),
  completedAtMs: z.number(),
  completedId: z.number(),
});
const STurnIdRow = z.object({ turnId: z.string() });
const SModelUsageMetadata = z.object({
  cacheRead: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
});
const SDiagnosticCutoffRow = z.object({
  id: z.number(),
  createdAtMs: z.number(),
});
type TDiagnosticCutoff = z.infer<typeof SDiagnosticCutoffRow>;
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

  public async readNewEvents(
    query: TBehaviorLogSearchQuery,
    afterCreatedAt: number,
    afterId: number,
  ): Promise<TLogReaderResult<TPersistedBehaviorLogEvent[]>> {
    return this.queue.enqueue(async () => {
      try {
        const db = this.getDatabase();
        const where = this.buildWhere(query, false);
        where.bindings.push(afterCreatedAt, afterCreatedAt, afterId, PAGE_SIZE);
        const rows = db
          .query<unknown, TSqlBinding[]>(
            `
              SELECT ${EVENT_COLUMNS}
              FROM app_event_logs l
              ${where.join}
              WHERE ${where.sql}
                AND (l.createdAt > ? OR (l.createdAt = ? AND l.id > ?))
              ORDER BY l.createdAt ASC, l.id ASC
              LIMIT ?
            `,
          )
          .all(...where.bindings);

        // Advance through the oldest unseen batch so bursts cannot skip events.
        return { success: true, data: this.parseEvents(rows).reverse() };
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

  public async readRecentFailures(
    options: TRecentFailuresOptions,
  ): Promise<TLogReaderResult<TPersistedBehaviorLogEvent[]>> {
    return this.queue.enqueue(async () => {
      try {
        const db = this.getDatabase();
        const bindings: TSqlBinding[] = [options.sinceMs];
        let exclude = "";

        if (options.excludeTurnId !== undefined) {
          const cutoff = this.selectDiagnosticCutoff(db, options.excludeTurnId);
          exclude = "AND l.turnId <> ?";
          bindings.push(options.excludeTurnId);

          if (cutoff !== undefined) {
            exclude += " AND (l.createdAt < ? OR (l.createdAt = ? AND l.id < ?))";
            bindings.push(cutoff.createdAtMs, cutoff.createdAtMs, cutoff.id);
          }
        }

        bindings.push(options.limit);
        const rows = db
          .query<unknown, TSqlBinding[]>(
            `
              SELECT ${EVENT_COLUMNS}
              FROM app_event_logs l
              WHERE l.createdAt >= ?
                AND (l.success = 0 OR l.error IS NOT NULL)
                ${exclude}
              ORDER BY l.createdAt DESC, l.id DESC
              LIMIT ?
            `,
          )
          .all(...bindings);

        return { success: true, data: this.parseEvents(rows) };
      } catch (error) {
        return { success: false, error: this.describeError(error) };
      }
    });
  }

  public async readTurn(turnId: string): Promise<TLogReaderResult<TPersistedBehaviorLogEvent[]>> {
    return this.queue.enqueue(async () => {
      try {
        const db = this.getDatabase();
        return { success: true, data: this.selectTurnEvents(db, [turnId], undefined) };
      } catch (error) {
        return { success: false, error: this.describeError(error) };
      }
    });
  }

  public async readLatestTurnLatency(
    options: TChatMetricOptions,
  ): Promise<TLogReaderResult<TTurnLatency | null>> {
    return this.queue.enqueue(async () => {
      try {
        const db = this.getDatabase();
        const maskedChatId = maskCanonicalChatId(this.dbPath, options.chatId);

        if (maskedChatId === undefined) {
          throw new Error("Behavior log chat ID key is unavailable");
        }

        const bindings: TSqlBinding[] = [maskedChatId];
        let exclude = "";
        let cutoff: TOption<TDiagnosticCutoff>;

        if (options.excludeTurnId !== undefined) {
          cutoff = this.selectDiagnosticCutoff(db, options.excludeTurnId);
          exclude = "AND turnId <> ?";
          bindings.push(options.excludeTurnId);

          if (cutoff !== undefined) {
            exclude += " AND (createdAt < ? OR (createdAt = ? AND id < ?))";
            bindings.push(cutoff.createdAtMs, cutoff.createdAtMs, cutoff.id);
          }
        }

        const row = db
          .query<unknown, TSqlBinding[]>(
            `
              SELECT turnId,
                MIN(CASE WHEN event = 'message.received' AND component = 'messaging'
                  THEN createdAt END) AS startedAtMs,
                MAX(CASE WHEN event = 'handler.completed' AND component = 'messaging'
                  THEN createdAt END) AS completedAtMs,
                MAX(CASE WHEN event = 'handler.completed' AND component = 'messaging'
                  THEN id END) AS completedId
              FROM app_event_logs
              WHERE chatId = ? ${exclude}
              GROUP BY turnId
              HAVING startedAtMs IS NOT NULL
                AND completedAtMs IS NOT NULL
                AND completedAtMs >= startedAtMs
              ORDER BY completedAtMs DESC, completedId DESC
              LIMIT 1
            `,
          )
          .get(...bindings);

        if (row === null) {
          return { success: true, data: null };
        }

        const parsed = SCompletedTurnRow.safeParse(row);

        if (!parsed.success) {
          throw new Error(`Invalid completed turn row: ${parsed.error.message}`);
        }

        const events = this.selectTurnEvents(db, [parsed.data.turnId], cutoff);
        const timeline = events.map((event) => {
          const endOffsetMs = Math.max(0, event.createdAtMs - parsed.data.startedAtMs);
          let startOffsetMs = endOffsetMs;

          if (event.durationMs !== null) {
            startOffsetMs = Math.max(0, endOffsetMs - event.durationMs);
          }

          return { event, startOffsetMs, endOffsetMs };
        });

        return {
          success: true,
          data: {
            turnId: parsed.data.turnId,
            startedAtMs: parsed.data.startedAtMs,
            completedAtMs: parsed.data.completedAtMs,
            latencyMs: Math.max(0, parsed.data.completedAtMs - parsed.data.startedAtMs),
            timeline,
          },
        };
      } catch (error) {
        return { success: false, error: this.describeError(error) };
      }
    });
  }

  public async readCacheHitRate(
    options: TChatMetricOptions,
  ): Promise<TLogReaderResult<TCacheHitRate>> {
    return this.queue.enqueue(async () => {
      try {
        const db = this.getDatabase();
        const maskedChatId = maskCanonicalChatId(this.dbPath, options.chatId);

        if (maskedChatId === undefined) {
          throw new Error("Behavior log chat ID key is unavailable");
        }

        const bindings: TSqlBinding[] = [maskedChatId];
        let exclude = "";
        let cutoff: TOption<TDiagnosticCutoff>;

        if (options.excludeTurnId !== undefined) {
          cutoff = this.selectDiagnosticCutoff(db, options.excludeTurnId);
          exclude = "AND turnId <> ?";
          bindings.push(options.excludeTurnId);

          if (cutoff !== undefined) {
            exclude += " AND (createdAt < ? OR (createdAt = ? AND id < ?))";
            bindings.push(cutoff.createdAtMs, cutoff.createdAtMs, cutoff.id);
          }
        }

        const rows = db
          .query<unknown, TSqlBinding[]>(
            `
              SELECT turnId
              FROM app_event_logs
              WHERE chatId = ? ${exclude}
              GROUP BY turnId
              HAVING SUM(CASE WHEN event = 'message.received' AND component = 'messaging'
                  THEN 1 ELSE 0 END) > 0
                AND SUM(CASE WHEN event = 'handler.completed' AND component = 'messaging'
                  THEN 1 ELSE 0 END) > 0
                AND MAX(CASE WHEN event = 'handler.completed' AND component = 'messaging'
                  THEN createdAt END) >= MIN(CASE
                    WHEN event = 'message.received' AND component = 'messaging'
                    THEN createdAt END)
              ORDER BY MAX(CASE WHEN event = 'handler.completed' AND component = 'messaging'
                THEN createdAt END) DESC,
                MAX(CASE WHEN event = 'handler.completed' AND component = 'messaging'
                  THEN id END) DESC
              LIMIT 10
            `,
          )
          .all(...bindings);
        const turnIds: string[] = [];

        for (const row of rows) {
          const parsed = STurnIdRow.safeParse(row);

          if (!parsed.success) {
            throw new Error(`Invalid completed turn row: ${parsed.error.message}`);
          }

          turnIds.push(parsed.data.turnId);
        }

        const events = this.selectTurnEvents(db, turnIds, cutoff);
        const turnsWithModelRequests = new Set<string>();
        let modelRequestCount = 0;
        let modelRequestsWithUsage = 0;
        let cacheReadTokens = 0;
        let inputTokens = 0;

        for (const event of events) {
          if (event.event !== "model.request.completed") {
            continue;
          }

          turnsWithModelRequests.add(event.turnId);
          modelRequestCount += 1;
          const usage = SModelUsageMetadata.safeParse(event.metadata);

          if (!usage.success) {
            continue;
          }

          modelRequestsWithUsage += 1;
          cacheReadTokens += usage.data.cacheRead;
          inputTokens += usage.data.inputTokens;
        }

        let cacheHitRatePercent: number | null = null;

        if (inputTokens > 0) {
          cacheHitRatePercent = (100 * cacheReadTokens) / inputTokens;
        }

        return {
          success: true,
          data: {
            completedTurnCount: turnIds.length,
            turnsWithModelRequests: turnsWithModelRequests.size,
            modelRequestCount,
            modelRequestsWithUsage,
            cacheReadTokens,
            inputTokens,
            cacheHitRatePercent,
          },
        };
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

  private selectTurnEvents(
    db: Database,
    turnIds: string[],
    cutoff: TOption<TDiagnosticCutoff>,
  ): TPersistedBehaviorLogEvent[] {
    if (turnIds.length === 0) {
      return [];
    }

    const placeholders = turnIds.map(() => "?").join(", ");
    const bindings: TSqlBinding[] = [...turnIds];
    let upperBound = "";

    if (cutoff !== undefined) {
      upperBound = "AND (l.createdAt < ? OR (l.createdAt = ? AND l.id < ?))";
      bindings.push(cutoff.createdAtMs, cutoff.createdAtMs, cutoff.id);
    }

    const rows = db
      .query<unknown, TSqlBinding[]>(
        `
          SELECT ${EVENT_COLUMNS}
          FROM app_event_logs l
          WHERE l.turnId IN (${placeholders})
            ${upperBound}
          ORDER BY l.createdAt ASC, l.id ASC
        `,
      )
      .all(...bindings);

    return this.parseEvents(rows);
  }

  private selectDiagnosticCutoff(db: Database, excludeTurnId: string): TOption<TDiagnosticCutoff> {
    const row = db
      .query<unknown, string>(
        `
          SELECT id, createdAt AS createdAtMs
          FROM app_event_logs
          WHERE turnId = ?
          ORDER BY createdAt ASC, id ASC
          LIMIT 1
        `,
      )
      .get(excludeTurnId);

    if (row === null) {
      return undefined;
    }

    const parsed = SDiagnosticCutoffRow.safeParse(row);

    if (!parsed.success) {
      throw new Error(`Invalid diagnostic cutoff row: ${parsed.error.message}`);
    }

    return parsed.data;
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
