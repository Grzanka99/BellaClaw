import type { TOption } from "@bellaclaw/shared";
import { type AssistantMessage, contentText, type Message } from "@earendil-works/pi-ai";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { emptyUsage } from "../ai/llm";
import { ERole } from "../ai/types";
import { DatabaseConnector } from "../database";
import { conversationSummariesTable, memoriesTable, type TSelectMemory } from "../database/schema";
import { SConversationMessage, type TConversation } from "./types";

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
    chatId: string,
    author: ERole,
    message: string,
    createdAt: Date,
  ): Promise<TSelectMemory> {
    return this.database.run((db) =>
      db.insert(memoriesTable).values({ chatId, author, message, createdAt }).returning().get(),
    );
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

  public saveTurn(
    chatId: string,
    messages: Message[],
    userMessageId: number,
    previous: TOption<TConversation>,
  ): Promise<TConversation> {
    return this.database.run((db) =>
      db.transaction(async (tx) => {
        const entries = [...(previous?.entries ?? [])];
        const pending = messages.slice(entries.length);
        for (const [index, message] of pending.entries()) {
          if (index === 0) {
            const updated = await tx
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
          const row = await tx
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
      }),
    );
  }

  public saveDeliveredMessage(chatId: string, text: string, deliveredAt: number): Promise<void> {
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
    return this.database.run(async (db) => {
      await db.insert(memoriesTable).values({
        chatId,
        kind: "message",
        author: ERole.Assistant,
        message: text,
        modelMessage: JSON.stringify(message),
        createdAt: new Date(deliveredAt),
      });
    });
  }

  public saveSummary(chatId: string, state: TConversation): Promise<void> {
    return this.database.run(async (db) => {
      const values = {
        summary: state.summary,
        summarizedThroughId: state.summarizedThroughId,
        createdAt: new Date(state.summaryTimestamp),
      };
      await db
        .insert(conversationSummariesTable)
        .values({ chatId, ...values })
        .onConflictDoUpdate({ target: conversationSummariesTable.chatId, set: values });
    });
  }
}
