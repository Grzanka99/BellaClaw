import { AsyncQueue, createLogger, type TLogger } from "@bellaclaw/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { ERole } from "../ai/types";
import { DatabaseConnector } from "../database";
import {
  EMBEDDING_DIMENSIONS,
  factDistillationStateTable,
  factsTable,
  memoriesTable,
} from "../database/schema";
import {
  SFact,
  SFactDistillationState,
  SFactSearchResult,
  SMemory,
  SPreparedFact,
  type TFact,
  type TFactCommitArgs,
  type TFactCommitResult,
  type TFactDistillationState,
  type TFactSearchResult,
  type TFactWindow,
  type TLiveFactWindow,
  type TMemory,
  type TSaveArgs,
} from "./types";

const FACT_WINDOW_SIZE = 6;
const FACT_CONTEXT_SIZE = 6;
const MAX_FACT_COSINE_DISTANCE = 0.7;
// NOTE: contradictions are semantically distant, not near-duplicates: two timezone values
// measured 0.45 apart, so a restatement-sized window never offered them as candidates
const MAX_SUPERSESSION_COSINE_DISTANCE = 0.5;
const SUPERSESSION_CANDIDATE_LIMIT = 10;
const SQueryEmbedding = z.array(z.number()).length(EMBEDDING_DIMENSIONS);
const priorMemoriesTable = alias(memoriesTable, "priorMemories");

type TMemoryError = {
  operation: "write" | "read" | "update";
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

  public async findRecent(chatId: string, limit: number): Promise<TMemoryResult> {
    const res = await this.queue.enqueue(async () => {
      const results = await this.db
        .select()
        .from(memoriesTable)
        .where(
          and(
            eq(memoriesTable.chatId, chatId),
            notExists(
              this.db
                .select({ id: factsTable.id })
                .from(factsTable)
                .where(
                  and(
                    eq(factsTable.chatId, chatId),
                    isNotNull(factsTable.forgottenAt),
                    or(
                      eq(factsTable.sourceMessageId, memoriesTable.id),
                      and(
                        eq(memoriesTable.author, ERole.Assistant),
                        lt(factsTable.sourceMessageId, memoriesTable.id),
                        notExists(
                          this.db
                            .select({ id: priorMemoriesTable.id })
                            .from(priorMemoriesTable)
                            .where(
                              and(
                                eq(priorMemoriesTable.chatId, chatId),
                                gt(priorMemoriesTable.id, factsTable.sourceMessageId),
                                lt(priorMemoriesTable.id, memoriesTable.id),
                              ),
                            ),
                        ),
                      ),
                    ),
                  ),
                ),
            ),
          ),
        )
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
      data: res,
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
        createdAt: parsed.data.createdAt,
        lastReadAt: parsed.data.lastReadAt,
      };
    } catch (error) {
      this.logger.error(`Something went wrong while saving memory: ${String(error)}`);
      return {
        operation: "write",
        error,
      };
    }
  }

  public async findChatIds(): Promise<string[]> {
    return this.queue.enqueue(async () => {
      const rows = await this.db
        .selectDistinct({ chatId: memoriesTable.chatId })
        .from(memoriesTable)
        .orderBy(asc(memoriesTable.chatId));
      const parsed = z.array(z.object({ chatId: z.string() })).safeParse(rows);

      if (!parsed.success) {
        throw new Error("Failed to parse memory chat IDs");
      }

      return parsed.data.map((row) => row.chatId);
    });
  }

  public async loadLiveFactWindow(chatId: string): Promise<TLiveFactWindow> {
    return this.queue.enqueue(async () => {
      const state = await this.readLiveState(chatId);

      return {
        state,
        ...(await this.readTranscriptWindow(chatId, state.lastProcessedMessageId)),
      };
    });
  }

  public async findLiveFactCandidates(
    chatId: string,
    embedding: number[],
  ): Promise<TFactSearchResult[]> {
    return this.findFactsByDistance(
      chatId,
      embedding,
      SUPERSESSION_CANDIDATE_LIMIT,
      MAX_SUPERSESSION_COSINE_DISTANCE,
    );
  }

  public async searchFacts(
    chatId: string,
    embedding: number[],
    limit: number,
  ): Promise<TFactSearchResult[]> {
    return this.findFactsByDistance(chatId, embedding, limit, MAX_FACT_COSINE_DISTANCE);
  }

  public async forgetFacts(chatId: string, factIds: number[]): Promise<number[]> {
    return this.queue.enqueue(async () =>
      this.db.transaction(async (tx) => {
        const result = await tx
          .update(factsTable)
          .set({ forgottenAt: Date.now() })
          .where(
            and(
              eq(factsTable.chatId, chatId),
              inArray(factsTable.id, factIds),
              isNull(factsTable.supersededBy),
              isNull(factsTable.forgottenAt),
            ),
          );

        if (result.rowsAffected !== factIds.length) {
          throw new Error("Every fact ID must identify a same-chat live fact");
        }

        return factIds;
      }),
    );
  }

  // readLiveState and readTranscriptWindow are queue-free by design: they run
  // inside an existing queue.enqueue() callback, and enqueuing again from there would deadlock.
  private async readLiveState(chatId: string): Promise<TFactDistillationState> {
    const row = await this.db
      .select()
      .from(factDistillationStateTable)
      .where(eq(factDistillationStateTable.chatId, chatId))
      .get();

    if (row === undefined) {
      return {
        chatId,
        lastProcessedMessageId: 0,
        updatedAt: undefined,
      };
    }

    const parsed = SFactDistillationState.safeParse(row);

    if (!parsed.success) {
      throw new Error("Failed to parse fact distillation state");
    }

    return parsed.data;
  }

  private async readTranscriptWindow(
    chatId: string,
    lastProcessedMessageId: number,
  ): Promise<TFactWindow> {
    const contextRows = await this.db
      .select()
      .from(memoriesTable)
      .where(
        and(
          eq(memoriesTable.chatId, chatId),
          lte(memoriesTable.id, lastProcessedMessageId),
          notExists(
            this.db
              .select({ id: factsTable.id })
              .from(factsTable)
              .where(
                and(
                  eq(factsTable.chatId, chatId),
                  isNotNull(factsTable.forgottenAt),
                  or(
                    eq(factsTable.sourceMessageId, memoriesTable.id),
                    and(
                      eq(memoriesTable.author, ERole.Assistant),
                      lt(factsTable.sourceMessageId, memoriesTable.id),
                      notExists(
                        this.db
                          .select({ id: priorMemoriesTable.id })
                          .from(priorMemoriesTable)
                          .where(
                            and(
                              eq(priorMemoriesTable.chatId, chatId),
                              gt(priorMemoriesTable.id, factsTable.sourceMessageId),
                              lt(priorMemoriesTable.id, memoriesTable.id),
                            ),
                          ),
                      ),
                    ),
                  ),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(memoriesTable.id))
      .limit(FACT_CONTEXT_SIZE);
    const messageRows = await this.db
      .select()
      .from(memoriesTable)
      .where(and(eq(memoriesTable.chatId, chatId), gt(memoriesTable.id, lastProcessedMessageId)))
      .orderBy(asc(memoriesTable.id))
      .limit(FACT_WINDOW_SIZE);
    const parsedContext = z.array(SMemory).safeParse(contextRows);
    const parsedMessages = z.array(SMemory).safeParse(messageRows);

    if (!parsedContext.success || !parsedMessages.success) {
      throw new Error("Failed to parse fact transcript window");
    }

    parsedContext.data.reverse();

    return {
      context: parsedContext.data,
      messages: parsedMessages.data,
    };
  }

  private async findFactsByDistance(
    chatId: string,
    embedding: number[],
    limit: number,
    maximumDistance: number,
  ): Promise<TFactSearchResult[]> {
    const parsedEmbedding = SQueryEmbedding.safeParse(embedding);

    if (!parsedEmbedding.success) {
      throw new Error(`Fact search embeddings must have ${EMBEDDING_DIMENSIONS} dimensions`);
    }

    const queryEmbedding = new Float32Array(parsedEmbedding.data).buffer;

    return this.queue.enqueue(async () => {
      const distance = sql<number>`vector_distance_cos(${factsTable.embedding}, ${queryEmbedding})`;
      const rows = await this.db
        .select({
          id: factsTable.id,
          text: factsTable.text,
          createdAt: factsTable.createdAt,
          sourceMessageId: factsTable.sourceMessageId,
          distance,
        })
        .from(factsTable)
        .where(
          and(
            eq(factsTable.chatId, chatId),
            isNull(factsTable.supersededBy),
            isNull(factsTable.forgottenAt),
          ),
        )
        .orderBy(asc(distance))
        .limit(limit);
      const parsed = z.array(SFactSearchResult).safeParse(rows);

      if (!parsed.success) {
        throw new Error("Failed to parse fact search results");
      }

      // NOTE: the cutoff is applied here rather than in SQL so a miss can report how close it got;
      // taking the nearest `limit` rows first is equivalent because the filter is on that ordering
      const within = parsed.data.filter((fact) => fact.distance <= maximumDistance);

      if (within.length === 0 && parsed.data.length > 0) {
        const closest = parsed.data[0];
        this.logger.info(
          `findFactsByDistance: no fact within ${maximumDistance}, closest was ${closest?.distance.toFixed(4)} of ${parsed.data.length} live facts`,
        );
      }

      return within;
    });
  }

  public async commitLiveFactWindow(args: TFactCommitArgs): Promise<TFactCommitResult> {
    // NOTE: the drain loop terminates only because every commit advances the checkpoint
    if (args.lastProcessedMessageId <= args.expectedLastProcessedMessageId) {
      throw new Error("A committed fact window must advance the checkpoint");
    }

    const parsedFacts = z.array(SPreparedFact).safeParse(args.facts);

    if (!parsedFacts.success) {
      throw new Error("Failed to validate prepared facts");
    }

    const supersededFactIds = new Set<number>();
    for (const fact of parsedFacts.data) {
      for (const factId of fact.supersedesFactIds) {
        if (supersededFactIds.has(factId)) {
          throw new Error(`Fact ${factId} cannot be superseded more than once in one window`);
        }

        supersededFactIds.add(factId);
      }
    }

    return this.queue.enqueue(async () =>
      this.db.transaction(async (tx) => {
        const now = Date.now();
        const sourceMessageIds = [...new Set(parsedFacts.data.map((fact) => fact.sourceMessageId))];

        if (sourceMessageIds.length > 0) {
          const sourceRows = await tx
            .select({ id: memoriesTable.id })
            .from(memoriesTable)
            .where(
              and(
                eq(memoriesTable.chatId, args.chatId),
                eq(memoriesTable.author, ERole.User),
                gt(memoriesTable.id, args.expectedLastProcessedMessageId),
                lte(memoriesTable.id, args.lastProcessedMessageId),
                inArray(memoriesTable.id, sourceMessageIds),
              ),
            );

          if (sourceRows.length !== sourceMessageIds.length) {
            throw new Error("Every fact source must be a current-window user transcript row");
          }
        }

        const checkpointCursor = {
          lastProcessedMessageId: args.lastProcessedMessageId,
          updatedAt: now,
        };
        const updateResult = await tx
          .update(factDistillationStateTable)
          .set(checkpointCursor)
          .where(
            and(
              eq(factDistillationStateTable.chatId, args.chatId),
              eq(
                factDistillationStateTable.lastProcessedMessageId,
                args.expectedLastProcessedMessageId,
              ),
            ),
          );
        let checkpointUpdated = updateResult.rowsAffected === 1;

        if (!checkpointUpdated && args.expectedLastProcessedMessageId === 0) {
          const insertResult = await tx
            .insert(factDistillationStateTable)
            .values({ chatId: args.chatId, ...checkpointCursor })
            .onConflictDoNothing();
          checkpointUpdated = insertResult.rowsAffected === 1;
        }

        if (!checkpointUpdated) {
          return {
            committed: false,
            reason: "stale-checkpoint",
          };
        }

        const insertedFacts: TFact[] = [];
        for (const preparedFact of parsedFacts.data) {
          const inserted = await tx
            .insert(factsTable)
            .values({
              chatId: args.chatId,
              text: preparedFact.text,
              embedding: preparedFact.embedding,
              createdAt: now,
              supersededBy: null,
              sourceMessageId: preparedFact.sourceMessageId,
            })
            .returning()
            .get();
          const parsedInserted = SFact.safeParse(inserted);

          if (!parsedInserted.success) {
            throw new Error("Failed to parse inserted fact");
          }

          if (preparedFact.supersedesFactIds.length > 0) {
            const supersessionResult = await tx
              .update(factsTable)
              .set({ supersededBy: parsedInserted.data.id })
              .where(
                and(
                  eq(factsTable.chatId, args.chatId),
                  inArray(factsTable.id, preparedFact.supersedesFactIds),
                  isNull(factsTable.supersededBy),
                  isNull(factsTable.forgottenAt),
                ),
              );

            if (supersessionResult.rowsAffected !== preparedFact.supersedesFactIds.length) {
              throw new Error("Failed to supersede every prepared same-chat live fact");
            }
          }

          insertedFacts.push(parsedInserted.data);
        }

        return {
          committed: true,
          facts: insertedFacts,
        };
      }),
    );
  }
}
