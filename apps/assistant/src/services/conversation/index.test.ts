import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ERole } from "../ai/types";
import { Memory } from "../memory";
import { EMemoryImportance } from "../memory/types";
import { ConversationStore } from ".";
import type { TConversation } from "./types";

test("replays messages from memories across restart; checkpoint changes do not erase the source history", async () => {
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
  const state: TConversation = {
    summary: "",
    summaryTimestamp: 0,
    fixedTokens: 3000,
    contextTokens: 6000,
    lastMemoryId: source.id,
    messageIds: [source.id, source.id, source.id, source.id],
    messages: [
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
    ],
  };
  const store = new ConversationStore();
  const persisted = await store.saveTurn(chatId, "discord", state, source.id, []);
  const reopened = new ConversationStore();
  expect((await reopened.load(chatId, "discord"))?.messages).toEqual(state.messages);
  expect(new Set(persisted.messageIds).size).toBe(4);
  expect(await reopened.load(chatId, "signal")).toBeUndefined();
  await reopened.saveSummary(chatId, "discord", {
    ...persisted,
    summary: "Calendar was free",
    summaryTimestamp: 3,
    messages: [],
    messageIds: [],
    contextTokens: 3100,
  });
  expect((await store.load(chatId, "discord"))?.messages).toEqual([]);
  expect((await Memory.instance.findRecent(chatId, 10)).map((row) => row.message)).toEqual([
    "Free",
    "Check calendar",
  ]);
  expect(
    (await Memory.instance.loadLiveFactWindow(chatId)).messages.map((row) => row.author),
  ).toEqual([ERole.User, ERole.Assistant]);
  // Failed source writes roll back the checkpoint too.
  await expect(
    store.saveTurn(
      chatId,
      "discord",
      { ...state, summary: "must not commit", messageIds: [999999, 999999, 999999, 999999] },
      999999,
      [],
    ),
  ).rejects.toThrow("missing");
  expect((await store.load(chatId, "discord"))?.summary).toBe("Calendar was free");
});

test("loads the retained tail before a summary row and keeps platforms separate", async () => {
  const store = new ConversationStore();
  const chatId = "summary-cutoff";
  let state: TConversation = {
    summary: "",
    summaryTimestamp: 0,
    messages: [],
    messageIds: [],
    lastMemoryId: 0,
    fixedTokens: 3000,
    contextTokens: 0,
  };
  for (const text of ["first", "second"]) {
    const source = await Memory.instance.save({
      chatId,
      platform: "discord",
      author: ERole.User,
      importance: EMemoryImportance.Medium,
      message: text,
    });
    state = await store.saveTurn(
      chatId,
      "discord",
      {
        ...state,
        messages: [
          ...state.messages,
          { role: "user", content: text, timestamp: source.createdAt.getTime() },
          fauxAssistantMessage(`reply ${text}`),
        ],
        messageIds: [...state.messageIds, source.id, source.id],
        lastMemoryId: source.id,
      },
      source.id,
      [],
    );
  }
  const retained = state.messages.slice(2);
  const summaryState = {
    ...state,
    summary: "First exchange summarized",
    summaryTimestamp: Date.now(),
    messages: retained,
    messageIds: state.messageIds.slice(2),
  };
  await store.saveSummary(chatId, "discord", summaryState);
  const loaded = await new ConversationStore().load(chatId, "discord");
  expect(loaded?.summary).toBe("First exchange summarized");
  expect(loaded?.messages).toEqual(retained);
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
    {
      ...summaryState,
      summary: "",
      messages: [{ role: "user", content: "separate", timestamp: Date.now() }],
      messageIds: [other.id],
      lastMemoryId: other.id,
    },
    other.id,
    [],
  );
  expect((await store.load(chatId, "discord"))?.messages).toEqual(retained);
  expect((await store.load(chatId, "signal"))?.messages).toHaveLength(1);
  expect(
    (await Memory.instance.findRecent(chatId, 30, "signal")).map((row) => row.message),
  ).toEqual(["separate"]);
});
