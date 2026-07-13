import { describe, expect, test } from "bun:test";
import type { TToolCall } from "../../types";
import { requireChatId } from "./context";

const toolCall: TToolCall = {
  id: "tool-call",
  name: "test-tool",
  arguments: {},
};

describe("requireChatId", () => {
  test("returns chatId when present", () => {
    expect(requireChatId(toolCall, "chat-id")).toBe("chat-id");
  });

  test("returns undefined when missing", () => {
    expect(requireChatId(toolCall, undefined)).toBeUndefined();
  });
});
