import { Database } from "bun:sqlite";
import { z } from "zod";
import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { Logger } from "../../utils/logger";
import {
  type EMemoryImportance,
  SMemory,
  type TFindMemoryArgs,
  type TMemory,
  type TRemember,
} from "./types";
import { sortByImportanceAndDates } from "./sort";

export const PERSISTENT_MEMORY_DB = "persistent-memory.db" as const;

export const CREATE_MEMORIES_TABLE = `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    author TEXT NOT NULL,
    guild TEXT NULLABLE,
    importance INTEGER NOT NULL,
    message TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    lastReadAt INTEGER NOT NULL
  )
`;

export class Memory extends Logger {
  private static _instance: Memory;
  private db: Database;
  private queue: AsyncQueue;

  private constructor() {
    super("MEMORY");
    this.queue = new AsyncQueue();
    this.db = new Database(PERSISTENT_MEMORY_DB);

    this.queue.enqueue(async () => {
      this.db.run(CREATE_MEMORIES_TABLE);
    });
  }

  public static get instance() {
    if (!Memory._instance) {
      Memory._instance = new Memory();
    }
    return Memory._instance;
  }

  public async readFullMemory(userId: string): Promise<TOption<TMemory[]>> {
    const res = await this.queue.enqueue(async () => {
      const queryStr = `SELECT * FROM memories WHERE userId = $userId ORDER BY createdAt DESC`;
      const results = this.db.query(queryStr).all({ $userId: userId });

      console.log(userId, results);
      const parsed = z.array(SMemory).safeParse(results);

      if (!parsed.success) {
        this.logger.error("Failed to parse memory results");
        console.log(parsed.error);
        return undefined;
      }

      return parsed.data;
    });

    if (!res) {
      return undefined;
    }

    return res.map((row) => ({
      id: row.id,
      userId: row.userId,
      author: row.author,
      guild: row.guild,
      importance: row.importance as EMemoryImportance,
      message: row.message,
      createdAt: new Date(row.createdAt),
      lastReadAt: new Date(row.lastReadAt),
    }));
  }

  public remember(args: TRemember): boolean {
    const query = `
      INSERT INTO
        memories (userId, author, guild, importance, message, createdAt, lastReadAt)
      VALUES
        ($userId, $author, $guild, $importance, $message, $createdAt, $lastReadAt)
    `;

    try {
      this.queue.enqueue(async () => {
        this.db.query(query).run({
          $userId: args.userId,
          $author: args.author,
          $guild: args.guild ?? null,
          $importance: args.importance,
          $message: args.message,
          $createdAt: Date.now(),
          $lastReadAt: Date.now(),
        });
      });
      return true;
    } catch (_) {
      this.logger.error("Failed to save memory");
      return false;
    }
  }

  public async find(args: TFindMemoryArgs): Promise<TOption<TMemory[]>> {
    const res = await this.queue.enqueue(async () => {
      let queryStr = `
      SELECT * FROM memories
      WHERE userId = $userId
      AND message LIKE $query
    `;

      const params: Record<string, string | number> = {
        $userId: args.userId,
        $query: `%${args.query}%`,
      };

      if (args.timeRange) {
        queryStr += ` AND (createdAt >= $startCA AND createdAt <= $endCA`;
        params.$startCA = args.timeRange.start.getTime();
        params.$endCA = args.timeRange.end.getTime();

        queryStr += ` OR lastReadAt >= $startLR AND lastReadAt <= $endLR)`;
        params.$startLR = args.timeRange.start.getTime();
        params.$endLR = args.timeRange.end.getTime();
      }

      queryStr += ` ORDER BY createdAt DESC`;

      const query = this.db.query(queryStr);
      const results = query.all(params);

      const parsed = z.array(SMemory).safeParse(results);

      if (!parsed.success) {
        this.logger.error("Failed to parse memory results");
        console.log(parsed.error);
        return undefined;
      }

      const res = parsed.data;

      if (res.length > 0) {
        const updateQuery = `
          UPDATE memories
          SET lastReadAt = ?
          WHERE id IN (${res.map(() => "?").join(", ")})
        `;
        this.db.query(updateQuery).run(Date.now(), ...res.map((r) => r.id));
      }

      return res;
    });

    if (!res) {
      return undefined;
    }

    return res
      .map((row) => ({
        id: row.id,
        userId: row.userId,
        author: row.author,
        guild: row.guild,
        importance: row.importance as EMemoryImportance,
        message: row.message,
        createdAt: new Date(row.createdAt),
        lastReadAt: new Date(row.lastReadAt),
      }))
      .sort(sortByImportanceAndDates);
  }

  public forget(args: TFindMemoryArgs): boolean {
    return true;
  }
}
