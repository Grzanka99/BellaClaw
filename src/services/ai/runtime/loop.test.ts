import { describe, expect, test } from "bun:test";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { DefaultConfigRecord } from "../../settings/schema";
import { defineMessageImportanceTool } from "../tools/define-message-importance/definition";
import { EModelPurpose, ERole, type TPrompt } from "../types";
import { runAssistantToolLoop } from "./loop";
import { EAssistantLoopStopReason, type TRunAssistantToolLoopArgs } from "./types";

function createPrompt(text: string): TPrompt {
  return {
    role: ERole.User,
    content: [{ type: "text", text }],
  };
}

function createLoopArgs(overrides: Partial<TRunAssistantToolLoopArgs>): TRunAssistantToolLoopArgs {
  return {
    prompt: createPrompt("Remember that I like simple tests."),
    history: [],
    user: {
      id: "user-1",
      username: "wanna",
      displayName: "Misiaczek",
    },
    tools: [{ definition: defineMessageImportanceTool }],
    purpose: EModelPurpose.Chat,
    chatId: "user-1",
    settings: DefaultConfigRecord,
    requestAssistantTurn: async () => fauxAssistantMessage(""),
    ...overrides,
  };
}

function createImportanceToolMessage(
  id: string,
  importance: string,
  reasoning: string,
): AssistantMessage {
  return fauxAssistantMessage(
    fauxToolCall("define-message-importance", { importance, reasoning }, { id }),
    { stopReason: "toolUse" },
  );
}

describe("runAssistantToolLoop", () => {
  test("returns a final assistant response and preserves the full assistant message", async () => {
    const assistantMessage = fauxAssistantMessage(
      [fauxThinking("private reasoning"), fauxText("First block."), fauxText("Second block.")],
      { responseId: "response-1" },
    );
    assistantMessage.responseModel = "routed-model";
    assistantMessage.content[0] = {
      type: "thinking",
      thinking: "private reasoning",
      thinkingSignature: "thinking-signature",
    };
    assistantMessage.content[1] = {
      type: "text",
      text: "First block.",
      textSignature: "text-signature",
    };

    const result = await runAssistantToolLoop(
      createLoopArgs({
        tools: [],
        requestAssistantTurn: async () => assistantMessage,
      }),
    );

    expect(result.stopReason).toBe(EAssistantLoopStopReason.FinalResponse);
    expect(result.finalResponse).toBe("First block.\nSecond block.");
    expect(result.iterations).toBe(1);
    expect(result.toolActivity).toEqual([]);
    expect(result.conversation[1]).toBe(assistantMessage);
    expect(JSON.stringify(result.conversation)).not.toContain("private user prompt");
  });

  test("feeds Pi tool results into the next assistant turn without rebuilding the assistant", async () => {
    let turn = 0;
    let sawToolResult = false;
    const toolMessage = createImportanceToolMessage("importance-call", "high", "user preference");
    toolMessage.content[0] = {
      type: "toolCall",
      id: "importance-call",
      name: "define-message-importance",
      arguments: { importance: "high", reasoning: "user preference" },
      thoughtSignature: "tool-thought-signature",
    };

    const result = await runAssistantToolLoop(
      createLoopArgs({
        requestAssistantTurn: async ({ conversation }) => {
          if (turn === 0) {
            turn += 1;
            return toolMessage;
          }

          const resultMessage = conversation.find((message) => message.role === "toolResult");
          sawToolResult =
            resultMessage?.role === "toolResult" &&
            resultMessage.toolCallId === "importance-call" &&
            !resultMessage.isError &&
            resultMessage.content[0]?.type === "text" &&
            resultMessage.content[0].text.includes('"success": true');

          return fauxAssistantMessage("Marked as high importance.");
        },
      }),
    );

    expect(sawToolResult).toBe(true);
    expect(result.conversation[1]).toBe(toolMessage);
    expect(result.stopReason).toBe(EAssistantLoopStopReason.FinalResponse);
    expect(result.finalResponse).toBe("Marked as high importance.");
    expect(result.iterations).toBe(2);
    expect(result.toolActivity).toHaveLength(1);
    expect(result.toolActivity[0]?.toolResults[0]).toMatchObject({
      toolCallId: "importance-call",
      toolName: "define-message-importance",
      success: true,
      data: { importance: "high", reasoning: "user preference" },
    });
  });

  test("executes multiple tool calls sequentially in source order", async () => {
    let turn = 0;

    const result = await runAssistantToolLoop(
      createLoopArgs({
        requestAssistantTurn: async ({ conversation }) => {
          turn += 1;

          if (turn === 1) {
            return fauxAssistantMessage(
              [
                fauxToolCall(
                  "define-message-importance",
                  { importance: "high", reasoning: "first" },
                  { id: "first-call" },
                ),
                fauxToolCall(
                  "define-message-importance",
                  { importance: "low", reasoning: "second" },
                  { id: "second-call" },
                ),
              ],
              { stopReason: "toolUse" },
            );
          }

          const toolResultIds = conversation
            .filter((message) => message.role === "toolResult")
            .map((message) => message.toolCallId);
          expect(toolResultIds).toEqual(["first-call", "second-call"]);

          return fauxAssistantMessage("Both calls completed.");
        },
      }),
    );

    expect(result.toolActivity[0]?.toolCalls.map((toolCall) => toolCall.id)).toEqual([
      "first-call",
      "second-call",
    ]);
    expect(result.toolActivity[0]?.toolResults.map((toolResult) => toolResult.toolCallId)).toEqual([
      "first-call",
      "second-call",
    ]);
    expect(result.finalResponse).toBe("Both calls completed.");
  });

  test("stops when structured tool arguments repeat with different key order", async () => {
    let turn = 0;

    const result = await runAssistantToolLoop(
      createLoopArgs({
        maxIterations: 3,
        requestAssistantTurn: async () => {
          turn += 1;

          if (turn === 1) {
            return fauxAssistantMessage(
              fauxToolCall(
                "define-message-importance",
                { importance: "medium", reasoning: "same request" },
                { id: "repeat-call-1" },
              ),
              { stopReason: "toolUse" },
            );
          }

          return fauxAssistantMessage(
            fauxToolCall(
              "define-message-importance",
              { reasoning: "same request", importance: "medium" },
              { id: "repeat-call-2" },
            ),
            { stopReason: "toolUse" },
          );
        },
      }),
    );

    expect(result.stopReason).toBe(EAssistantLoopStopReason.RepeatedToolCall);
    expect(result.finalResponse).toBeUndefined();
    expect(result.iterations).toBe(2);
    expect(result.toolActivity).toHaveLength(1);
    expect(result.conversation[3]?.role).toBe("assistant");
  });

  test("allows four tool turns before one tool-free final request", async () => {
    let requestCount = 0;

    const result = await runAssistantToolLoop(
      createLoopArgs({
        requestAssistantTurn: async ({ tools }) => {
          requestCount += 1;

          if (tools.length === 0) {
            return fauxAssistantMessage("Final after tool limit.");
          }

          return createImportanceToolMessage(
            `call-${requestCount}`,
            "low",
            `request ${requestCount}`,
          );
        },
      }),
    );

    expect(requestCount).toBe(5);
    expect(result.stopReason).toBe(EAssistantLoopStopReason.MaxIterations);
    expect(result.finalResponse).toBe("Final after tool limit.");
    expect(result.iterations).toBe(4);
    expect(result.toolActivity).toHaveLength(4);
  });

  test("rejects final tool calls and retries exactly once without tools", async () => {
    let requestCount = 0;

    const result = await runAssistantToolLoop(
      createLoopArgs({
        maxIterations: 1,
        requestAssistantTurn: async ({ conversation, tools }) => {
          requestCount += 1;

          if (tools.length > 0) {
            return createImportanceToolMessage("first-call", "low", "first request");
          }

          if (requestCount === 2) {
            return createImportanceToolMessage("extra-call", "medium", "extra request");
          }

          const rejectedResult = conversation.find((message) => {
            return (
              message.role === "toolResult" &&
              message.toolCallId === "extra-call" &&
              message.isError
            );
          });

          if (rejectedResult !== undefined) {
            return fauxAssistantMessage("Final after rejected tool call.");
          }

          return fauxAssistantMessage("");
        },
      }),
    );

    expect(requestCount).toBe(3);
    expect(result.stopReason).toBe(EAssistantLoopStopReason.MaxIterations);
    expect(result.finalResponse).toBe("Final after rejected tool call.");
    expect(result.toolActivity).toHaveLength(1);
  });

  test("rejects a stop/tool-call mismatch in a forced final request", async () => {
    let requestCount = 0;

    const result = await runAssistantToolLoop(
      createLoopArgs({
        maxIterations: 1,
        requestAssistantTurn: async ({ tools }) => {
          requestCount += 1;

          if (tools.length > 0) {
            return createImportanceToolMessage("first-call", "low", "first request");
          }

          if (requestCount === 2) {
            return fauxAssistantMessage([
              fauxText("Premature final text."),
              fauxToolCall(
                "define-message-importance",
                { importance: "medium", reasoning: "mismatched final call" },
                { id: "mismatched-final-call" },
              ),
            ]);
          }

          return fauxAssistantMessage("Final after mismatched call.");
        },
      }),
    );

    expect(requestCount).toBe(3);
    expect(result.stopReason).toBe(EAssistantLoopStopReason.MaxIterations);
    expect(result.finalResponse).toBe("Final after mismatched call.");
    expect(
      result.conversation.some((message) => {
        return (
          message.role === "toolResult" &&
          message.toolCallId === "mismatched-final-call" &&
          message.isError
        );
      }),
    ).toBe(true);
  });

  test("returns non-empty length output without executing truncated tool calls", async () => {
    const result = await runAssistantToolLoop(
      createLoopArgs({
        requestAssistantTurn: async () => {
          return fauxAssistantMessage(
            [
              fauxText("Partial response."),
              fauxToolCall(
                "define-message-importance",
                { importance: "high", reasoning: "truncated" },
                { id: "truncated-call" },
              ),
            ],
            { stopReason: "length" },
          );
        },
      }),
    );

    expect(result.stopReason).toBe(EAssistantLoopStopReason.OutputLimit);
    expect(result.finalResponse).toBe("Partial response.");
    expect(result.toolActivity).toEqual([]);
    expect(result.conversation).toHaveLength(2);
  });

  test("returns output-limit without a response for empty length output", async () => {
    const result = await runAssistantToolLoop(
      createLoopArgs({
        requestAssistantTurn: async () => fauxAssistantMessage("", { stopReason: "length" }),
      }),
    );

    expect(result.stopReason).toBe(EAssistantLoopStopReason.OutputLimit);
    expect(result.finalResponse).toBeUndefined();
    expect(result.toolActivity).toEqual([]);
  });

  test("does not execute tool calls when a stop response contains a mismatched call", async () => {
    const result = await runAssistantToolLoop(
      createLoopArgs({
        requestAssistantTurn: async () => {
          return fauxAssistantMessage([
            fauxText("Use this final response."),
            fauxToolCall(
              "define-message-importance",
              { importance: "high", reasoning: "mismatch" },
              { id: "mismatched-call" },
            ),
          ]);
        },
      }),
    );

    expect(result.stopReason).toBe(EAssistantLoopStopReason.FinalResponse);
    expect(result.finalResponse).toBe("Use this final response.");
    expect(result.toolActivity).toEqual([]);
    expect(result.conversation).toHaveLength(2);
  });

  test("returns a distinct aborted stop reason", async () => {
    const result = await runAssistantToolLoop(
      createLoopArgs({
        requestAssistantTurn: async () => {
          return fauxAssistantMessage("Partial aborted text", {
            stopReason: "aborted",
            errorMessage: "request aborted",
          });
        },
      }),
    );

    expect(result.stopReason).toBe(EAssistantLoopStopReason.Aborted);
    expect(result.finalResponse).toBeUndefined();
    expect(result.conversation).toHaveLength(2);
  });

  test("treats toolUse without a tool call as malformed", async () => {
    const result = await runAssistantToolLoop(
      createLoopArgs({
        requestAssistantTurn: async () => {
          return fauxAssistantMessage("", { stopReason: "toolUse" });
        },
      }),
    );

    expect(result.stopReason).toBe(EAssistantLoopStopReason.MalformedProviderResponse);
    expect(result.finalResponse).toBeUndefined();
  });
});
