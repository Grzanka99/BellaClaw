import type { TOption } from "@bellaclaw/shared";
import {
  type AssistantMessage,
  contentText,
  type Message,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { and, asc, eq, gt, isNotNull, lte } from "drizzle-orm";
import { emptyUsage } from "../ai/llm";
import { ERole } from "../ai/types";
import { DatabaseConnector, type TDatabaseHandle } from "../database";
import { conversationSummariesTable, memoriesTable, type TSelectMemory } from "../database/schema";
import type { TAttachmentRef } from "../messaging/types";
import { SAttachmentBlock, SConversationMessage, type TConversation } from "./types";

// NOTE: platform files of the images older than this many compactions are deleted
const KEPT_COMPACTIONS = 3;

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
    author: ERole,
    message: string,
    createdAt: Date,
  ): Promise<TSelectMemory> {
    return db
      .insert(memoriesTable)
      .values({ chatId, author, message, createdAt })
      .returning()
      .get();
  }

  public findChatIds(): Promise<string[]> {
    return this.database.run(async (db) => {
      const rows = await db
        .selectDistinct({ chatId: memoriesTable.chatId })
        .from(memoriesTable)
        .orderBy(asc(memoriesTable.chatId));
      return rows.map((row) => row.chatId);
    });
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

  public async saveDeliveredMessage(
    db: TDatabaseHandle,
    chatId: string,
    text: string,
    notice: string,
    deliveredAt: number,
  ): Promise<void> {
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
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
      kind: "tool",
      author: ERole.User,
      message: notice,
      modelMessage: JSON.stringify(noticeMessage),
      createdAt: new Date(deliveredAt),
    });
    await db.insert(memoriesTable).values({
      chatId,
      kind: "message",
      author: ERole.Assistant,
      message: text,
      modelMessage: JSON.stringify(message),
      createdAt: new Date(deliveredAt),
    });
  }

  // returns the attachments whose platform files are no longer needed
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
        .select({ modelMessage: memoriesTable.modelMessage })
        .from(memoriesTable)
        .where(
          and(
            eq(memoriesTable.chatId, chatId),
            eq(memoriesTable.author, ERole.User),
            gt(memoriesTable.id, dropped),
            lte(memoriesTable.id, oldest),
            isNotNull(memoriesTable.modelMessage),
          ),
        );
      const refs: TAttachmentRef[] = [];
      for (const row of rows) {
        const parsed = SConversationMessage.safeParse(JSON.parse(row.modelMessage ?? "null"));
        if (!parsed.success || typeof parsed.data.content === "string") {
          continue;
        }
        for (const block of parsed.data.content) {
          const attachment = SAttachmentBlock.safeParse(block);
          if (attachment.success) {
            refs.push(attachment.data.attachment);
          }
        }
      }
      return refs;
    });
  }
}
