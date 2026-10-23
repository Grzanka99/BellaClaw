import { AsyncQueue, createLogger, logger } from "@bellaclaw/shared";
import { asc, eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { DatabaseConnector } from "../src/services/database";
import { factsTable } from "../src/services/database/schema";
import { EmbeddingClient } from "../src/services/embedding";

export class FactEmbeddingRebuilder {
  private queue = new AsyncQueue();
  private logger = createLogger("EMBEDDING_REBUILD");

  public constructor(
    private db: LibSQLDatabase = DatabaseConnector.instance.database,
    private embedding: Pick<EmbeddingClient, "embed"> = EmbeddingClient.instance,
  ) {}

  public async rebuild(): Promise<number> {
    const facts = await this.queue.enqueue(async () =>
      this.db
        .select({ id: factsTable.id, text: factsTable.text })
        .from(factsTable)
        .orderBy(asc(factsTable.id)),
    );
    if (facts.length === 0) {
      return 0;
    }
    const prepared: { id: number; embedding: number[] }[] = [];

    for (const fact of facts) {
      const embedding = await this.embedding.embed(fact.text);
      if (embedding === undefined) {
        throw new Error(`Failed to embed fact ${fact.id}; no embeddings were changed`);
      }
      prepared.push({ id: fact.id, embedding });
      if (prepared.length % 10 === 0 || prepared.length === facts.length) {
        this.logger.info(`Prepared ${prepared.length}/${facts.length} fact embeddings`);
      }
    }

    await this.queue.enqueue(async () =>
      this.db.transaction(async (tx) => {
        for (const fact of prepared) {
          await tx
            .update(factsTable)
            .set({ embedding: fact.embedding })
            .where(eq(factsTable.id, fact.id));
        }
      }),
    );

    return facts.length;
  }
}

if (import.meta.main) {
  try {
    const model = EmbeddingClient.instance.model;
    logger.info(`Rebuilding fact embeddings using ${model}; the assistant must be stopped`);
    const count = await new FactEmbeddingRebuilder().rebuild();
    logger.info(`Rebuilt ${count} fact embeddings using ${model}`);
  } catch (error) {
    logger.error(String(error));
    process.exitCode = 1;
  }
}
