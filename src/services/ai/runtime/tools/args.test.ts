import { describe, expect, test } from "bun:test";
import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { z } from "zod";
import { parseAndValidateToolArgs } from "./args";

function createToolCall(argumentsText: string): ChatMessageToolCall {
  return {
    id: "tool-call",
    type: "function",
    function: {
      name: "test-tool",
      arguments: argumentsText,
    },
  };
}

describe("parseAndValidateToolArgs", () => {
  const schema = z.object({
    name: z.string(),
  });

  test("returns parsed data for valid arguments", () => {
    const result = parseAndValidateToolArgs(
      createToolCall(JSON.stringify({ name: "job" })),
      schema,
    );

    expect(result).toEqual({
      success: true,
      data: { name: "job" },
    });
  });

  test("returns error for invalid JSON", () => {
    const result = parseAndValidateToolArgs(createToolCall("{"), schema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid JSON arguments");
    }
  });

  test("returns error for invalid arguments", () => {
    const result = parseAndValidateToolArgs(createToolCall(JSON.stringify({ name: 123 })), schema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Arguments validation failed");
    }
  });
});
