import {
  conversationSummariesTable,
  conversationsTable,
  EConversationKind,
  findConversationKind,
  memoriesTable,
  type TSelectMemory,
} from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import {
  type AssistantMessage,
  contentText,
  type Message,
  type UserMessage,
} from "@earendil-works/pi-ai";
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
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { emptyUsage } from "../ai/llm";
import { ERole } from "../ai/types";
import { DatabaseConnector, type TDatabaseHandle } from "../database";
import type { TDisplay, TFusedSummary } from "../events/catalog";
import { type EMessagePlatform, SAttachmentRef, type TAttachmentRef } from "../messaging/types";
import { SConversationMessage, type TConversation } from "./types";

// NOTE: platform files of the images older than this many compactions are deleted
const KEPT_COMPACTIONS = 3;
const SAttachmentRefs = z.array(SAttachmentRef);

export class ConversationStore {
  private static _instance: TOption<ConversationStore>;
  private database = DatabaseConnector.instance;

  public static get instance(): ConversationStore {
    if (ConversationStore._instance === undefined) {
      ConversationStore._instance = new ConversationStore();
    }
    return ConversationStore._instance;
  }

  public saveUserMessage(
    db: TDatabaseHandle,
    chatId: string,
    channel: EMessagePlatform,
    author: ERole,
    message: string,
    createdAt: Date,
    clientMessageId: TOption<string>,
    attachments: TAttachmentRef[],
  ): Promise<TSelectMemory> {
    let stored: TOption<string>;

    if (attachments.length > 0) {
      stored = JSON.stringify(attachments);
    }

    return db
      .insert(memoriesTable)
      .values({ chatId, channel, author, message, createdAt, clientMessageId, attachments: stored })
      .returning()
      .get();
  }

  // Raises the conversation's revision, in the caller's transaction with the change, and lists a
  // conversation missing from the registry under its owner. A rewrite (any change but an append)
  // also moves rewriteRevision to the new revision, so a client synced below it reloads instead of
  // fetching by cursor
  public async raiseRevision(
    db: TDatabaseHandle,
    conversationKey: string,
    ownerKey: string,
    rewrite: boolean,
  ): Promise<{ revision: number; rewriteRevision: number }> {
    const raised = sql`${conversationsTable.revision} + 1`;
    let rewriteRevision = sql`${conversationsTable.rewriteRevision}`;
    let firstRewriteRevision = 0;

    if (rewrite) {
      rewriteRevision = raised;
      firstRewriteRevision = 1;
    }

    return db
      .insert(conversationsTable)
      .values({ conversationKey, ownerKey, revision: 1, rewriteRevision: firstRewriteRevision })
      .onConflictDoUpdate({
        target: conversationsTable.conversationKey,
        set: { revision: raised, rewriteRevision },
      })
      .returning({
        revision: conversationsTable.revision,
        rewriteRevision: conversationsTable.rewriteRevision,
      })
      .get();
  }

  // the conversations with transcript rows whose facts Memory distils: every one but plain chats
  public findChatIds(): Promise<string[]> {
    return this.database.run(async (db) => {
      const rows = await db
        .selectDistinct({ chatId: memoriesTable.chatId })
        .from(memoriesTable)
        .leftJoin(conversationsTable, eq(conversationsTable.conversationKey, memoriesTable.chatId))
        .where(
          or(isNull(conversationsTable.kind), ne(conversationsTable.kind, EConversationKind.Plain)),
        )
        .orderBy(asc(memoriesTable.chatId));
      return rows.map((row) => row.chatId);
    });
  }

  // Lists a new plain chat of the owner, or hands back the owner's plain chat with no transcript
  // row, so the owner has at most one empty chat. createdAt: epoch ms, of a new chat
  public async createPlain(
    db: TDatabaseHandle,
    conversationKey: string,
    ownerKey: string,
    createdAt: number,
  ): Promise<{ conversationKey: string; createdAt: number }> {
    const empty = await db
      .select({
        conversationKey: conversationsTable.conversationKey,
        createdAt: conversationsTable.createdAt,
      })
      .from(conversationsTable)
      .where(
        and(
          eq(conversationsTable.ownerKey, ownerKey),
          eq(conversationsTable.kind, EConversationKind.Plain),
          notExists(
            db
              .select({ id: memoriesTable.id })
              .from(memoriesTable)
              .where(eq(memoriesTable.chatId, conversationsTable.conversationKey)),
          ),
        ),
      )
      .limit(1)
      .get();

    if (empty !== undefined && empty.createdAt !== null) {
      return { conversationKey: empty.conversationKey, createdAt: empty.createdAt.getTime() };
    }

    await db.insert(conversationsTable).values({
      conversationKey,
      ownerKey,
      kind: EConversationKind.Plain,
      createdAt: new Date(createdAt),
    });
    return { conversationKey, createdAt };
  }

  // whether the registry lists the conversation; a plain chat is listed from its creation to its
  // deletion
  public listed(conversationKey: string): Promise<boolean> {
    return this.database.run(async (db) => {
      const row = await db
        .select({ conversationKey: conversationsTable.conversationKey })
        .from(conversationsTable)
        .where(eq(conversationsTable.conversationKey, conversationKey))
        .get();
      return row !== undefined;
    });
  }

  // The channel and text of one row of the chat, with the chat's kind; undefined when the chat has
  // no such row
  public findMessage(
    chatId: string,
    messageId: number,
  ): Promise<TOption<Pick<TSelectMemory, "channel" | "message"> & { kind: EConversationKind }>> {
    return this.database.run(async (db) => {
      const message = await db
        .select({ channel: memoriesTable.channel, message: memoriesTable.message })
        .from(memoriesTable)
        .where(and(eq(memoriesTable.id, messageId), eq(memoriesTable.chatId, chatId)))
        .get();

      if (message === undefined) {
        return undefined;
      }

      return { ...message, kind: await findConversationKind(db, chatId) };
    });
  }

  // A turn's exchange in an untitled plain chat, for its title: the turn's user message and the
  // reply that ended that turn. undefined when the chat is unlisted or titled already
  public findTitleExchange(
    conversationKey: string,
    userMessageId: number,
  ): Promise<TOption<{ message: string; reply: string }>> {
    return this.database.run(async (db) => {
      const conversation = await db
        .select({ title: conversationsTable.title })
        .from(conversationsTable)
        .where(eq(conversationsTable.conversationKey, conversationKey))
        .get();

      if (conversation === undefined || conversation.title !== null) {
        return undefined;
      }

      const message = await db
        .select({ message: memoriesTable.message })
        .from(memoriesTable)
        .where(and(eq(memoriesTable.id, userMessageId), eq(memoriesTable.chatId, conversationKey)))
        .get();
      const reply = await db
        .select({ message: memoriesTable.message })
        .from(memoriesTable)
        .where(
          and(
            eq(memoriesTable.chatId, conversationKey),
            eq(memoriesTable.author, ERole.Assistant),
            eq(memoriesTable.kind, "message"),
            gt(memoriesTable.id, userMessageId),
          ),
        )
        .orderBy(asc(memoriesTable.id))
        .limit(1)
        .get();

      // the turn.completed of a listed chat is stored with both rows, which go only with the chat
      if (message === undefined || reply === undefined) {
        throw new Error("Title exchange rows are missing");
      }

      return { message: message.message, reply: reply.message };
    });
  }

  // Writes a plain chat's title: false, writing nothing, when the chat is gone
  public async setTitle(
    db: TDatabaseHandle,
    conversationKey: string,
    title: string,
  ): Promise<boolean> {
    const updated = await db
      .update(conversationsTable)
      .set({ title })
      .where(eq(conversationsTable.conversationKey, conversationKey));
    return updated.rowsAffected === 1;
  }

  // Deletes a plain chat of the owner: its transcript rows, its summary and its registry entry.
  // Returns false, deleting nothing, for a conversation that is no plain chat of this owner
  public async deletePlain(
    db: TDatabaseHandle,
    conversationKey: string,
    ownerKey: string,
  ): Promise<boolean> {
    const deleted = await db
      .delete(conversationsTable)
      .where(
        and(
          eq(conversationsTable.conversationKey, conversationKey),
          eq(conversationsTable.ownerKey, ownerKey),
          eq(conversationsTable.kind, EConversationKind.Plain),
        ),
      )
      .returning({ conversationKey: conversationsTable.conversationKey });

    if (deleted.length === 0) {
      return false;
    }

    await db.delete(memoriesTable).where(eq(memoriesTable.chatId, conversationKey));
    await db
      .delete(conversationSummariesTable)
      .where(eq(conversationSummariesTable.chatId, conversationKey));
    return true;
  }

  // whether the chat still has transcript rows or a summary
  public holds(chatId: string): Promise<boolean> {
    return this.database.run(async (db) => {
      const row = await db
        .select({ id: memoriesTable.id })
        .from(memoriesTable)
        .where(eq(memoriesTable.chatId, chatId))
        .limit(1)
        .get();
      const summary = await db
        .select({ chatId: conversationSummariesTable.chatId })
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.chatId, chatId))
        .get();
      return row !== undefined || summary !== undefined;
    });
  }

  // The input of fusing a chat's summary with a conversation's before the chat's rows move there.
  // The mark is the higher of the two summaries' marks, the lowest at which no row of either is
  // both summarized and replayed. The state holds both summaries, the conversation's first, and
  // every replayable row of either at or below the mark that its own summary does not cover, in
  // id order. summaries: how many of the two exist
  public loadFusion(
    chatId: string,
    conversationKey: string,
  ): Promise<{ state: TConversation; summaries: number }> {
    return this.database.run(async (db) => {
      const kept = await db
        .select()
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.chatId, conversationKey))
        .get();
      const moved = await db
        .select()
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.chatId, chatId))
        .get();
      const summaries = [kept, moved].filter((summary) => summary !== undefined);
      const mark = Math.max(0, ...summaries.map((summary) => summary.summarizedThroughId));
      const rows = await db
        .select()
        .from(memoriesTable)
        .where(
          and(
            or(
              and(
                eq(memoriesTable.chatId, conversationKey),
                gt(memoriesTable.id, kept?.summarizedThroughId ?? 0),
              ),
              and(
                eq(memoriesTable.chatId, chatId),
                gt(memoriesTable.id, moved?.summarizedThroughId ?? 0),
              ),
            ),
            lte(memoriesTable.id, mark),
            isNotNull(memoriesTable.modelMessage),
          ),
        )
        .orderBy(asc(memoriesTable.id));
      const entries: TConversation["entries"] = [];
      for (const row of rows) {
        const parsed = SConversationMessage.safeParse(JSON.parse(row.modelMessage ?? "null"));
        if (!parsed.success) {
          throw new Error("Invalid persisted conversation message");
        }
        entries.push({ id: row.id, message: parsed.data });
      }
      return {
        state: {
          summary: summaries.map((summary) => summary.summary).join("\n\n"),
          summaryTimestamp: Math.max(0, ...summaries.map((summary) => summary.createdAt.getTime())),
          summarizedThroughId: mark,
          entries,
        },
        summaries: summaries.length,
      };
    });
  }

  // Moves a chat's transcript into an account's Bella conversation and lists that conversation
  // in the registry instead of the chat. Rows keep their ids, so they fall into time order with
  // the conversation's.
  // fused: the summary that replaces both summaries; without it the chat's summary, if any,
  // becomes the conversation's
  // Returns whether any transcript row moved
  public async moveToBella(
    db: TDatabaseHandle,
    chatId: string,
    conversationKey: string,
    ownerKey: string,
    fused: TOption<TFusedSummary>,
  ): Promise<boolean> {
    await db
      .insert(conversationsTable)
      .values({ conversationKey, ownerKey })
      .onConflictDoUpdate({ target: conversationsTable.conversationKey, set: { ownerKey } });
    await db.delete(conversationsTable).where(eq(conversationsTable.conversationKey, chatId));
    if (fused !== undefined) {
      const replaced = await db
        .select({ compactionBoundaries: conversationSummariesTable.compactionBoundaries })
        .from(conversationSummariesTable)
        .where(inArray(conversationSummariesTable.chatId, [chatId, conversationKey]));
      const boundaries = [
        ...new Set([
          ...replaced.flatMap((summary) => summary.compactionBoundaries),
          fused.summarizedThroughId,
        ]),
      ]
        .sort((left, right) => left - right)
        .slice(-KEPT_COMPACTIONS);
      const values = {
        summary: fused.summary,
        summarizedThroughId: fused.summarizedThroughId,
        compactionBoundaries: boundaries,
        createdAt: new Date(fused.summaryTimestamp),
      };
      await db
        .delete(conversationSummariesTable)
        .where(eq(conversationSummariesTable.chatId, chatId));
      await db
        .insert(conversationSummariesTable)
        .values({ chatId: conversationKey, ...values })
        .onConflictDoUpdate({ target: conversationSummariesTable.chatId, set: values });
    } else {
      await db
        .update(conversationSummariesTable)
        .set({ chatId: conversationKey })
        .where(eq(conversationSummariesTable.chatId, chatId));
    }
    const moved = await db
      .update(memoriesTable)
      .set({ chatId: conversationKey })
      .where(eq(memoriesTable.chatId, chatId))
      .returning({ id: memoriesTable.id });
    return moved.length > 0;
  }

  public load(chatId: string): Promise<TOption<TConversation>> {
    return this.database.run(async (db) => {
      const summary = await db
        .select()
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.chatId, chatId))
        .get();
      const rows = await db
        .select()
        .from(memoriesTable)
        .where(
          and(
            eq(memoriesTable.chatId, chatId),
            gt(memoriesTable.id, summary?.summarizedThroughId ?? 0),
            isNotNull(memoriesTable.modelMessage),
          ),
        )
        .orderBy(asc(memoriesTable.id));
      if (summary === undefined && rows.length === 0) {
        return undefined;
      }
      const entries: TConversation["entries"] = [];
      for (const row of rows) {
        const parsed = SConversationMessage.safeParse(JSON.parse(row.modelMessage ?? "null"));
        if (!parsed.success) {
          throw new Error("Invalid persisted conversation message");
        }
        entries.push({ id: row.id, message: parsed.data });
      }
      return {
        summary: summary?.summary ?? "",
        summaryTimestamp: summary?.createdAt.getTime() ?? 0,
        summarizedThroughId: summary?.summarizedThroughId ?? 0,
        entries,
      };
    });
  }

  // NOTE: the caller's transaction keeps the turn together with its follow-up events
  public async saveTurn(
    db: TDatabaseHandle,
    chatId: string,
    channel: EMessagePlatform,
    messages: Message[],
    userMessageId: number,
    previous: TOption<TConversation>,
  ): Promise<TConversation> {
    const entries = [...(previous?.entries ?? [])];
    const pending = messages.slice(entries.length);
    for (const [index, message] of pending.entries()) {
      if (index === 0) {
        const updated = await db
          .update(memoriesTable)
          .set({ modelMessage: JSON.stringify(message) })
          .where(and(eq(memoriesTable.id, userMessageId), eq(memoriesTable.chatId, chatId)));
        if (updated.rowsAffected !== 1) {
          throw new Error("Conversation source message is missing");
        }
        entries.push({ id: userMessageId, message });
        continue;
      }
      let kind: TSelectMemory["kind"] = "tool";
      if (index === pending.length - 1 && message.role === "assistant") {
        kind = "message";
      }
      let text: string;
      if (typeof message.content === "string") {
        text = message.content;
      } else {
        text = contentText(message.content);
      }
      const row = await db
        .insert(memoriesTable)
        .values({
          chatId,
          channel,
          kind,
          author: message.role,
          message: text,
          modelMessage: JSON.stringify(message),
          createdAt: new Date(message.timestamp),
        })
        .returning({ id: memoriesTable.id })
        .get();
      entries.push({ id: row.id, message });
    }
    return {
      summary: previous?.summary ?? "",
      summaryTimestamp: previous?.summaryTimestamp ?? 0,
      summarizedThroughId: previous?.summarizedThroughId ?? 0,
      entries,
    };
  }

  // text: stored for people; modelText: replayed to the model. Returns the delivery's row id
  public async saveDeliveredMessage(
    db: TDatabaseHandle,
    chatId: string,
    channel: EMessagePlatform,
    text: string,
    modelText: string,
    notice: string,
    deliveredAt: number,
  ): Promise<number> {
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: modelText }],
      api: "bellaclaw",
      provider: "bellaclaw",
      model: "scheduled-delivery",
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: deliveredAt,
    };
    // NOTE: without a user turn before it, providers merge the delivery into the previous
    // assistant reply, and the model then disowns it as text it wrote itself.
    const noticeMessage: UserMessage = { role: "user", content: notice, timestamp: deliveredAt };
    // NOTE: the caller's transaction keeps the notice and the delivery together
    await db.insert(memoriesTable).values({
      chatId,
      channel,
      kind: "tool",
      author: ERole.User,
      message: notice,
      modelMessage: JSON.stringify(noticeMessage),
      createdAt: new Date(deliveredAt),
    });
    const row = await db
      .insert(memoriesTable)
      .values({
        chatId,
        channel,
        kind: "message",
        author: ERole.Assistant,
        message: text,
        modelMessage: JSON.stringify(message),
        createdAt: new Date(deliveredAt),
      })
      .returning({ id: memoriesTable.id })
      .get();

    return row.id;
  }

  // display: stored with kind display and no model message, so it is never replayed. Returns the
  // reply's row id
  public async saveDisplayMessage(
    db: TDatabaseHandle,
    chatId: string,
    channel: EMessagePlatform,
    display: TDisplay,
    sentAt: number,
  ): Promise<number> {
    if (display.request !== undefined) {
      await db.insert(memoriesTable).values({
        chatId,
        channel,
        kind: "display",
        author: ERole.User,
        message: display.request.text,
        createdAt: new Date(display.request.receivedAt),
        clientMessageId: display.request.clientMessageId,
      });
    }
    const row = await db
      .insert(memoriesTable)
      .values({
        chatId,
        channel,
        kind: "display",
        author: ERole.Assistant,
        message: display.text,
        createdAt: new Date(sentAt),
      })
      .returning({ id: memoriesTable.id })
      .get();

    return row.id;
  }

  // Deletes one transcript message. An assistant reply takes the tool rows of its turn with it:
  // the chat's tool rows after the transcript message before it, so no tool call or result stays
  // in the replay without its reply. Display rows stay.
  // Returns the deleted row ids and the attachments they referenced, or undefined when messageId
  // is no user or assistant transcript message of this chat.
  public async deleteMessage(
    db: TDatabaseHandle,
    chatId: string,
    messageId: number,
  ): Promise<TOption<{ messageIds: number[]; attachments: TAttachmentRef[] }>> {
    const target = await db
      .select({ author: memoriesTable.author })
      .from(memoriesTable)
      .where(
        and(
          eq(memoriesTable.id, messageId),
          eq(memoriesTable.chatId, chatId),
          eq(memoriesTable.kind, "message"),
          inArray(memoriesTable.author, [ERole.User, ERole.Assistant]),
        ),
      )
      .get();
    if (target === undefined) {
      return undefined;
    }
    // the message goes, with the chat's tool rows in (after, messageId)
    let after = messageId - 1;
    if (target.author === ERole.Assistant) {
      const previous = await db
        .select({ id: memoriesTable.id })
        .from(memoriesTable)
        .where(
          and(
            eq(memoriesTable.chatId, chatId),
            eq(memoriesTable.kind, "message"),
            lt(memoriesTable.id, messageId),
          ),
        )
        .orderBy(desc(memoriesTable.id))
        .limit(1)
        .get();
      after = previous?.id ?? 0;
    }
    const deleted = await db
      .delete(memoriesTable)
      .where(
        and(
          eq(memoriesTable.chatId, chatId),
          or(
            eq(memoriesTable.id, messageId),
            and(
              eq(memoriesTable.kind, "tool"),
              gt(memoriesTable.id, after),
              lt(memoriesTable.id, messageId),
            ),
          ),
        ),
      )
      .returning({ id: memoriesTable.id, attachments: memoriesTable.attachments });
    return {
      messageIds: deleted.map((row) => row.id).sort((a, b) => a - b),
      attachments: deleted.flatMap((row) => parseAttachments(row.attachments)),
    };
  }

  // returns the attachments whose files are no longer needed
  public saveSummary(chatId: string, state: TConversation): Promise<TAttachmentRef[]> {
    return this.database.run(async (db) => {
      const existing = await db
        .select({ compactionBoundaries: conversationSummariesTable.compactionBoundaries })
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.chatId, chatId))
        .get();
      const boundaries = [...(existing?.compactionBoundaries ?? []), state.summarizedThroughId];
      let dropped = 0;
      if (boundaries.length > KEPT_COMPACTIONS) {
        dropped = boundaries[boundaries.length - KEPT_COMPACTIONS - 1] ?? 0;
      }
      const kept = boundaries.slice(-KEPT_COMPACTIONS);
      const values = {
        summary: state.summary,
        summarizedThroughId: state.summarizedThroughId,
        compactionBoundaries: kept,
        createdAt: new Date(state.summaryTimestamp),
      };
      await db
        .insert(conversationSummariesTable)
        .values({ chatId, ...values })
        .onConflictDoUpdate({ target: conversationSummariesTable.chatId, set: values });

      const oldest = kept[0];
      if (kept.length < KEPT_COMPACTIONS || oldest === undefined) {
        return [];
      }
      const rows = await db
        .select({ attachments: memoriesTable.attachments })
        .from(memoriesTable)
        .where(
          and(
            eq(memoriesTable.chatId, chatId),
            eq(memoriesTable.author, ERole.User),
            gt(memoriesTable.id, dropped),
            lte(memoriesTable.id, oldest),
            isNotNull(memoriesTable.attachments),
          ),
        );
      return rows.flatMap((row) => parseAttachments(row.attachments));
    });
  }
}

// a row's stored attachment references; none when it has none
function parseAttachments(stored: TSelectMemory["attachments"]): TAttachmentRef[] {
  if (stored === null) {
    return [];
  }

  const parsed = SAttachmentRefs.safeParse(JSON.parse(stored));

  if (!parsed.success) {
    throw new Error("Invalid stored attachments");
  }

  return parsed.data;
}
