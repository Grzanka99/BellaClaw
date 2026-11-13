import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { and, desc, eq } from "drizzle-orm";
import { ERole } from "../ai/types";
import { DatabaseConnector } from "../database";
import { memoriesTable } from "../database/schema";
import { Memory } from "../memory";
import { ConversationStore } from ".";
import { attachmentBlock, type TConversation } from "./types";

async function transcriptMessages(chatId: string) {
  const rows = await DatabaseConnector.instance.database
    .select()
    .from(memoriesTable)
    .where(and(eq(memoriesTable.chatId, chatId), eq(memoriesTable.kind, "message")))
    .orderBy(desc(memoriesTable.id));
  return rows.map((row) => row.message);
}

test("replays native messages after restart; compaction preserves fact source history", async () => {
  const chatId = "conversation-restart";
  const store = new ConversationStore();
  const source = await store.saveUserMessage(
    DatabaseConnector.instance.database,
    chatId,
    ERole.User,
    "Check calendar",
    new Date(),
  );
  const call = fauxAssistantMessage(fauxToolCall("calendar", {}, { id: "calendar-1" }));
  call.content.push({
    type: "thinking",
    thinking: "",
    thinkingSignature: "opaque-provider-signature",
  });
  const messages: Message[] = [
    { role: "user", content: "Check calendar", timestamp: source.createdAt.getTime() },
    call,
    {
      role: "toolResult",
      toolName: "calendar",
      toolCallId: "calendar-1",
      content: [{ type: "text", text: "Free" }],
      timestamp: 2,
      isError: false,
    },
    fauxAssistantMessage("Free"),
  ];
  const persisted = await store.saveTurn(
    DatabaseConnector.instance.database,
    chatId,
    messages,
    source.id,
    undefined,
  );
  expect((await new ConversationStore().load(chatId))?.entries).toEqual(persisted.entries);
  expect(persisted.entries.map((entry) => entry.message)).toEqual(messages);
  expect(new Set(persisted.entries.map((entry) => entry.id)).size).toBe(4);
  await store.saveSummary(chatId, {
    summary: "Calendar was free",
    summaryTimestamp: 3,
    entries: [],
    summarizedThroughId: persisted.entries.at(-1)?.id ?? 0,
  });
  expect((await store.load(chatId))?.entries).toEqual([]);
  expect(await transcriptMessages(chatId)).toEqual(["Free", "Check calendar"]);
  expect(
    (await Memory.instance.loadLiveFactWindow(chatId)).messages.map((row) => row.author),
  ).toEqual([ERole.User, ERole.Assistant]);
});

test("appends later turns, skips rows without replay and reloads the retained tail", async () => {
  const store = new ConversationStore();
  const chatId = "summary-cutoff";
  await store.saveUserMessage(
    DatabaseConnector.instance.database,
    chatId,
    ERole.User,
    "failed turn",
    new Date(),
  );
  expect(await store.load(chatId)).toBeUndefined();
  let state: TConversation | undefined;
  for (const text of ["first", "second", "third"]) {
    const source = await store.saveUserMessage(
      DatabaseConnector.instance.database,
      chatId,
      ERole.User,
      text,
      new Date(),
    );
    let history: Message[] = [];
    if (state !== undefined) {
      history = state.entries.map((entry) => entry.message);
    }
    state = await store.saveTurn(
      DatabaseConnector.instance.database,
      chatId,
      [
        ...history,
        { role: "user", content: text, timestamp: source.createdAt.getTime() },
        fauxAssistantMessage(`reply ${text}`),
      ],
      source.id,
      state,
    );
  }
  if (state === undefined) {
    throw new Error("Expected persisted turns");
  }
  expect(state.entries).toHaveLength(6);
  const persisted = state;
  expect((await store.load(chatId))?.entries).toEqual(persisted.entries);
  await store.saveSummary(chatId, {
    ...persisted,
    summary: "First exchange summarized",
    summaryTimestamp: Date.now(),
    entries: persisted.entries.slice(2),
    summarizedThroughId: persisted.entries[1]?.id ?? 0,
  });
  const summaryState = {
    ...persisted,
    summary: "Two exchanges summarized",
    summaryTimestamp: Date.now(),
    entries: persisted.entries.slice(4),
    summarizedThroughId: persisted.entries[3]?.id ?? 0,
  };
  await store.saveSummary(chatId, summaryState);
  expect(await new ConversationStore().load(chatId)).toEqual(summaryState);
});

test("a missing user row fails the turn", async () => {
  const chatId = "missing-source";
  const store = new ConversationStore();
  await expect(
    store.saveTurn(
      DatabaseConnector.instance.database,
      chatId,
      [{ role: "user", content: "missing", timestamp: 2 }, fauxAssistantMessage("answer")],
      999999,
      undefined,
    ),
  ).rejects.toThrow("missing");
  expect(await store.load(chatId)).toBeUndefined();
});

test("a scheduled delivery replays after a scheduler notice the model cannot merge into its reply", async () => {
  const chatId = "conversation-delivery";
  const store = new ConversationStore();
  const deliveredAt = Date.UTC(2026, 10, 10, 16, 6);
  await store.saveDeliveredMessage(
    DatabaseConnector.instance.database,
    chatId,
    "[CRON REMINDER oven]: Check the oven.",
    'Scheduler notice, not from the user: reminder "oven" fired at 2026-11-10T16:06:00.000Z.',
    deliveredAt,
  );

  const roles = (await store.load(chatId))?.entries.map((entry) => entry.message.role);
  expect(roles).toEqual(["user", "assistant"]);
  expect(JSON.stringify((await store.load(chatId))?.entries[0]?.message)).toContain(
    "2026-11-10T16:06:00.000Z",
  );
  expect(await transcriptMessages(chatId)).toEqual(["[CRON REMINDER oven]: Check the oven."]);
});

test("after three kept compactions, saveSummary returns the images of the dropped range", async () => {
  const chatId = "conversation-image-cleanup";
  const store = new ConversationStore();
  const db = DatabaseConnector.instance.database;
  const ids: number[] = [];
  for (const name of ["a", "b", "c", "d", "e"]) {
    const row = await store.saveUserMessage(db, chatId, ERole.User, "[Image]", new Date());
    const ref = { id: name, mimeType: "image/png" };
    await store.saveTurn(
      db,
      chatId,
      [{ role: "user", content: [attachmentBlock(ref)], timestamp: 1 }],
      row.id,
      undefined,
    );
    ids.push(row.id);
  }
  const summarize = (summarizedThroughId: number) =>
    store.saveSummary(chatId, {
      summary: "s",
      summaryTimestamp: 1,
      summarizedThroughId,
      entries: [],
    });

  expect(await summarize(ids[0] ?? 0)).toEqual([]);
  expect(await summarize(ids[1] ?? 0)).toEqual([]);
  // boundaries [a, b, c]: nothing was dropped yet, so everything through a goes
  expect((await summarize(ids[2] ?? 0)).map((ref) => ref.id)).toEqual(["a"]);
  // boundaries [b, c, d]: a was dropped, so (a, b] goes
  expect((await summarize(ids[3] ?? 0)).map((ref) => ref.id)).toEqual(["b"]);
});
