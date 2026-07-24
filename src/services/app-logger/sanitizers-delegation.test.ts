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

  test("keeps bounded useful delegation task and response previews while redacting secrets", () => {
    Bun.env.OPENROUTER_API_KEY = "super-secret";
    const longText = `summarize super-secret ${"detail ".repeat(80)}`;
    const args = sanitizeToolCallArguments({
      id: "call-1",
      name: "delegate-memory",
      arguments: { task: longText },
    });
    const result = sanitizeToolResult({
      toolCallId: "call-1",
      toolName: "delegate-memory",
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
