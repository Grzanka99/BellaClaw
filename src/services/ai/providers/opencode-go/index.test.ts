import { describe, expect, test } from "bun:test";
import type { ChatMessageToolCall, ToolDefinitionJson } from "@openrouter/sdk/models";
import { DefaultConfigRecord } from "../../../settings/schema";
import { EAssistantLoopConversationItemKind, type TRequestAssistantTurnArgs } from "../../runtime";
import { defineMessageImportanceTool } from "../../tools/define-message-importance/definition";
import { EModelPurpose, ERole, type TToolEntry } from "../../types";
import { buildOpencodeGoMessages, normalizeOpencodeGoToolCalls, opencodeGoChat } from "./index";

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
    settings: DefaultConfigRecord,
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

describe("buildOpencodeGoMessages", () => {
  test("uses OpenAI wire fields and serializes prompt and tool results", () => {
    const messages = buildOpencodeGoMessages(
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
    expect(messages[4]).toEqual({ role: ERole.User, content: "Remember this" });
    expect(messages[5]).toMatchObject({
      role: ERole.Assistant,
      content: null,
      tool_calls: [
        {
          id: "call-1",
          function: { name: "define-message-importance" },
        },
      ],
    });
    expect(messages[6]).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
    });
    expect(messages[6]?.content).toContain('"success": true');
    expect(messages[7]).toEqual({ role: ERole.Assistant, content: "Marked as important." });
  });

  test("omits user context when no user is provided", () => {
    const messages = buildOpencodeGoMessages(createArgs(undefined), "Base system text");

    expect(messages[0]).toEqual({ role: ERole.System, content: "Base system text" });
    expect(
      messages.some(
        (message) => typeof message.content === "string" && message.content.includes("user_id:"),
      ),
    ).toBe(false);
  });
});

describe("normalizeOpencodeGoToolCalls", () => {
  test("stringifies object arguments", () => {
    const toolCalls = normalizeOpencodeGoToolCalls([
      {
        id: "call-1",
        type: "function",
        function: {
          name: "search-memory",
          arguments: { query: "Bella" },
        },
      },
    ]);

    expect(toolCalls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: {
          name: "search-memory",
          arguments: '{\n  "query": "Bella"\n}',
        },
      },
    ]);
  });
});

describe("opencodeGoChat", () => {
  test("sends OpenAI-compatible request and validates normal response", async () => {
    let requestBody: unknown;
    let contentType: string | undefined;
    let authorization: string | undefined;

    const fetchFn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestBody = JSON.parse(String(init?.body));
      if (!(init?.headers instanceof Headers) && !Array.isArray(init?.headers)) {
        const headers = init?.headers;

        if (typeof headers?.["Content-Type"] === "string") {
          contentType = headers["Content-Type"];
        }

        if (typeof headers?.Authorization === "string") {
          authorization = headers.Authorization;
        }
      }

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Hello", tool_calls: [] } }],
        }),
        { status: 200 },
      );
    };

    const response = await opencodeGoChat({ model: "kimi-k2.6", stream: false }, fetchFn);

    expect(requestBody).toEqual({ model: "kimi-k2.6", stream: false });
    expect(contentType).toBe("application/json");
    expect(authorization).toContain("Bearer ");
    expect(response.choices[0]?.message?.content).toBe("Hello");
  });

  test("throws on malformed response", async () => {
    const fetchFn = async (): Promise<Response> =>
      new Response(JSON.stringify({ choices: "not an array" }), { status: 200 });

    await expect(opencodeGoChat({ model: "kimi-k2.6" }, fetchFn)).rejects.toThrow(
      "Malformed OpenCode Go chat response",
    );
  });
});
