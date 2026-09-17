import { AsyncQueue, type TOption } from "@bellaclaw/shared";
import { estimateTokens } from "@earendil-works/pi-agent-core";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { and, asc, desc, eq, gt, isNotNull, ne } from "drizzle-orm";
import { ERole } from "../ai/types";
import { DatabaseConnector } from "../database";
import { memoriesTable } from "../database/schema";
import { EMemoryImportance } from "../memory/types";
import {
  conversationMessages,
  SConversation,
  SConversationMessage,
  type TConversation,
} from "./types";

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
      const messages: Message[] = [];
      for (const row of rows) {
        const parsed = SConversationMessage.safeParse(JSON.parse(row.modelMessage ?? "null"));
        if (!parsed.success) {
          throw new Error("Invalid persisted conversation message");
        }
        messages.push(parsed.data);
      }
      const state: TConversation = {
        summary: summary?.message ?? "",
        summaryTimestamp: summary?.createdAt ?? 0,
        messages,
        messageIds: rows.map((row) => row.id),
        lastMemoryId: rows.at(-1)?.id ?? summary?.summarizedThroughId ?? 0,
        fixedTokens: 0,
        contextTokens: 0,
      };
      // Fixed instructions are counted by the harness using current settings.
      state.contextTokens = conversationMessages(state).reduce(
        (sum, message) => sum + estimateTokens(message),
        0,
      );
      return state;
    });
  }

  public saveTurn(
    chatId: string,
    platform: string,
    state: TConversation,
    userMessageId: number,
    bootstrapIds: number[],
  ): Promise<TConversation> {
    return this.queue.enqueue(async () => {
      const parsed = SConversation.safeParse(state);
      if (!parsed.success || state.messageIds.length !== state.messages.length) {
        throw new Error("Invalid conversation state");
      }
      return this.db.transaction(async (tx) => {
        const ids = [...state.messageIds];
        let savedUser = false;
        for (let index = 0; index < state.messages.length; index += 1) {
          const message = state.messages[index];
          const sourceId = state.messageIds[index];
          if (message === undefined || sourceId === undefined) {
            throw new Error("Missing conversation message ID");
          }
          if (sourceId !== userMessageId && !bootstrapIds.includes(sourceId)) {
            continue;
          }
          if (sourceId !== userMessageId || !savedUser) {
            const updated = await tx
              .update(memoriesTable)
              .set({ modelMessage: JSON.stringify(message), platform })
              .where(and(eq(memoriesTable.id, sourceId), eq(memoriesTable.chatId, chatId)));
            if (updated.rowsAffected !== 1) {
              throw new Error("Conversation source message is missing");
            }
            if (sourceId === userMessageId) {
              savedUser = true;
            }
            continue;
          }
          let kind = "tool";
          if (
            index === state.messages.length - 1 &&
            message.role === "assistant" &&
            !message.content.some((part) => part.type === "toolCall") &&
            message.stopReason !== "error" &&
            message.stopReason !== "aborted"
          ) {
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
          ids[index] = row.id;
        }
        return { ...state, messageIds: ids, lastMemoryId: ids.at(-1) ?? userMessageId };
      });
    });
  }

  public saveSummary(chatId: string, platform: string, state: TConversation): Promise<void> {
    return this.queue.enqueue(async () => {
      let summarizedThroughId = state.lastMemoryId;
      const firstRetainedId = state.messageIds[0];
      if (firstRetainedId !== undefined) {
        summarizedThroughId = firstRetainedId - 1;
      }
      await this.db.insert(memoriesTable).values({
        chatId,
        platform,
        kind: "summary",
        author: ERole.System,
        importance: EMemoryImportance.Medium,
        message: state.summary,
        summarizedThroughId,
        createdAt: state.summaryTimestamp,
        lastReadAt: state.summaryTimestamp,
      });
    });
  }
}
