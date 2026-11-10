import { createLogger, type TLogger } from "@bellaclaw/shared";
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
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
  SPreparedFact,
  type TFact,
  type TFactCommitArgs,
  type TFactCommitResult,
  type TFactDistillationState,
  type TFactSearchResult,
  type TFactWindow,
  type TLiveFactWindow,
  type TPreparedFact,
} from "./types";

const FACT_WINDOW_SIZE = 6;
const FACT_CONTEXT_SIZE = 6;
// NOTE: both cutoffs are tuned for EmbeddingGemma 2 with its task prefixes, using Polish queries on
// English and Polish facts. Its distances sit in a narrow band, so a different model or prefix
// needs new values
const MAX_FACT_COSINE_DISTANCE = 0.31;
// NOTE: every test contradiction was within 0.22; the extra room keeps recall, and the model still
// decides which candidates are really superseded
const MAX_SUPERSESSION_COSINE_DISTANCE = 0.24;
const SUPERSESSION_CANDIDATE_LIMIT = 10;
const SQueryEmbedding = z.array(z.number()).length(EMBEDDING_DIMENSIONS);

type TFactTransaction = Parameters<Parameters<LibSQLDatabase["transaction"]>[0]>[0];

// Runs inside the caller's queued transaction: inserts one live fact and retires the facts it
// supersedes, failing the whole transaction when any of them is no longer a same-chat live fact.
async function insertFact(
  tx: TFactTransaction,
  chatId: string,
  fact: TPreparedFact,
  createdAt: Date,
): Promise<TFact> {
  const inserted = await tx
    .insert(factsTable)
    .values({
      chatId,
      text: fact.text,
      embedding: fact.embedding,
      createdAt,
      supersededBy: null,
      forgottenAt: null,
      sourceMessageId: fact.sourceMessageId,
    })
    .returning()
    .get();

  if (fact.supersedesFactIds.length > 0) {
    const result = await tx
      .update(factsTable)
      .set({ supersededBy: inserted.id })
      .where(
        and(
          eq(factsTable.chatId, chatId),
          inArray(factsTable.id, fact.supersedesFactIds),
          isNull(factsTable.supersededBy),
          isNull(factsTable.forgottenAt),
        ),
      );

    if (result.rowsAffected !== fact.supersedesFactIds.length) {
      throw new Error("Failed to supersede every prepared same-chat live fact");
    }
  }

  return inserted;
}

export class Memory {
  private static _instance: Memory;
  private database = DatabaseConnector.instance;
  private logger: TLogger = createLogger("MEMORY");

  private constructor() {}

  public static get instance() {
    if (!Memory._instance) {
      Memory._instance = new Memory();
    }
    return Memory._instance;
  }

  public async loadLiveFactWindow(chatId: string): Promise<TLiveFactWindow> {
    return this.database.run(async (db) => {
      const state = await this.readLiveState(db, chatId);

      return {
        state,
        ...(await this.readTranscriptWindow(db, chatId, state.lastProcessedMessageId)),
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
    return this.database.run(async (db) =>
      db.transaction(async (tx) => {
        const result = await tx
          .update(factsTable)
          .set({ forgottenAt: new Date() })
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

  public async rememberFact(
    chatId: string,
    text: string,
    sourceMessage: string,
    embedding: number[],
    supersedesFactIds: number[],
  ): Promise<TFact> {
    return this.database.run(async (db) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(factsTable)
          .where(
            and(
              eq(factsTable.chatId, chatId),
              eq(factsTable.text, text),
              isNull(factsTable.supersededBy),
              isNull(factsTable.forgottenAt),
            ),
          )
          .get();
        if (existing !== undefined) {
          return existing;
        }

        const source = await tx
          .select({ id: memoriesTable.id })
          .from(memoriesTable)
          .where(
            and(
              eq(memoriesTable.chatId, chatId),
              eq(memoriesTable.author, ERole.User),
              eq(memoriesTable.message, sourceMessage),
            ),
          )
          .orderBy(desc(memoriesTable.id))
          .limit(1)
          .get();
        if (source === undefined) {
          throw new Error("A remembered fact requires its exact same-chat user transcript source");
        }

        const prepared = SPreparedFact.safeParse({
          text,
          embedding,
          sourceMessageId: source.id,
          supersedesFactIds,
        });
        if (!prepared.success) {
          throw new Error("Failed to validate remembered fact");
        }

        return insertFact(tx, chatId, prepared.data, new Date());
      }),
    );
  }

  private async readLiveState(db: LibSQLDatabase, chatId: string): Promise<TFactDistillationState> {
    const row = await db
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

    return row;
  }

  private async readTranscriptWindow(
    db: LibSQLDatabase,
    chatId: string,
    lastProcessedMessageId: number,
  ): Promise<TFactWindow> {
    const contextRows = await db
      .select()
      .from(memoriesTable)
      .where(
        and(
          eq(memoriesTable.chatId, chatId),
          eq(memoriesTable.kind, "message"),
          lte(memoriesTable.id, lastProcessedMessageId),
        ),
      )
      .orderBy(desc(memoriesTable.id))
      .limit(FACT_CONTEXT_SIZE);
    const messageRows = await db
      .select()
      .from(memoriesTable)
      .where(
        and(
          eq(memoriesTable.chatId, chatId),
          eq(memoriesTable.kind, "message"),
          gt(memoriesTable.id, lastProcessedMessageId),
        ),
      )
      .orderBy(asc(memoriesTable.id))
      .limit(FACT_WINDOW_SIZE);

    contextRows.reverse();

    return {
      context: contextRows,
      messages: messageRows,
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

    return this.database.run(async (db) => {
      const distance = sql<number>`vector_distance_cos(${factsTable.embedding}, ${queryEmbedding})`;
      const rows = await db
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

      // NOTE: the cutoff is applied here rather than in SQL so a miss can report how close it got;
      // taking the nearest `limit` rows first is equivalent because the filter is on that ordering
      const within = rows.filter((fact) => fact.distance <= maximumDistance);

      if (within.length === 0 && rows.length > 0) {
        const closest = rows[0];
        this.logger.info(
          `findFactsByDistance: no fact within ${maximumDistance}, closest was ${closest?.distance.toFixed(4)} of ${rows.length} live facts`,
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

    return this.database.run(async (db) =>
      db.transaction(async (tx) => {
        const now = new Date();
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
          insertedFacts.push(await insertFact(tx, args.chatId, preparedFact, now));
        }

        return {
          committed: true,
          facts: insertedFacts,
        };
      }),
    );
  }
}
