import { describe, expect, test } from "bun:test";
import type { TToolCall } from "../../types";
import { createFailedToolResult, createSuccessfulToolResult } from "./results";

const toolCall: TToolCall = {
  id: "tool-call",
  name: "test-tool",
  arguments: {},
};

describe("tool result helpers", () => {
  test("creates successful tool results", () => {
    expect(createSuccessfulToolResult(toolCall, { ok: true })).toEqual({
      toolCallId: "tool-call",
      toolName: "test-tool",
      success: true,
      data: { ok: true },
      error: undefined,
    });
  });

  test("creates failed tool results", () => {
    expect(createFailedToolResult(toolCall, "failed")).toEqual({
      toolCallId: "tool-call",
      toolName: "test-tool",
      success: false,
      data: undefined,
      error: "failed",
    });
  });
});
