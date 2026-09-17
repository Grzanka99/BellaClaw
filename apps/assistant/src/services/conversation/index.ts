import { AsyncQueue, type TOption } from "@bellaclaw/shared";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { and, asc, desc, eq, gt, isNotNull, ne } from "drizzle-orm";
import { ERole } from "../ai/types";
import { DatabaseConnector } from "../database";
import { memoriesTable } from "../database/schema";
import { EMemoryImportance } from "../memory/types";
import { SConversationMessage, type TConversation } from "./types";

export class ConversationStore {
  private static _instance: TOption<ConversationStore>;
  private queue = new AsyncQueue();
  private db = DatabaseConnector.instance.database;

  public static get instance(): ConversationStore {
    if (ConversationStore._instance === undefined) {
      ConversationStore._instance = new ConversationStore();
    }
    return ConversationStore._instance;
  }

  public load(chatId: string, platform: string): Promise<TOption<TConversation>> {
    return this.queue.enqueue(async () => {
      const scope = and(eq(memoriesTable.chatId, chatId), eq(memoriesTable.platform, platform));
      const summary = await this.db
        .select()
        .from(memoriesTable)
        .where(and(scope, eq(memoriesTable.kind, "summary")))
        .orderBy(desc(memoriesTable.id))
        .get();
      const rows = await this.db
        .select()
        .from(memoriesTable)
        .where(
          and(
            scope,
            ne(memoriesTable.kind, "summary"),
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
        summary: summary?.message ?? "",
        summaryTimestamp: summary?.createdAt ?? 0,
        summarizedThroughId: summary?.summarizedThroughId ?? 0,
        entries,
      };
    });
  }

  public saveTurn(
    chatId: string,
    platform: string,
    messages: Message[],
    userMessageId: number,
    previous: TOption<TConversation>,
    bootstrapIds: number[] = [],
  ): Promise<TConversation> {
    return this.queue.enqueue(() =>
      this.db.transaction(async (tx) => {
        const entries = [...(previous?.entries ?? [])];
        const pending = messages.slice(entries.length);
        const sourceIds = [...bootstrapIds, userMessageId];
        for (const [index, message] of pending.entries()) {
          const sourceId = sourceIds[index];
          if (sourceId !== undefined) {
            const updated = await tx
              .update(memoriesTable)
              .set({ modelMessage: JSON.stringify(message), platform })
              .where(and(eq(memoriesTable.id, sourceId), eq(memoriesTable.chatId, chatId)));
            if (updated.rowsAffected !== 1) {
              throw new Error("Conversation source message is missing");
            }
            entries.push({ id: sourceId, message });
            continue;
          }
          let kind = "tool";
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
              platform,
              kind,
              author: message.role,
              importance: EMemoryImportance.Medium,
              message: text,
              modelMessage: JSON.stringify(message),
              createdAt: message.timestamp,
              lastReadAt: message.timestamp,
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

  public saveSummary(chatId: string, platform: string, state: TConversation): Promise<void> {
    return this.queue.enqueue(async () => {
      await this.db.insert(memoriesTable).values({
        chatId,
        platform,
        kind: "summary",
        author: ERole.System,
        importance: EMemoryImportance.Medium,
        message: state.summary,
        summarizedThroughId: state.summarizedThroughId,
        createdAt: state.summaryTimestamp,
        lastReadAt: state.summaryTimestamp,
      });
    });
  }
}
