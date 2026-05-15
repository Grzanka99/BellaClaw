import { describe, expect, test } from "bun:test";
import type { ChatMessageToolCall, ToolDefinitionJson } from "@openrouter/sdk/models";
import { defineMessageImportanceTool } from "../tools/define-message-importance/definition";
import { EModelPurpose, ERole, type TPrompt, type TToolEntry } from "../types";
import { runAssistantToolLoop } from "./loop";
import {
  EAssistantLoopConversationItemKind,
  EAssistantLoopStopReason,
  type TRunAssistantToolLoopArgs,
} from "./types";

function createPrompt(text: string): TPrompt {
  return {
    role: ERole.User,
    content: [{ type: "text", text }],
  };
}

function createToolEntry(definition: ToolDefinitionJson): TToolEntry {
  return { definition };
}

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

function createLoopArgs(overrides: Partial<TRunAssistantToolLoopArgs>): TRunAssistantToolLoopArgs {
  return {
    prompt: createPrompt("Remember that I like simple tests."),
    history: [],
    user: {
      id: "user-1",
      username: "wanna",
      displayName: "Misiaczek",
    },
    tools: [createToolEntry(defineMessageImportanceTool)],
    purpose: EModelPurpose.Chat,
    chatId: "user-1",
    requestAssistantTurn: async () => ({ response: "", toolCalls: [] }),
    ...overrides,
  };
}

describe("runAssistantToolLoop", () => {
  test("returns a final assistant response when no tools are requested", async () => {
    const result = await runAssistantToolLoop(
      createLoopArgs({
        tools: [],
        requestAssistantTurn: async () => ({ response: "Final answer.", toolCalls: [] }),
      }),
    );

    expect(result.stopReason).toBe(EAssistantLoopStopReason.FinalResponse);
    expect(result.finalResponse).toBe("Final answer.");
    expect(result.iterations).toBe(1);
    expect(result.toolActivity).toEqual([]);
    expect(result.conversation.map((item) => item.kind)).toEqual([
      EAssistantLoopConversationItemKind.UserPrompt,
      EAssistantLoopConversationItemKind.AssistantReply,
    ]);
  });

  test("feeds tool results into the next assistant turn", async () => {
    let turn = 0;
    let sawToolResult = false;

    const result = await runAssistantToolLoop(
      createLoopArgs({
        requestAssistantTurn: async ({ conversation }) => {
          if (turn === 0) {
            turn += 1;

            return {
              response: "",
              toolCalls: [
                createToolCall(
                  "importance-call",
                  "define-message-importance",
                  JSON.stringify({ importance: "high", reasoning: "user preference" }),
                ),
              ],
            };
          }

          sawToolResult = conversation.some((item) => {
            if (item.kind !== EAssistantLoopConversationItemKind.ToolResult) {
              return false;
            }

            return item.result.success && item.result.toolCallId === "importance-call";
          });

          return { response: "Marked as high importance.", toolCalls: [] };
        },
      }),
    );

    expect(sawToolResult).toBe(true);
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
    expect(result.conversation.map((item) => item.kind)).toEqual([
      EAssistantLoopConversationItemKind.UserPrompt,
      EAssistantLoopConversationItemKind.AssistantToolCalls,
      EAssistantLoopConversationItemKind.ToolResult,
      EAssistantLoopConversationItemKind.AssistantReply,
    ]);
  });

  test("stops when a tool call repeats without progress", async () => {
    const result = await runAssistantToolLoop(
      createLoopArgs({
        maxIterations: 3,
        requestAssistantTurn: async () => ({
          response: "",
          toolCalls: [
            createToolCall(
              "repeat-call",
              "define-message-importance",
              JSON.stringify({ importance: "medium", reasoning: "same request" }),
            ),
          ],
        }),
      }),
    );

    expect(result.stopReason).toBe(EAssistantLoopStopReason.RepeatedToolCall);
    expect(result.finalResponse).toBeUndefined();
    expect(result.iterations).toBe(2);
    expect(result.toolActivity).toHaveLength(1);
  });

  test("stops at the max iteration guard", async () => {
    let turn = 0;

    const result = await runAssistantToolLoop(
      createLoopArgs({
        maxIterations: 2,
        requestAssistantTurn: async () => {
          turn += 1;

          return {
            response: "",
            toolCalls: [
              createToolCall(
                `call-${turn}`,
                "define-message-importance",
                JSON.stringify({ importance: "low", reasoning: `request ${turn}` }),
              ),
            ],
          };
        },
      }),
    );

    expect(result.stopReason).toBe(EAssistantLoopStopReason.MaxIterations);
    expect(result.finalResponse).toBeUndefined();
    expect(result.iterations).toBe(2);
    expect(result.toolActivity).toHaveLength(2);
  });
});
