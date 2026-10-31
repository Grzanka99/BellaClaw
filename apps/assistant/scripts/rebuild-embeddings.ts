import { AsyncQueue, createLogger, logger } from "@bellaclaw/shared";
import { asc, eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { DatabaseConnector } from "../src/services/database";
import { factsTable } from "../src/services/database/schema";
import { EmbeddingClient } from "../src/services/embedding";

const BATCH_SIZE = 32;

export class FactEmbeddingRebuilder {
  private queue = new AsyncQueue();
  private logger = createLogger("EMBEDDING_REBUILD");

  public constructor(
    private db: LibSQLDatabase = DatabaseConnector.instance.database,
    private embedding: Pick<EmbeddingClient, "embedMany"> = EmbeddingClient.instance,
  ) {}

  // NOTE: every fact is re-embedded before anything is written, so a failure leaves the previous
  // vectors untouched
  public async rebuild(): Promise<number> {
    const facts = await this.queue.enqueue(async () =>
      this.db
        .select({ id: factsTable.id, text: factsTable.text })
        .from(factsTable)
        .orderBy(asc(factsTable.id)),
    );
    const embeddings: number[][] = [];
    const startedAt = performance.now();

    for (let start = 0; start < facts.length; start += BATCH_SIZE) {
      const batch = facts.slice(start, start + BATCH_SIZE);
      const result = await this.embedding.embedMany(batch.map((fact) => fact.text));
      if (result === undefined) {
        throw new Error(`Failed to embed facts ${start + 1}-${start + batch.length}`);
      }

      embeddings.push(...result);
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      const factsPerSecond = embeddings.length / elapsedSeconds;
      const remainingSeconds = (facts.length - embeddings.length) / factsPerSecond;
      this.logger.info(
        `Embedded ${embeddings.length}/${facts.length} facts, ${factsPerSecond.toFixed(1)} facts/s, ~${Math.ceil(remainingSeconds)}s left`,
      );
    }

    await this.queue.enqueue(async () =>
      this.db.transaction(async (tx) => {
        for (const [index, fact] of facts.entries()) {
          const embedding = embeddings[index];
          if (embedding === undefined) {
            throw new Error(`Missing embedding for fact ${fact.id}`);
          }

          await tx.update(factsTable).set({ embedding }).where(eq(factsTable.id, fact.id));
        }
      }),
    );

    return facts.length;
  }
}

if (import.meta.main) {
  const client = EmbeddingClient.instance;

  logger.info(`Rebuilding fact embeddings with ${client.model}`);
  if (await client.ensureModel()) {
    try {
      const count = await new FactEmbeddingRebuilder().rebuild();
      logger.info(`Rebuilt ${count} fact embeddings with ${client.model}`);
    } catch (error) {
      logger.error(`Rebuild failed, stored embeddings unchanged: ${String(error)}`);
      process.exitCode = 1;
    }
  } else {
    logger.error(`Embedding model ${client.model} is not available`);
    process.exitCode = 1;
  }
}
