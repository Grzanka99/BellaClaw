import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { ERole } from "../ai/types";
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { ConversationStore } from ".";
import type { TConversation } from "./types";

test("replays native messages after restart; compaction preserves fact source history", async () => {
  const chatId = "conversation-restart";
  const source = await Memory.instance.save({
    chatId,
    author: ERole.User,
    importance: EMemoryImportance.Medium,
    message: "Check calendar",
  });
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
  const store = new ConversationStore();
  const persisted = await store.saveTurn(chatId, "discord", messages, source.id, undefined);
  expect((await new ConversationStore().load(chatId, "discord"))?.entries).toEqual(
    persisted.entries,
  );
  expect(persisted.entries.map((entry) => entry.message)).toEqual(messages);
  expect(new Set(persisted.entries.map((entry) => entry.id)).size).toBe(4);
  await store.saveSummary(chatId, "discord", {
    summary: "Calendar was free",
    summaryTimestamp: 3,
    entries: [],
    summarizedThroughId: persisted.entries.at(-1)?.id ?? 0,
  });
  expect((await store.load(chatId, "discord"))?.entries).toEqual([]);
  expect((await Memory.instance.findRecent(chatId, 10)).map((row) => row.message)).toEqual([
    "Free",
    "Check calendar",
  ]);
  expect(
    (await Memory.instance.loadLiveFactWindow(chatId)).messages.map((row) => row.author),
  ).toEqual([ERole.User, ERole.Assistant]);
});

test("bootstraps existing rows once, appends later turns and reloads the retained tail", async () => {
  const store = new ConversationStore();
  const chatId = "summary-cutoff";
  const legacy = await Memory.instance.save({
    chatId,
    author: ERole.User,
    importance: EMemoryImportance.Medium,
    message: "legacy",
  });
  let state: TConversation | undefined;
  for (const text of ["first", "second"]) {
    const source = await Memory.instance.save({
      chatId,
      platform: "discord",
      author: ERole.User,
      importance: EMemoryImportance.Medium,
      message: text,
    });
    let history: Message[] = [
      { role: "user", content: "legacy with original timestamp", timestamp: 1 },
    ];
    let bootstrapIds = [legacy.id];
    if (state !== undefined) {
      history = state.entries.map((entry) => entry.message);
      bootstrapIds = [];
    }
    state = await store.saveTurn(
      chatId,
      "discord",
      [
        ...history,
        { role: "user", content: text, timestamp: source.createdAt.getTime() },
        fauxAssistantMessage(`reply ${text}`),
      ],
      source.id,
      state,
      bootstrapIds,
    );
  }
  expect(state?.entries).toHaveLength(5);
  if (state === undefined) {
    throw new Error("Expected persisted turns");
  }
  const persisted = state;
  expect((await store.load(chatId, "discord"))?.entries).toEqual(persisted.entries);
  expect(persisted.entries[0]?.id).toBe(legacy.id);
  const summaryState = {
    ...persisted,
    summary: "First exchange summarized",
    summaryTimestamp: Date.now(),
    entries: persisted.entries.slice(3),
    summarizedThroughId: persisted.entries[2]?.id ?? 0,
  };
  await store.saveSummary(chatId, "discord", summaryState);
  expect(await new ConversationStore().load(chatId, "discord")).toEqual(summaryState);
  const other = await Memory.instance.save({
    chatId,
    platform: "signal",
    author: ERole.User,
    importance: EMemoryImportance.Medium,
    message: "separate",
  });
  await store.saveTurn(
    chatId,
    "signal",
    [
      { role: "user", content: "separate", timestamp: Date.now() },
      fauxAssistantMessage("Other reply"),
    ],
    other.id,
    undefined,
  );
  expect(await store.load(chatId, "discord")).toEqual(summaryState);
  expect(
    (await Memory.instance.findRecent(chatId, 30, "signal")).map((row) => row.message),
  ).toEqual(["Other reply", "separate"]);
});

test("a missing user row rolls back bootstrap writes", async () => {
  const chatId = "missing-source";
  const source = await Memory.instance.save({
    chatId,
    author: ERole.User,
    importance: EMemoryImportance.Medium,
    message: "legacy",
  });
  const store = new ConversationStore();
  await expect(
    store.saveTurn(
      chatId,
      "discord",
      [
        { role: "user", content: "legacy", timestamp: 1 },
        { role: "user", content: "missing", timestamp: 2 },
        fauxAssistantMessage("answer"),
      ],
      999999,
      undefined,
      [source.id],
    ),
  ).rejects.toThrow("missing");
  expect(await store.load(chatId, "discord")).toBeUndefined();
});
