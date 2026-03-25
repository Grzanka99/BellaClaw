import { Database } from "bun:sqlite";
import { z } from "zod";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger, type TLogger } from "../../utils/logger";
import { SMemory, type TFindMemoryArgs, type TMemory, type TSaveArgs } from "./types";

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

type TMemoryError = {
  operation: "write" | "read" | "update" | "delete";
  error: unknown;
};

export class Memory {
  private static _instance: Memory;
  private db: Database;
  private queue: AsyncQueue;
  private logger: TLogger = createLogger("MEMORY");

  // NOTE: To simplify and improve tests setup
  private static MEMORY_FILE = PERSISTENT_MEMORY_DB;

  private constructor() {
    this.queue = new AsyncQueue();
    this.db = new Database(Memory.MEMORY_FILE);

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

  public async find(args: TFindMemoryArgs): Promise<TMemory[] | TMemoryError> {
    const res = await this.queue.enqueue(async () => {
      const conditions: string[] = ["userId = $userId"];
      const params: Record<string, string | number | null> = { $userId: args.userId };

      if (args.author !== undefined) {
        conditions.push("author = $author");
        params.$author = args.author;
      }

      if (args.guild !== undefined) {
        conditions.push("guild = $guild");
        params.$guild = args.guild;
      }

      if (args.importance !== undefined && args.importance.length > 0) {
        const placeholders = args.importance.map((_, i) => `$importance${i}`).join(", ");
        conditions.push(`importance IN (${placeholders})`);
        for (let i = 0; i < args.importance.length; i++) {
          const val = args.importance[i];
          if (val !== undefined) {
            params[`$importance${i}`] = val;
          }
        }
      }

      if (args.searchString !== undefined) {
        conditions.push("message LIKE $searchString");
        params.$searchString = `%${args.searchString}%`;
      }

      if (args.timeRange !== undefined) {
        conditions.push("createdAt >= $timeStart AND createdAt <= $timeEnd");
        params.$timeStart = args.timeRange.start.getTime();
        params.$timeEnd = args.timeRange.end.getTime();
      }

      let queryStr = `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY createdAt DESC`;

      if (args.limit !== undefined) {
        queryStr += ` LIMIT $limit`;
        params.$limit = args.limit;
      }

      const results = this.db.query(queryStr).all(params);

      const parsed = z.array(SMemory).safeParse(results);

      if (!parsed.success) {
        this.logger.error("Failed to parse memory from DB");
        return undefined;
      }

      return parsed.data;
    });

    if (!res) {
      return {
        operation: "read",
        error: "Failed to read memory",
      };
    }

    return res.map((row) => ({
      id: row.id,
      userId: row.userId,
      author: row.author,
      guild: row.guild,
      importance: row.importance,
      message: row.message,
      createdAt: new Date(row.createdAt),
      lastReadAt: new Date(row.lastReadAt),
    }));
  }

  public async readFullMemory(userId: string): Promise<TMemory[] | TMemoryError> {
    const res = await this.queue.enqueue(async () => {
      const queryStr = `SELECT * FROM memories WHERE userId = $userId ORDER BY createdAt DESC`;
      const results = this.db.query(queryStr).all({ $userId: userId });

      const parsed = z.array(SMemory).safeParse(results);

      if (!parsed.success) {
        this.logger.error("Failed to parse memory from DB");
        return undefined;
      }

      return parsed.data;
    });

    if (!res) {
      return {
        operation: "read",
        error: "Failed to read memory",
      };
    }

    return res.map((row) => ({
      id: row.id,
      userId: row.userId,
      author: row.author,
      guild: row.guild,
      importance: row.importance,
      message: row.message,
      createdAt: new Date(row.createdAt),
      lastReadAt: new Date(row.lastReadAt),
    }));
  }

  public async save(args: TSaveArgs): Promise<Omit<TMemory, "id"> | TMemoryError> {
    const query = `
      INSERT INTO
        memories (userId, author, guild, importance, message, createdAt, lastReadAt)
      VALUES
        ($userId, $author, $guild, $importance, $message, $createdAt, $lastReadAt)
    `;

    const now = Date.now();

    try {
      const res = await this.queue.enqueue(async () => {
        return this.db.query(query).run({
          $userId: args.userId,
          $author: args.author,
          $guild: args.guild ?? null,
          $importance: args.importance,
          $message: args.message,
          $createdAt: now,
          $lastReadAt: now,
        });
      });

      if (res.changes > 0) {
        return {
          userId: args.userId,
          author: args.author,
          guild: args.guild,
          importance: args.importance,
          message: args.message,
          createdAt: new Date(now),
          lastReadAt: new Date(now),
        };
      }

      this.logger.error(`changes: ${res.changes}`);
      return {
        operation: "write",
        error: "changes size is 0",
      };
    } catch (error) {
      this.logger.error(`Something went wrong while saving memory: ${String(error)}`);
      return {
        operation: "write",
        error,
      };
    }
  }

  public async remove(id: string): Promise<TMemory | TMemoryError> {
    const query = `
      DELETE FROM memories
      WHERE id = $id
      RETURNING *
    `;

    try {
      const res = await this.queue.enqueue(async () =>
        this.db.query(query).get({
          $id: id,
        }),
      );

      if (!res) {
        return {
          operation: "delete",
          error: "No memory found with the given id",
        };
      }

      const parsed = SMemory.safeParse(res);

      if (!parsed.success) {
        this.logger.error("Failed to parse removed memory result");
        return {
          operation: "delete",
          error: parsed.error,
        };
      }

      return {
        id: parsed.data.id,
        userId: parsed.data.userId,
        author: parsed.data.author,
        guild: parsed.data.guild,
        importance: parsed.data.importance,
        message: parsed.data.message,
        createdAt: new Date(parsed.data.createdAt),
        lastReadAt: new Date(parsed.data.lastReadAt),
      };
    } catch (error) {
      this.logger.error(`Something went wrong while removing memory: ${String(error)}`);
      return {
        operation: "delete",
        error,
      };
    }
  }
}
