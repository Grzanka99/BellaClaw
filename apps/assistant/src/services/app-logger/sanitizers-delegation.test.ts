import { afterEach, describe, expect, test } from "bun:test";
import { sanitizeToolCallArguments, sanitizeToolResult } from "./sanitizers";

describe("delegation log sanitizers", () => {
  const previousKey = Bun.env.OPENROUTER_API_KEY;

  afterEach(() => {
    if (previousKey === undefined) {
      delete Bun.env.OPENROUTER_API_KEY;
    } else {
      Bun.env.OPENROUTER_API_KEY = previousKey;
    }
  });

  test.each([
    "delegate-memory",
    "delegate-calendar",
    "delegate-settings",
    "delegate-scheduling",
  ])("keeps bounded useful %s previews while redacting secrets", (toolName) => {
    Bun.env.OPENROUTER_API_KEY = "super-secret";
    const longText = `summarize super-secret ${"detail ".repeat(80)}`;
    const args = sanitizeToolCallArguments({
      id: "call-1",
      name: toolName,
      arguments: { task: longText },
    });
    const result = sanitizeToolResult({
      toolCallId: "call-1",
      toolName,
      success: true,
      data: {
        content: [{ type: "text", text: `Found super-secret ${"memory ".repeat(80)}` }],
      },
      error: undefined,
    });
    const serialized = JSON.stringify({ args, result });

    expect(serialized).toContain("summarize");
    expect(serialized).toContain("Found");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("super-secret");
    expect(args.metadata.taskPreview).toEndWith("...");
    expect(result.metadata.responsePreview).toEndWith("...");
  });
});
