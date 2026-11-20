import type { TOption } from "@bellaclaw/shared";
import { and, asc, desc, eq, gt, inArray, lt } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { EConversationKind } from "./enums";
import { conversationsTable, memoriesTable } from "./schema";

// the assistant's handle or transaction, or the dashboard's read-only connection
type TReadHandle = Pick<BaseSQLiteDatabase<"async", unknown>, "select">;

export type TOwnedConversation = { revision: number; rewriteRevision: number };

// a conversation as the app's home lists it. title: a plain chat's, once written; createdAt: when
// a plain chat was created, epoch ms; lastMessage: its newest row the app shows
export type TListedConversation = TOwnedConversation & {
  conversationKey: string;
  kind: EConversationKind;
  title: TOption<string>;
  createdAt: TOption<number>;
  lastMessage: TOption<THistoryMessage>;
};

// after: the rows above the id, for an append; before: the rows below it, for an older page
export type THistoryCursor = { direction: "after" | "before"; id: number };

// createdAt: epoch ms; clientMessageId: the id the sending client gave an inbound message
export type THistoryMessage = {
  id: number;
  author: "user" | "assistant";
  kind: "message" | "display";
  channel: "signal" | "discord" | "app";
  text: string;
  createdAt: number;
  clientMessageId: TOption<string>;
};

// NOTE: the one ownership rule of a conversation, for the dashboard's reads and the assistant's
// sends, so the two cannot drift. A conversation belongs to an account when the registry lists it
// under the account's owner key. The account's Bella conversation belongs to it also before the
// registry lists it, which happens with its first row: until then it has no transcript.
// account: the account's Bella conversation and owner key, as Identity builds them. Returns the
// conversation's revisions, zero for one not listed yet; undefined for a conversation of another
// owner or one that does not exist, alike
export async function findOwnedConversation(
  db: TReadHandle,
  conversationKey: string,
  account: { conversationKey: string; ownerKey: string },
): Promise<TOption<TOwnedConversation>> {
  const row = await db
    .select({
      ownerKey: conversationsTable.ownerKey,
      revision: conversationsTable.revision,
      rewriteRevision: conversationsTable.rewriteRevision,
    })
    .from(conversationsTable)
    .where(eq(conversationsTable.conversationKey, conversationKey))
    .get();

  if (row === undefined) {
    if (conversationKey === account.conversationKey) {
      return { revision: 0, rewriteRevision: 0 };
    }

    return undefined;
  }

  if (row.ownerKey !== account.ownerKey) {
    return undefined;
  }

  return { revision: row.revision, rewriteRevision: row.rewriteRevision };
}

// The kind of a conversation the registry lists, Bella for one it does not list yet: a plain chat
// is listed from its creation. Check ownership first
export async function findConversationKind(
  db: TReadHandle,
  conversationKey: string,
): Promise<EConversationKind> {
  const row = await db
    .select({ kind: conversationsTable.kind })
    .from(conversationsTable)
    .where(eq(conversationsTable.conversationKey, conversationKey))
    .get();

  return row?.kind ?? EConversationKind.Bella;
}

// The account's conversations for the app's home: its Bella conversation first, then its plain
// chats, the latest active first (by their newest row, else their creation)
export async function listConversations(
  db: TReadHandle,
  account: { conversationKey: string; ownerKey: string },
): Promise<TListedConversation[]> {
  const bella = await findOwnedConversation(db, account.conversationKey, account);

  if (bella === undefined) {
    throw new Error("The account's Bella conversation belongs to another owner");
  }

  const rows = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.ownerKey, account.ownerKey),
        eq(conversationsTable.kind, EConversationKind.Plain),
      ),
    );
  const plain: TListedConversation[] = [];

  for (const row of rows) {
    const [lastMessage] = await listHistory(db, row.conversationKey, undefined, 1);
    plain.push({
      conversationKey: row.conversationKey,
      kind: row.kind,
      revision: row.revision,
      rewriteRevision: row.rewriteRevision,
      title: row.title ?? undefined,
      createdAt: row.createdAt?.getTime(),
      lastMessage,
    });
  }

  const activeAt = (chat: TListedConversation) =>
    chat.lastMessage?.createdAt ?? chat.createdAt ?? 0;
  const [bellaLast] = await listHistory(db, account.conversationKey, undefined, 1);

  return [
    {
      conversationKey: account.conversationKey,
      kind: EConversationKind.Bella,
      ...bella,
      title: undefined,
      createdAt: undefined,
      lastMessage: bellaLast,
    },
    ...plain.sort((left, right) => activeAt(right) - activeAt(left)),
  ];
}

// What the app shows of a conversation: its user and assistant messages and display rows, never
// tool rows, oldest first. Without a cursor, the newest rows. Check ownership first
export async function listHistory(
  db: TReadHandle,
  conversationKey: string,
  cursor: TOption<THistoryCursor>,
  limit: number,
): Promise<THistoryMessage[]> {
  const conditions = [
    eq(memoriesTable.chatId, conversationKey),
    inArray(memoriesTable.kind, ["message", "display"]),
    inArray(memoriesTable.author, ["user", "assistant"]),
  ];
  let order = desc(memoriesTable.id);

  if (cursor?.direction === "after") {
    conditions.push(gt(memoriesTable.id, cursor.id));
    order = asc(memoriesTable.id);
  } else if (cursor?.direction === "before") {
    conditions.push(lt(memoriesTable.id, cursor.id));
  }

  const rows = await db
    .select({
      id: memoriesTable.id,
      author: memoriesTable.author,
      kind: memoriesTable.kind,
      channel: memoriesTable.channel,
      message: memoriesTable.message,
      createdAt: memoriesTable.createdAt,
      clientMessageId: memoriesTable.clientMessageId,
    })
    .from(memoriesTable)
    .where(and(...conditions))
    .orderBy(order)
    .limit(limit);
  const messages: THistoryMessage[] = [];

  for (const row of rows) {
    // the query selects only these; the checks narrow the columns' types
    if (
      (row.author === "user" || row.author === "assistant") &&
      (row.kind === "message" || row.kind === "display")
    ) {
      messages.push({
        id: row.id,
        author: row.author,
        kind: row.kind,
        channel: row.channel,
        text: row.message,
        createdAt: row.createdAt?.getTime(),
        clientMessageId: row.clientMessageId ?? undefined,
      });
    }
  }

  return messages.sort((left, right) => left.id - right.id);
}
