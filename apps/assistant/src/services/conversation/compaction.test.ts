import { describe, expect, test } from "bun:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { compactConversation } from "./compaction";
import type { TConversation } from "./types";

function fixture() {
  const faux = fauxProvider({
    models: [{ id: "summary", contextWindow: 200_000, maxTokens: 8192 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const state: TConversation = {
    summary: "Previously chose the train.",
    summaryTimestamp: 1,
    fixedTokens: 3000,
    contextTokens: 75_000,
    lastMemoryId: 2,
    messageIds: [1, 1, 2, 2, 2, 2],
    messages: [
      { role: "user", content: "old detail ".repeat(26_000), timestamp: 1 },
      fauxAssistantMessage("We chose option B", { timestamp: 2 }),
      { role: "user", content: "Check today's calendar", timestamp: 3 },
      fauxAssistantMessage(fauxToolCall("calendar", {}, { id: "calendar-1" })),
      {
        role: "toolResult",
        toolName: "calendar",
        toolCallId: "calendar-1",
        content: [{ type: "text", text: "Free at noon" }],
        isError: false,
        timestamp: 4,
      },
      fauxAssistantMessage("Free at noon"),
    ],
  };
  return { faux, models, state, model: faux.getModel() };
}

describe("conversation compaction", () => {
  test("does not summarize below 65k", async () => {
    const { state, models, model, faux } = fixture();
    state.contextTokens = 64_999;
    expect(await compactConversation(state, models, model, undefined)).toBeUndefined();
    expect(faux.state.callCount).toBe(0);
  });

  test("updates the previous summary, retains whole recent tool exchanges and ignores stale usage", async () => {
    const { state, models, model, faux } = fixture();
    const original = structuredClone(state);
    faux.setResponses([
      (context) => {
        const prompt = JSON.stringify(context);
        expect(prompt).toContain("Previously chose the train.");
        expect(prompt).toContain("We chose option B");
        expect(prompt).not.toContain("Check today's calendar");
        return fauxAssistantMessage("Chose train option B. Calendar still needs confirmation.");
      },
    ]);
    const result = await compactConversation(state, models, model, undefined);
    expect(result?.state.messages).toEqual(state.messages.slice(2));
    expect(result?.state.messageIds).toEqual([2, 2, 2, 2]);
    expect(result?.state.contextTokens).toBeLessThan(25_000);
    expect(state).toEqual(original);
    if (result === undefined) {
      throw new Error("Expected compaction");
    }
    result.state.contextTokens = 66_000;
    result.state.messages.unshift(...state.messages.slice(0, 2));
    result.state.messageIds.unshift(1, 1);
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context)).toContain(result.state.summary);
        return fauxAssistantMessage("Updated train and calendar summary");
      },
    ]);
    expect(
      (await compactConversation(result.state, models, model, undefined))?.state.summary,
    ).toContain("Updated");
  });

  test("summarizes an oversized completed turn rather than splitting its tool pair", async () => {
    const { state, models, model, faux } = fixture();
    state.messages.splice(2, 1);
    state.messageIds = state.messages.map(() => 1);
    state.contextTokens = 110_000;
    faux.setResponses([fauxAssistantMessage("Completed calendar work; results are historical.")]);
    const result = await compactConversation(state, models, model, undefined);
    expect(result?.state.messages).toEqual([]);
    expect(result?.state.contextTokens).toBeLessThan(25_000);
  });

  test("empty summary fails without mutating original history", async () => {
    const { state, models, model, faux } = fixture();
    const original = structuredClone(state);
    faux.setResponses([fauxAssistantMessage(" ")]);
    await expect(compactConversation(state, models, model, undefined)).rejects.toThrow(
      "empty summary",
    );
    expect(state).toEqual(original);
  });
});
