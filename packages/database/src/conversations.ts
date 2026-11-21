import type { TOption } from "@bellaclaw/shared";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { EConversationKind } from "./enums";
import { appMediaTable, conversationsTable, memoriesTable } from "./schema";

// the assistant's handle or transaction, or the gateway's read-only connection
type TReadHandle = Pick<BaseSQLiteDatabase<"async", unknown>, "select">;

// the text the assistant stores for each image of a user message, appended to what the user typed
export const IMAGE_MARKER = "[Image]";

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

// an image of a history row. mediaId: it downloads from the conversation's media route by this
// id. An image the conversation no longer keeps, and every image that came through Signal or
// Discord, is a placeholder without one
export type THistoryImage = {
  mediaId: TOption<string>;
  mimeType: string;
};

// a tool call of the turn a reply answers. tool: the tool's name; label: the tool's; detail: the
// argument a person recognises, such as a search's query, empty when none; startedAt: epoch ms
export type THistoryStep = {
  tool: string;
  label: string;
  detail: string;
  startedAt: number;
  durationMs: number;
  failed: boolean;
};

// text: of a user message with images, what the user typed, without the stored image markers;
// createdAt: epoch ms; clientMessageId: the id the sending client gave an inbound message;
// images: those of a user message, in order, none when it has no image; steps: the tool calls of
// a reply's turn, by start, none when the turn used no tools; scheduled: a delivery of a scheduled
// job, such as a reminder or an automation's output; listFinished: on a finished list's card only,
// the list's name and its item count
export type THistoryMessage = {
  id: number;
  author: "user" | "assistant";
  kind: "message" | "display";
  channel: "signal" | "discord" | "app";
  text: string;
  createdAt: number;
  clientMessageId: TOption<string>;
  images: TOption<THistoryImage[]>;
  steps: TOption<THistoryStep[]>;
  scheduled: boolean;
  listFinished: TOption<{ name: string; total: number }>;
};

// NOTE: a user message's attachment references as the assistant stores them, as much of them as
// history needs
const SStoredAttachments = z.array(
  z.object({ id: z.string(), mimeType: z.string(), channel: z.string() }),
);

// NOTE: a finished list's card as the assistant stores it
const SStoredListFinished = z.object({ name: z.string(), total: z.number().int() });

// NOTE: a reply's steps as the assistant stores them
const SStoredSteps = z.array(
  z.object({
    tool: z.string(),
    label: z.string(),
    detail: z.string(),
    startedAt: z.number().int(),
    durationMs: z.number().int(),
    failed: z.boolean(),
  }),
);

// NOTE: the one ownership rule of a conversation, for the gateway's reads and the assistant's
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

// The kind of a conversation the account owns, by findOwnedConversation's rule in one query;
// undefined for one of another owner or one that does not exist, alike
export async function findOwnedConversationKind(
  db: TReadHandle,
  conversationKey: string,
  account: { conversationKey: string; ownerKey: string },
): Promise<TOption<EConversationKind>> {
  const row = await db
    .select({ ownerKey: conversationsTable.ownerKey, kind: conversationsTable.kind })
    .from(conversationsTable)
    .where(eq(conversationsTable.conversationKey, conversationKey))
    .get();

  if (row === undefined) {
    if (conversationKey === account.conversationKey) {
      return EConversationKind.Bella;
    }

    return undefined;
  }

  if (row.ownerKey !== account.ownerKey) {
    return undefined;
  }

  return row.kind;
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
      attachments: memoriesTable.attachments,
      steps: memoriesTable.steps,
      listFinished: memoriesTable.listFinished,
      createdAt: memoriesTable.createdAt,
      clientMessageId: memoriesTable.clientMessageId,
      // NOTE: the scheduler saves a delivery with the model scheduled-delivery and a model text
      // prefixed [CRON REMINDER name] or [CRON TASK name]; the other scheduled-delivery row is the reply
      // to a turn a restart interrupted
      scheduled: sql<number>`coalesce(json_extract(${memoriesTable.modelMessage}, '$.model') = 'scheduled-delivery' and json_extract(${memoriesTable.modelMessage}, '$.content[0].text') like '[CRON %', 0)`,
    })
    .from(memoriesTable)
    .where(and(...conditions))
    .orderBy(order)
    .limit(limit);
  const imagesById = new Map<number, z.infer<typeof SStoredAttachments>>();

  for (const row of rows) {
    if (row.attachments === null) {
      continue;
    }

    const stored = SStoredAttachments.safeParse(JSON.parse(row.attachments));

    if (stored.success && stored.data.length > 0) {
      imagesById.set(row.id, stored.data);
    }
  }

  // an app image downloads while the App channel keeps its file
  const appIds = [...imagesById.values()]
    .flat()
    .filter((ref) => ref.channel === "app")
    .map((ref) => ref.id);
  const kept = new Set<string>();

  if (appIds.length > 0) {
    const media = await db
      .select({ id: appMediaTable.id })
      .from(appMediaTable)
      .where(inArray(appMediaTable.id, appIds));

    for (const row of media) {
      kept.add(row.id);
    }
  }

  const messages: THistoryMessage[] = [];

  for (const row of rows) {
    // the query selects only these; the checks narrow the columns' types
    if (
      (row.author === "user" || row.author === "assistant") &&
      (row.kind === "message" || row.kind === "display")
    ) {
      const refs = imagesById.get(row.id);
      let text = row.message;
      let images: TOption<THistoryImage[]>;

      if (refs !== undefined) {
        for (const _ of refs) {
          if (text.endsWith(IMAGE_MARKER)) {
            text = text.slice(0, -IMAGE_MARKER.length).trimEnd();
          }
        }

        images = refs.map((ref) => {
          const image: THistoryImage = { mediaId: undefined, mimeType: ref.mimeType };

          if (kept.has(ref.id)) {
            image.mediaId = ref.id;
          }

          return image;
        });
      }

      let steps: TOption<THistoryStep[]>;

      if (row.steps !== null) {
        const stored = SStoredSteps.safeParse(JSON.parse(row.steps));

        if (stored.success) {
          steps = stored.data;
        }
      }

      let listFinished: TOption<{ name: string; total: number }>;

      if (row.listFinished !== null) {
        const stored = SStoredListFinished.safeParse(JSON.parse(row.listFinished));

        if (stored.success) {
          listFinished = stored.data;
        }
      }

      messages.push({
        id: row.id,
        author: row.author,
        kind: row.kind,
        channel: row.channel,
        text,
        createdAt: row.createdAt?.getTime(),
        clientMessageId: row.clientMessageId ?? undefined,
        images,
        steps,
        scheduled: row.scheduled === 1,
        listFinished,
      });
    }
  }

  return messages.sort((left, right) => left.id - right.id);
}
