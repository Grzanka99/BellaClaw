import { describe, expect, test } from "bun:test";
import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { handleDefineSettingsIntent, SDefineSettingsIntent } from "./handler";

function createToolCall(id: string, argumentsText: string): ChatMessageToolCall {
  return {
    id,
    type: "function",
    function: {
      name: "define-settings-intent",
      arguments: argumentsText,
    },
  };
}

describe("handleDefineSettingsIntent", () => {
  test("parses valid settings intent", () => {
    const result = handleDefineSettingsIntent(
      createToolCall("call-1", JSON.stringify({ intent: "settings", reason: "change timezone" })),
    );

    expect(result).toEqual({ intent: "settings", reason: "change timezone" });
  });

  test("parses valid normal intent", () => {
    const result = handleDefineSettingsIntent(
      createToolCall("call-2", JSON.stringify({ intent: "normal", reason: "casual greeting" })),
    );

    expect(result).toEqual({ intent: "normal", reason: "casual greeting" });
  });

  test("returns undefined for invalid JSON", () => {
    const result = handleDefineSettingsIntent(createToolCall("call-3", "{"));

    expect(result).toBeUndefined();
  });

  test("returns undefined for invalid intent enum value", () => {
    const result = handleDefineSettingsIntent(
      createToolCall("call-4", JSON.stringify({ intent: "unknown", reason: "test" })),
    );

    expect(result).toBeUndefined();
  });

  test("returns undefined when reason is missing", () => {
    const result = handleDefineSettingsIntent(
      createToolCall("call-5", JSON.stringify({ intent: "settings" })),
    );

    expect(result).toBeUndefined();
  });

  test("SDefineSettingsIntent accepts settings and normal intents", () => {
    expect(SDefineSettingsIntent.safeParse({ intent: "settings", reason: "r" }).success).toBe(true);
    expect(SDefineSettingsIntent.safeParse({ intent: "normal", reason: "r" }).success).toBe(true);
  });

  test("SDefineSettingsIntent rejects unknown intent values", () => {
    expect(SDefineSettingsIntent.safeParse({ intent: "other", reason: "r" }).success).toBe(false);
  });
});
