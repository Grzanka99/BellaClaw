import { describe, expect, test } from "bun:test";
import type { ChatMessageToolCall, ToolDefinitionJson } from "@openrouter/sdk/models";
import { EAssistantLoopConversationItemKind, type TRequestAssistantTurnArgs } from "../../runtime";
import { defineMessageImportanceTool } from "../../tools/define-message-importance/definition";
import { EModelPurpose, ERole, type TToolEntry } from "../../types";
import { buildOpenrouterMessages } from "./index";

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

describe("buildOpenrouterMessages", () => {
  test("includes user context and serializes tool calls and results", () => {
    const messages = buildOpenrouterMessages(
      createArgs({
        id: "user-1",
        username: "wanna",
        displayName: "Misiaczek",
      }),
      "Base system text",
    );

    expect(messages[0]).toEqual({ role: ERole.System, content: "Base system text" });
    expect(messages[1]?.content).toContain("user_id: user-1");
    expect(messages[2]).toEqual({ role: ERole.Assistant, content: "Earlier answer" });
    expect(messages[3]).toEqual({ role: ERole.System, content: "Use this test tool carefully." });
    expect(messages[4]).toEqual({
      role: ERole.User,
      content: [{ type: "text", text: "Remember this" }],
    });
    expect(messages[5]).toMatchObject({
      role: ERole.Assistant,
      toolCalls: [
        {
          id: "call-1",
          function: { name: "define-message-importance" },
        },
      ],
    });
    expect(messages[6]).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
    });
    expect(messages[6]?.content).toContain('"success": true');
    expect(messages[7]).toEqual({ role: ERole.Assistant, content: "Marked as important." });
  });

  test("omits user context when no user is provided", () => {
    const messages = buildOpenrouterMessages(createArgs(undefined), "Base system text");

    expect(messages[0]).toEqual({ role: ERole.System, content: "Base system text" });
    expect(messages.some((message) => message.content === "user_id: user-1")).toBe(false);
    expect(messages.some((message) => String(message.content).includes("user_id:"))).toBe(false);
  });
});
