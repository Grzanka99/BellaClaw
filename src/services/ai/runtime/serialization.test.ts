import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { ERole, type TPrompt, type TToolCall } from "../types";
import {
  buildToolCallBatchSignature,
  createToolResultMessage,
  extractAssistantText,
  extractAssistantToolCalls,
  normalizeError,
  promptToText,
  promptToUserMessage,
  serializeForModel,
} from "./serialization";

describe("runtime serialization", () => {
  test("converts prompts and extracts only assistant text blocks", () => {
    const prompt: TPrompt = {
      role: ERole.User,
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    const assistantMessage = fauxAssistantMessage([
      fauxThinking("private thinking"),
      fauxText("first"),
      fauxToolCall("ignored-tool", { value: 1 }, { id: "ignored-call" }),
      fauxText("second"),
    ]);

    expect(promptToText(prompt)).toBe("first\nsecond");
    expect(promptToUserMessage(prompt)).toMatchObject({
      role: "user",
      content: prompt.content,
    });
    expect(extractAssistantText(assistantMessage)).toBe("first\nsecond");
  });

  test("preserves structured tool arguments and builds canonical batch signatures", () => {
    const firstCall: TToolCall = {
      id: "call-1",
      name: "tool-a",
      arguments: {
        z: [3, { b: 2, a: 1 }],
        a: true,
      },
    };
    const firstBatch: TToolCall[] = [
      firstCall,
      { id: "call-2", name: "tool-b", arguments: { value: null } },
    ];
    const reorderedBatch: TToolCall[] = [
      {
        id: "different-id",
        name: "tool-a",
        arguments: {
          a: true,
          z: [3, { a: 1, b: 2 }],
        },
      },
      { id: "another-id", name: "tool-b", arguments: { value: null } },
    ];
    const assistantMessage = fauxAssistantMessage(
      fauxToolCall("tool-a", { z: [3, { b: 2, a: 1 }], a: true }, { id: "call-1" }),
      { stopReason: "toolUse" },
    );

    expect(extractAssistantToolCalls(assistantMessage)).toEqual([firstCall]);
    expect(buildToolCallBatchSignature(firstBatch)).toBe(
      buildToolCallBatchSignature(reorderedBatch),
    );
    expect(buildToolCallBatchSignature(firstBatch)).not.toBe(
      buildToolCallBatchSignature(reorderedBatch.toReversed()),
    );
  });

  test("converts normalized results into Pi tool-result messages", () => {
    const normalizedResult = {
      toolCallId: "call-1",
      toolName: "tool-a",
      success: false,
      data: undefined,
      error: "failed safely",
    };

    const message = createToolResultMessage(normalizedResult);

    expect(message).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "tool-a",
      details: normalizedResult,
      isError: true,
    });
    expect(message.content[0]).toMatchObject({ type: "text" });
    expect(message.content[0]?.type === "text" && message.content[0].text).toContain(
      '"success": false',
    );
  });

  test("serializes model payloads and normalizes errors", () => {
    const date = new Date("2026-05-07T12:00:00.000Z");

    expect(serializeForModel({ date })).toContain("2026-05-07T12:00:00.000Z");
    expect(serializeForModel(undefined)).toBe("undefined");
    expect(normalizeError(new Error("broken"))).toBe("broken");
    expect(normalizeError({ reason: "bad" })).toContain("bad");
  });
});
