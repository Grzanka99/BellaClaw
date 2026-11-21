import {
  factsTable,
  findOwnedConversation,
  listConversations,
  listHistory,
  memoriesTable,
  type THistoryCursor,
  type THistoryMessage,
  type TListedConversation,
  type TOwnedConversation,
} from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import type { TChatMessage } from "./api-types";
import type { TFact } from "./fact-graph";

export type TChatReader = {
  // the conversation's user and assistant messages with an id below `before`, newest first
  listMessages(
    conversationKey: string,
    before: TOption<number>,
    limit: number,
  ): Promise<TChatMessage[]>;
  // the owner's live facts
  listFacts(ownerKey: string): Promise<TFact[]>;
  // the conversation's revisions when it belongs to the account, by the rule the assistant
  // checks too. account: the keys the assistant names for the account
  findConversation(
    conversationKey: string,
    account: { conversationKey: string; ownerKey: string },
  ): Promise<TOption<TOwnedConversation>>;
  // the account's conversations for the app's home: its Bella conversation, then its plain chats
  listConversations(account: {
    conversationKey: string;
    ownerKey: string;
  }): Promise<TListedConversation[]>;
  // what the app shows of a conversation, oldest first
  listHistory(
    conversationKey: string,
    cursor: TOption<THistoryCursor>,
    limit: number,
  ): Promise<THistoryMessage[]>;
};

// NOTE: the assistant's database. The gateway only reads it; writes go through the internal API.
export function createChatReader(url: string, authToken: string): TChatReader {
  const db = drizzle({ connection: { url, authToken } });

  return {
    async listMessages(conversationKey, before, limit) {
      const conditions = [
        eq(memoriesTable.chatId, conversationKey),
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

    findConversation: (conversationKey, account) =>
      findOwnedConversation(db, conversationKey, account),

    listConversations: (account) => listConversations(db, account),

    listHistory: (conversationKey, cursor, limit) =>
      listHistory(db, conversationKey, cursor, limit),

    async listFacts(ownerKey) {
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
            eq(factsTable.chatId, ownerKey),
            isNull(factsTable.supersededBy),
            isNull(factsTable.forgottenAt),
          ),
        )
        .orderBy(factsTable.id);

      return rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() }));
    },
  };
}
