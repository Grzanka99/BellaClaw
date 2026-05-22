import { describe, expect, test } from "bun:test";
import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { requireChatId } from "./context";

const toolCall: ChatMessageToolCall = {
  id: "tool-call",
  type: "function",
  function: {
    name: "test-tool",
    arguments: "{}",
  },
};

describe("requireChatId", () => {
  test("returns chatId when present", () => {
    expect(requireChatId(toolCall, "chat-id")).toBe("chat-id");
  });

  test("returns undefined when missing", () => {
    expect(requireChatId(toolCall, undefined)).toBeUndefined();
  });
});
