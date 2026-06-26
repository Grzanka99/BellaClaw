import { describe, expect, test } from "bun:test";
import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { handleDefineSettingsIntent, SDefineSettingsIntent } from "./handler";

function createToolCall(argumentsText: string): ChatMessageToolCall {
  return {
    id: "call-empty-reason",
    type: "function",
    function: {
      name: "define-settings-intent",
      arguments: argumentsText,
    },
  };
}

describe("define-settings-intent reason validation", () => {
  test("rejects empty reason strings", () => {
    expect(SDefineSettingsIntent.safeParse({ intent: "settings", reason: "" }).success).toBe(false);

    const result = handleDefineSettingsIntent(
      createToolCall(JSON.stringify({ intent: "settings", reason: "" })),
    );

    expect(result).toBeUndefined();
  });
});
