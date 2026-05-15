import { describe, expect, test } from "bun:test";
import type { ChatMessageToolCall, ToolDefinitionJson } from "@openrouter/sdk/models";
import { defineMessageImportanceTool } from "../tools/define-message-importance/definition";
import { EModelPurpose, ERole, type TPrompt, type TToolEntry } from "../types";
import { runToolTask } from "./tool-task";
import type { TRunToolTaskArgs } from "./types";

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

function createArgs(overrides: Partial<TRunToolTaskArgs>): TRunToolTaskArgs {
  return {
    prompt: createPrompt("Classify this message."),
    history: [],
    tools: [createToolEntry(defineMessageImportanceTool)],
    purpose: EModelPurpose.ToolCheap,
    chatId: undefined,
    user: {
      id: "user-1",
      username: "wanna",
      displayName: "Misiaczek",
    },
    requestAssistantTurn: async () => ({ response: "", toolCalls: [] }),
    ...overrides,
  };
}

describe("runToolTask", () => {
  test("returns normalized tool results for a valid tool call", async () => {
    const result = await runToolTask(
      createArgs({
        requestAssistantTurn: async () => ({
          response: "I will classify it.",
          toolCalls: [
            createToolCall(
              "importance-call",
              "define-message-importance",
              JSON.stringify({ importance: "high", reasoning: "contains stable preference" }),
            ),
          ],
        }),
      }),
    );

    expect(result).toEqual({
      assistantResponse: "I will classify it.",
      toolCalls: [
        {
          id: "importance-call",
          type: "function",
          function: {
            name: "define-message-importance",
            arguments: JSON.stringify({
              importance: "high",
              reasoning: "contains stable preference",
            }),
          },
        },
      ],
      toolResults: [
        {
          toolCallId: "importance-call",
          toolName: "define-message-importance",
          success: true,
          data: { importance: "high", reasoning: "contains stable preference" },
          error: undefined,
        },
      ],
    });
  });

  test("returns normalized failures for invalid JSON tool arguments", async () => {
    const result = await runToolTask(
      createArgs({
        requestAssistantTurn: async () => ({
          response: "Trying tool call.",
          toolCalls: [createToolCall("bad-json", "define-message-importance", "{")],
        }),
      }),
    );

    expect(result.assistantResponse).toBe("Trying tool call.");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      toolCallId: "bad-json",
      toolName: "define-message-importance",
      success: false,
    });
    expect(result.toolResults[0]?.error).toContain("Invalid JSON arguments");
  });

  test("works when user is undefined", async () => {
    let receivedUser: TRunToolTaskArgs["user"];

    const result = await runToolTask(
      createArgs({
        user: undefined,
        requestAssistantTurn: async (args) => {
          receivedUser = args.user;

          return {
            response: "No user context needed.",
            toolCalls: [],
          };
        },
      }),
    );

    expect(receivedUser).toBeUndefined();
    expect(result).toEqual({
      assistantResponse: "No user context needed.",
      toolCalls: [],
      toolResults: [],
    });
  });
});
