import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { DefaultConfigRecord } from "../../settings/schema";
import { defineMessageImportanceTool } from "../tools/define-message-importance/definition";
import { EModelPurpose, ERole, type TPrompt } from "../types";
import { runToolTask } from "./tool-task";
import type { TRunToolTaskArgs } from "./types";

function createPrompt(text: string): TPrompt {
  return {
    role: ERole.User,
    content: [{ type: "text", text }],
  };
}

function createArgs(overrides: Partial<TRunToolTaskArgs>): TRunToolTaskArgs {
  return {
    prompt: createPrompt("Classify this message."),
    history: [],
    tools: [{ definition: defineMessageImportanceTool }],
    purpose: EModelPurpose.ToolCheap,
    chatId: undefined,
    user: {
      id: "user-1",
      username: "wanna",
      displayName: "Misiaczek",
    },
    settings: DefaultConfigRecord,
    requestAssistantTurn: async () => fauxAssistantMessage(""),
    ...overrides,
  };
}

describe("runToolTask", () => {
  test("makes one request and returns normalized tool results", async () => {
    let requestCount = 0;

    const result = await runToolTask(
      createArgs({
        requestAssistantTurn: async () => {
          requestCount += 1;
          return fauxAssistantMessage(
            [
              fauxText("I will classify it."),
              fauxToolCall(
                "define-message-importance",
                { importance: "high", reasoning: "contains stable preference" },
                { id: "importance-call" },
              ),
            ],
            { stopReason: "toolUse" },
          );
        },
      }),
    );

    expect(requestCount).toBe(1);
    expect(result).toEqual({
      assistantResponse: "I will classify it.",
      toolCalls: [
        {
          id: "importance-call",
          name: "define-message-importance",
          arguments: {
            importance: "high",
            reasoning: "contains stable preference",
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

  test("returns normalized failures for invalid structured tool arguments", async () => {
    const result = await runToolTask(
      createArgs({
        requestAssistantTurn: async () => {
          return fauxAssistantMessage(
            fauxToolCall(
              "define-message-importance",
              { importance: 42, reasoning: "wrong type" },
              { id: "invalid-arguments" },
            ),
            { stopReason: "toolUse" },
          );
        },
      }),
    );

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      toolCallId: "invalid-arguments",
      toolName: "define-message-importance",
      success: false,
    });
    expect(result.toolResults[0]?.error).toContain("Arguments validation failed");
  });

  test("never executes calls from length or stop responses", async () => {
    for (const stopReason of ["length", "stop"] as const) {
      const result = await runToolTask(
        createArgs({
          requestAssistantTurn: async () => {
            return fauxAssistantMessage(
              [
                fauxText("Partial text."),
                fauxToolCall(
                  "define-message-importance",
                  { importance: "high", reasoning: "must not execute" },
                  { id: `ignored-${stopReason}` },
                ),
              ],
              { stopReason },
            );
          },
        }),
      );

      expect(result.assistantResponse).toBe("Partial text.");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolResults).toEqual([]);
    }
  });

  test("returns no partial response or results after abort", async () => {
    const result = await runToolTask(
      createArgs({
        requestAssistantTurn: async () => {
          return fauxAssistantMessage(
            [
              fauxText("Unsafe partial text."),
              fauxToolCall(
                "define-message-importance",
                { importance: "high", reasoning: "must not execute" },
                { id: "aborted-call" },
              ),
            ],
            { stopReason: "aborted", errorMessage: "request aborted" },
          );
        },
      }),
    );

    expect(result.assistantResponse).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolResults).toEqual([]);
  });

  test("works when user is undefined", async () => {
    let receivedUser: TRunToolTaskArgs["user"];

    const result = await runToolTask(
      createArgs({
        user: undefined,
        requestAssistantTurn: async (args) => {
          receivedUser = args.user;
          return fauxAssistantMessage("No user context needed.");
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
