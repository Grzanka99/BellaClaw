import type { TOption } from "../../../types";
import { buildToolCallBatchSignature } from "./serialization";
import { executeToolCall } from "./tool-execution";
import {
  EAssistantLoopConversationItemKind,
  EAssistantLoopStopReason,
  type TAssistantToolLoopResult,
  type TNormalizedToolResult,
  type TRunAssistantToolLoopArgs,
  type TRuntimeConversationItem,
} from "./types";

const DEFAULT_MAX_ITERATIONS = 4;

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

  return {
    conversation,
    toolActivity,
    finalResponse: undefined,
    stopReason: EAssistantLoopStopReason.MaxIterations,
    iterations: maxIterations,
  };
}
