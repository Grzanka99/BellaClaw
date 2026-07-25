import { and, desc, eq, gte, inArray, like, lte } from "drizzle-orm";
import { z } from "zod";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger, type TLogger } from "../../utils/logger";
import { DatabaseConnector } from "../database";
import { memoriesTable } from "../database/schema";
import { SMemory, type TFindMemoryArgs, type TMemory, type TSaveArgs } from "./types";

type TMemoryError = {
  operation: "write" | "read" | "update" | "delete";
  error: unknown;
};

type TMemoryResult =
  | {
      success: true;
      data: TMemory[];
    }
  | {
      success: false;
      error: TMemoryError;
    };

export class Memory {
  private static _instance: Memory;
  private db = DatabaseConnector.instance.database;
  private queue: AsyncQueue;
  private logger: TLogger = createLogger("MEMORY");

  private constructor() {
    this.queue = new AsyncQueue();
  }

  public static get instance() {
    if (!Memory._instance) {
      Memory._instance = new Memory();
    }
    return Memory._instance;
  }

  public async find(args: TFindMemoryArgs): Promise<TMemory[] | TMemoryError> {
    const res = await this.queue.enqueue(async () => {
      const conditions = [eq(memoriesTable.chatId, args.chatId)];

      if (args.author !== undefined) {
        conditions.push(eq(memoriesTable.author, args.author));
      }

      if (args.importance !== undefined && args.importance.length > 0) {
        conditions.push(inArray(memoriesTable.importance, args.importance));
      }

      if (args.searchString !== undefined) {
        conditions.push(like(memoriesTable.message, `%${args.searchString}%`));
      }

      if (args.timeRange !== undefined) {
        conditions.push(gte(memoriesTable.createdAt, args.timeRange.start.getTime()));
        conditions.push(lte(memoriesTable.createdAt, args.timeRange.end.getTime()));
      }

      let query = this.db
        .select()
        .from(memoriesTable)
        .where(and(...conditions))
        .orderBy(desc(memoriesTable.createdAt))
        .$dynamic();

      if (args.limit !== undefined) {
        query = query.limit(args.limit);
      }

      const results = await query;

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
      chatId: row.chatId,
      author: row.author,
      importance: row.importance,
      message: row.message,
      createdAt: new Date(row.createdAt),
      lastReadAt: new Date(row.lastReadAt),
    }));
  }

  public async findRecent(chatId: string, limit: number): Promise<TMemoryResult> {
    const res = await this.queue.enqueue(async () => {
      const results = await this.db
        .select()
        .from(memoriesTable)
        .where(eq(memoriesTable.chatId, chatId))
        .orderBy(desc(memoriesTable.createdAt))
        .limit(limit);

      const parsed = z.array(SMemory).safeParse(results);

      if (!parsed.success) {
        this.logger.error("Failed to parse memory from DB");
        return undefined;
      }

      return parsed.data;
    });

    if (!res) {
      return {
        success: false,
        error: {
          operation: "read",
          error: "Failed to read memory",
        },
      };
    }

    return {
      success: true,
      data: res.map((row) => ({
        id: row.id,
        chatId: row.chatId,
        author: row.author,
        importance: row.importance,
        message: row.message,
        createdAt: new Date(row.createdAt),
        lastReadAt: new Date(row.lastReadAt),
      })),
    };
  }

  public async save(args: TSaveArgs): Promise<Omit<TMemory, "id"> | TMemoryError> {
    const now = Date.now();

    try {
      const res = await this.queue.enqueue(async () =>
        this.db
          .insert(memoriesTable)
          .values({
            chatId: args.chatId,
            author: args.author,
            importance: args.importance,
            message: args.message,
            createdAt: now,
            lastReadAt: now,
          })
          .returning()
          .get(),
      );

      if (!res) {
        return {
          operation: "write",
          error: "No memory was saved",
        };
      }

      const parsed = SMemory.safeParse(res);

      if (!parsed.success) {
        this.logger.error("Failed to parse saved memory result");
        return {
          operation: "write",
          error: parsed.error,
        };
      }

      return {
        chatId: parsed.data.chatId,
        author: parsed.data.author,
        importance: parsed.data.importance,
        message: parsed.data.message,
        createdAt: new Date(parsed.data.createdAt),
        lastReadAt: new Date(parsed.data.lastReadAt),
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
    try {
      const memoryId = Number(id);
      const res = await this.queue.enqueue(async () =>
        this.db.delete(memoriesTable).where(eq(memoriesTable.id, memoryId)).returning().get(),
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
        chatId: parsed.data.chatId,
        author: parsed.data.author,
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

export type TMemorySaveResult = Awaited<ReturnType<Memory["save"]>>;
