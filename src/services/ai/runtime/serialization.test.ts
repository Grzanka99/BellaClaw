import { describe, expect, test } from "bun:test";
import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import { ERole, type TPrompt } from "../types";
import {
  buildToolCallBatchSignature,
  extractTextContent,
  normalizeError,
  parseArgumentsForOllama,
  promptToText,
  serializeForModel,
} from "./serialization";

function createToolCall(id: string, name: string, argumentsText: string): ChatMessageToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: argumentsText,
    },
  };
}

describe("runtime serialization", () => {
  test("converts prompt and provider content into text", () => {
    const prompt: TPrompt = {
      role: ERole.User,
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };

    expect(promptToText(prompt)).toBe("first\nsecond");
    expect(extractTextContent("plain response")).toBe("plain response");
    expect(
      extractTextContent([
        { type: "text", text: "first" },
        { type: "image", text: "ignored" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  test("serializes model payloads and normalizes errors", () => {
    const date = new Date("2026-05-07T12:00:00.000Z");

    expect(serializeForModel({ date })).toContain("2026-05-07T12:00:00.000Z");
    expect(serializeForModel(undefined)).toBe("undefined");
    expect(normalizeError(new Error("broken"))).toBe("broken");
    expect(normalizeError({ reason: "bad" })).toContain("bad");
  });

  test("prepares Ollama arguments and repeated-call signatures", () => {
    const firstCall = createToolCall("call-1", "tool-a", '{"value":1}');
    const secondCall = createToolCall("call-2", "tool-b", "not-json");

    expect(parseArgumentsForOllama(firstCall.function.arguments)).toEqual({ value: 1 });
    expect(parseArgumentsForOllama(secondCall.function.arguments)).toEqual({
      rawArguments: "not-json",
    });
    expect(parseArgumentsForOllama("[]")).toEqual({ rawArguments: "[]" });
    expect(buildToolCallBatchSignature([firstCall, secondCall])).toBe(
      'tool-a:{"value":1}\ntool-b:not-json',
    );
  });
});
