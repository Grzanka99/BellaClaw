import { factsTable, memoriesTable } from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import type { TChatMessage } from "./api-types";
import type { TFact } from "./fact-graph";

export type TChatReader = {
  // the chat's user and assistant messages with an id below `before`, newest first
  listMessages(chatId: string, before: TOption<number>, limit: number): Promise<TChatMessage[]>;
  // the chat's live facts
  listFacts(chatId: string): Promise<TFact[]>;
};

// NOTE: the assistant's database. The dashboard only reads it; writes go through the internal API.
export function createChatReader(url: string, authToken: string): TChatReader {
  const db = drizzle({ connection: { url, authToken } });

  return {
    async listMessages(chatId, before, limit) {
      const conditions = [
        eq(memoriesTable.chatId, chatId),
        eq(memoriesTable.kind, "message"),
        inArray(memoriesTable.author, ["user", "assistant"]),
      ];

      if (before !== undefined) {
        conditions.push(lt(memoriesTable.id, before));
      }

      const rows = await db
        .select({
          id: memoriesTable.id,
          author: memoriesTable.author,
          message: memoriesTable.message,
          createdAt: memoriesTable.createdAt,
        })
        .from(memoriesTable)
        .where(and(...conditions))
        .orderBy(desc(memoriesTable.id))
        .limit(limit);
      const messages: TChatMessage[] = [];

      for (const row of rows) {
        // the query selects only these authors; the check narrows the column's type
        if (row.author === "user" || row.author === "assistant") {
          messages.push({
            id: row.id,
            author: row.author,
            text: row.message,
            createdAt: row.createdAt.getTime(),
          });
        }
      }

      return messages;
    },

    async listFacts(chatId) {
      const rows = await db
        .select({
          id: factsTable.id,
          text: factsTable.text,
          createdAt: factsTable.createdAt,
          embedding: factsTable.embedding,
        })
        .from(factsTable)
        .where(
          and(
            eq(factsTable.chatId, chatId),
            isNull(factsTable.supersededBy),
            isNull(factsTable.forgottenAt),
          ),
        )
        .orderBy(factsTable.id);

      return rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() }));
    },
  };
}
