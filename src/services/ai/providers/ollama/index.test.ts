import { describe, expect, test } from "bun:test";
import type { ChatMessageToolCall, ToolDefinitionJson } from "@openrouter/sdk/models";
import { EAssistantLoopConversationItemKind, type TRequestAssistantTurnArgs } from "../../runtime";
import { defineMessageImportanceTool } from "../../tools/define-message-importance/definition";
import { EModelPurpose, ERole, type TToolEntry } from "../../types";
import { buildOllamaMessages, buildOllamaSystemContent } from "./index";

function createToolEntry(definition: ToolDefinitionJson): TToolEntry {
  return {
    definition,
    instructions: "Use this test tool carefully.",
  };
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

function createArgs(user: TRequestAssistantTurnArgs["user"]): TRequestAssistantTurnArgs {
  const toolCall = createToolCall(
    "call-1",
    "define-message-importance",
    JSON.stringify({ importance: "high", reasoning: "contains useful facts" }),
  );

  return {
    history: [{ role: ERole.Assistant, content: "Earlier answer" }],
    user,
    tools: [createToolEntry(defineMessageImportanceTool)],
    purpose: EModelPurpose.Chat,
    conversation: [
      {
        kind: EAssistantLoopConversationItemKind.UserPrompt,
        prompt: {
          role: ERole.User,
          content: [{ type: "text", text: "Remember this" }],
        },
      },
      {
        kind: EAssistantLoopConversationItemKind.AssistantToolCalls,
        content: "",
        toolCalls: [toolCall],
      },
      {
        kind: EAssistantLoopConversationItemKind.ToolResult,
        result: {
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          success: true,
          data: { importance: "high" },
          error: undefined,
        },
      },
      {
        kind: EAssistantLoopConversationItemKind.AssistantReply,
        content: "Marked as important.",
      },
    ],
  };
}

describe("Ollama provider helpers", () => {
  test("builds system content with user context only when provided", () => {
    const withUser = buildOllamaSystemContent(
      createArgs({
        id: "user-1",
        username: "wanna",
        displayName: "Misiaczek",
      }),
      "Base system text",
    );
    const withoutUser = buildOllamaSystemContent(createArgs(undefined), "Base system text");

    expect(withUser).toContain("Base system text");
    expect(withUser).toContain("user_id: user-1");
    expect(withUser).toContain("Use this test tool carefully.");
    expect(withoutUser).toContain("Base system text");
    expect(withoutUser).toContain("Use this test tool carefully.");
    expect(withoutUser).not.toContain("user_id:");
  });

  test("builds Ollama messages with parsed tool arguments", () => {
    const messages = buildOllamaMessages(
      createArgs({
        id: "user-1",
        username: "wanna",
        displayName: "Misiaczek",
      }),
    );

    expect(messages[0]).toEqual({ role: ERole.Assistant, content: "Earlier answer" });
    expect(messages[1]).toEqual({ role: ERole.User, content: "Remember this" });
    expect(messages[2]).toEqual({
      role: ERole.Assistant,
      content: "",
      tool_calls: [
        {
          function: {
            name: "define-message-importance",
            arguments: { importance: "high", reasoning: "contains useful facts" },
          },
        },
      ],
    });
    expect(messages[3]).toMatchObject({
      role: "tool",
      tool_name: "define-message-importance",
    });
    expect(messages[3]?.content).toContain('"toolCallId": "call-1"');
    expect(messages[4]).toEqual({ role: ERole.Assistant, content: "Marked as important." });
  });
});
