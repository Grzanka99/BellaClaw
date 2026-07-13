import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { TToolCall } from "../../types";
import { parseAndValidateToolArgs } from "./args";

function createToolCall(toolArguments: unknown): TToolCall {
  return {
    id: "tool-call",
    name: "test-tool",
    arguments: toolArguments,
  };
}

describe("parseAndValidateToolArgs", () => {
  const schema = z.object({
    name: z.string(),
  });

  test("returns parsed data for valid arguments", () => {
    const result = parseAndValidateToolArgs(createToolCall({ name: "job" }), schema);

    expect(result).toEqual({
      success: true,
      data: { name: "job" },
    });
  });

  test("returns error for an invalid argument type", () => {
    const result = parseAndValidateToolArgs(createToolCall("invalid"), schema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Arguments validation failed");
    }
  });

  test("returns error for invalid arguments", () => {
    const result = parseAndValidateToolArgs(createToolCall({ name: 123 }), schema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Arguments validation failed");
    }
  });
});
