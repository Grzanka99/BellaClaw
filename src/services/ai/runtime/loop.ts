import type { TOption } from "../../../types";
import { ERole } from "../types";
import { buildToolCallBatchSignature } from "./serialization";
import { executeToolCall } from "./tool-execution";
import { createFailedToolResult } from "./tools/results";
import {
  EAssistantLoopConversationItemKind,
  EAssistantLoopStopReason,
  type TAssistantToolLoopResult,
  type TNormalizedToolResult,
  type TRunAssistantToolLoopArgs,
  type TRuntimeConversationItem,
} from "./types";

const DEFAULT_MAX_ITERATIONS = 4;
const FINAL_RESPONSE_AFTER_TOOL_LIMIT_INSTRUCTION = [
  "The tool-call budget for this turn has been reached.",
  "Do not call or promise more tools.",
  "Give the final user-facing answer now using the tool results already provided.",
  "If the available tool results are insufficient or failed, say that briefly.",
].join(" ");
const TOOL_LIMIT_REACHED_ERROR =
  "Tool-call budget reached; no more tool calls are available. Answer using previous tool results.";

export async function runAssistantToolLoop(
  args: TRunAssistantToolLoopArgs,
): Promise<TAssistantToolLoopResult> {
  const conversation: TRuntimeConversationItem[] = [
    { kind: EAssistantLoopConversationItemKind.UserPrompt, prompt: args.prompt },
  ];

  const toolActivity: TAssistantToolLoopResult["toolActivity"] = [];
  const maxIterations = args.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const allowedToolNames = new Set(args.tools.map((tool) => tool.definition.function.name));
  let lastToolCallBatchSignature: TOption<string>;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const assistantTurn = await args.requestAssistantTurn({
      conversation,
      history: args.history,
      user: args.user,
      tools: args.tools,
      purpose: args.purpose,
    });

    if (assistantTurn === undefined) {
      return {
        conversation,
        toolActivity,
        finalResponse: undefined,
        stopReason: EAssistantLoopStopReason.MalformedProviderResponse,
        iterations: iteration,
      };
    }

    if (assistantTurn.toolCalls.length === 0) {
      if (assistantTurn.response.trim().length === 0) {
        return {
          conversation,
          toolActivity,
          finalResponse: undefined,
          stopReason: EAssistantLoopStopReason.EmptyAssistantResponse,
          iterations: iteration,
        };
      }

      conversation.push({
        kind: EAssistantLoopConversationItemKind.AssistantReply,
        content: assistantTurn.response,
      });

      return {
        conversation,
        toolActivity,
        finalResponse: assistantTurn.response,
        stopReason: EAssistantLoopStopReason.FinalResponse,
        iterations: iteration,
      };
    }

    conversation.push({
      kind: EAssistantLoopConversationItemKind.AssistantToolCalls,
      content: assistantTurn.response,
      toolCalls: assistantTurn.toolCalls,
      reasoningContent: assistantTurn.reasoningContent,
    });

    const toolCallBatchSignature = buildToolCallBatchSignature(assistantTurn.toolCalls);

    if (
      lastToolCallBatchSignature !== undefined &&
      toolCallBatchSignature === lastToolCallBatchSignature
    ) {
      return {
        conversation,
        toolActivity,
        finalResponse: undefined,
        stopReason: EAssistantLoopStopReason.RepeatedToolCall,
        iterations: iteration,
      };
    }

    lastToolCallBatchSignature = toolCallBatchSignature;

    const toolResults: TNormalizedToolResult[] = [];

    for (const toolCall of assistantTurn.toolCalls) {
      const toolResult = await executeToolCall({
        toolCall,
        chatId: args.chatId,
        allowedToolNames,
      });

      toolResults.push(toolResult);
      conversation.push({
        kind: EAssistantLoopConversationItemKind.ToolResult,
        result: toolResult,
      });
    }

    toolActivity.push({
      iteration,
      assistantResponse: assistantTurn.response,
      toolCalls: assistantTurn.toolCalls,
      toolResults,
    });
  }

  const finalHistory = [
    ...args.history,
    { role: ERole.System, content: FINAL_RESPONSE_AFTER_TOOL_LIMIT_INSTRUCTION },
  ];

  const finalAssistantTurn = await args.requestAssistantTurn({
    conversation,
    history: finalHistory,
    user: args.user,
    tools: [],
    purpose: args.purpose,
  });

  if (finalAssistantTurn !== undefined && finalAssistantTurn.toolCalls.length === 0) {
    if (finalAssistantTurn.response.trim().length > 0) {
      conversation.push({
        kind: EAssistantLoopConversationItemKind.AssistantReply,
        content: finalAssistantTurn.response,
      });

      return {
        conversation,
        toolActivity,
        finalResponse: finalAssistantTurn.response,
        stopReason: EAssistantLoopStopReason.MaxIterations,
        iterations: maxIterations,
      };
    }
  }

  if (finalAssistantTurn !== undefined && finalAssistantTurn.toolCalls.length > 0) {
    conversation.push({
      kind: EAssistantLoopConversationItemKind.AssistantToolCalls,
      content: finalAssistantTurn.response,
      toolCalls: finalAssistantTurn.toolCalls,
      reasoningContent: finalAssistantTurn.reasoningContent,
    });

    for (const toolCall of finalAssistantTurn.toolCalls) {
      conversation.push({
        kind: EAssistantLoopConversationItemKind.ToolResult,
        result: createFailedToolResult(toolCall, TOOL_LIMIT_REACHED_ERROR),
      });
    }

    const retryFinalAssistantTurn = await args.requestAssistantTurn({
      conversation,
      history: finalHistory,
      user: args.user,
      tools: [],
      purpose: args.purpose,
    });

    if (retryFinalAssistantTurn !== undefined && retryFinalAssistantTurn.toolCalls.length === 0) {
      if (retryFinalAssistantTurn.response.trim().length > 0) {
        conversation.push({
          kind: EAssistantLoopConversationItemKind.AssistantReply,
          content: retryFinalAssistantTurn.response,
        });

        return {
          conversation,
          toolActivity,
          finalResponse: retryFinalAssistantTurn.response,
          stopReason: EAssistantLoopStopReason.MaxIterations,
          iterations: maxIterations,
        };
      }
    }
  }

  return {
    conversation,
    toolActivity,
    finalResponse: undefined,
    stopReason: EAssistantLoopStopReason.MaxIterations,
    iterations: maxIterations,
  };
}
