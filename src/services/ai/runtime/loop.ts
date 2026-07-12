import type { TOption } from "../../../types";
import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "../../app-logger";
import { resolveAiBehaviorFields } from "../../app-logger/ai";
import { sanitizeErrorMessage } from "../../app-logger/sanitizers";
import { ERole } from "../types";
import { buildToolCallBatchSignature, promptToText, serializeForModel } from "./serialization";
import { executeToolCall } from "./tool-execution";
import { createFailedToolResult } from "./tools/results";
import {
  EAssistantLoopConversationItemKind,
  EAssistantLoopStopReason,
  type TAssistantToolLoopResult,
  type TNormalizedToolResult,
  type TRequestAssistantTurnArgs,
  type TRunAssistantToolLoopArgs,
  type TRuntimeAssistantTurn,
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
  const completeLoop = (result: TAssistantToolLoopResult): TAssistantToolLoopResult => {
    logAssistantLoopCompleted(args.trace, result);
    return result;
  };

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const assistantTurn = await requestAssistantTurnWithLogging(args, {
        conversation,
        history: args.history,
        user: args.user,
        tools: args.tools,
        purpose: args.purpose,
        settings: args.settings,
        trace: args.trace,
      });

      if (assistantTurn === undefined) {
        return completeLoop({
          conversation,
          toolActivity,
          finalResponse: undefined,
          stopReason: EAssistantLoopStopReason.MalformedProviderResponse,
          iterations: iteration,
        });
      }

      if (assistantTurn.toolCalls.length === 0) {
        if (assistantTurn.response.trim().length === 0) {
          return completeLoop({
            conversation,
            toolActivity,
            finalResponse: undefined,
            stopReason: EAssistantLoopStopReason.EmptyAssistantResponse,
            iterations: iteration,
          });
        }

        conversation.push({
          kind: EAssistantLoopConversationItemKind.AssistantReply,
          content: assistantTurn.response,
        });

        return completeLoop({
          conversation,
          toolActivity,
          finalResponse: assistantTurn.response,
          stopReason: EAssistantLoopStopReason.FinalResponse,
          iterations: iteration,
        });
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
        return completeLoop({
          conversation,
          toolActivity,
          finalResponse: undefined,
          stopReason: EAssistantLoopStopReason.RepeatedToolCall,
          iterations: iteration,
        });
      }

      lastToolCallBatchSignature = toolCallBatchSignature;

      const toolResults: TNormalizedToolResult[] = [];

      for (const toolCall of assistantTurn.toolCalls) {
        const toolResult = await executeToolCall({
          toolCall,
          chatId: args.chatId,
          allowedToolNames,
          settings: args.settings,
          trace: args.trace,
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

    const finalAssistantTurn = await requestAssistantTurnWithLogging(args, {
      conversation,
      history: finalHistory,
      user: args.user,
      tools: [],
      purpose: args.purpose,
      settings: args.settings,
      trace: args.trace,
    });

    if (finalAssistantTurn !== undefined && finalAssistantTurn.toolCalls.length === 0) {
      if (finalAssistantTurn.response.trim().length > 0) {
        conversation.push({
          kind: EAssistantLoopConversationItemKind.AssistantReply,
          content: finalAssistantTurn.response,
        });

        return completeLoop({
          conversation,
          toolActivity,
          finalResponse: finalAssistantTurn.response,
          stopReason: EAssistantLoopStopReason.MaxIterations,
          iterations: maxIterations,
        });
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

      const retryFinalAssistantTurn = await requestAssistantTurnWithLogging(args, {
        conversation,
        history: finalHistory,
        user: args.user,
        tools: [],
        purpose: args.purpose,
        settings: args.settings,
        trace: args.trace,
      });

      if (retryFinalAssistantTurn !== undefined && retryFinalAssistantTurn.toolCalls.length === 0) {
        if (retryFinalAssistantTurn.response.trim().length > 0) {
          conversation.push({
            kind: EAssistantLoopConversationItemKind.AssistantReply,
            content: retryFinalAssistantTurn.response,
          });

          return completeLoop({
            conversation,
            toolActivity,
            finalResponse: retryFinalAssistantTurn.response,
            stopReason: EAssistantLoopStopReason.MaxIterations,
            iterations: maxIterations,
          });
        }
      }
    }

    return completeLoop({
      conversation,
      toolActivity,
      finalResponse: undefined,
      stopReason: EAssistantLoopStopReason.MaxIterations,
      iterations: maxIterations,
    });
  } catch (error) {
    logAssistantLoopFailed(args.trace, error);
    throw error;
  }
}

async function requestAssistantTurnWithLogging(
  args: TRunAssistantToolLoopArgs,
  requestArgs: TRequestAssistantTurnArgs,
): Promise<TOption<TRuntimeAssistantTurn>> {
  if (args.trace === undefined) {
    return args.requestAssistantTurn(requestArgs);
  }

  const startedAt = performance.now();
  const fields = resolveAiBehaviorFields(requestArgs.settings, requestArgs.purpose);
  const metadata = {
    historyCount: requestArgs.history.length,
    toolCount: requestArgs.tools.length,
    toolNames: requestArgs.tools.map((tool) => tool.definition.function.name),
    promptChars: countPromptChars(requestArgs),
  };

  AppLogger.instance.record({
    trace: args.trace,
    event: "ai.turn.started",
    component: "ai-runtime",
    provider: fields?.provider,
    model: fields?.model,
    purpose: requestArgs.purpose,
    summary: `ai turn started purpose=${requestArgs.purpose} tools=${requestArgs.tools.length}`,
    metadata,
  });

  try {
    const assistantTurn = await args.requestAssistantTurn(requestArgs);
    let success = true;
    let responseChars = 0;
    let toolCallCount = 0;
    let summary = "ai turn completed";

    if (assistantTurn === undefined) {
      success = false;
      summary = "ai turn returned no response";
    } else {
      responseChars = assistantTurn.response.length;
      toolCallCount = assistantTurn.toolCalls.length;
    }

    let level = EBehaviorLogLevel.Info;

    if (!success) {
      level = EBehaviorLogLevel.Warning;
    }

    AppLogger.instance.record({
      trace: args.trace,
      event: "ai.turn.completed",
      component: "ai-runtime",
      level,
      provider: fields?.provider,
      model: fields?.model,
      purpose: requestArgs.purpose,
      success,
      durationMs: performance.now() - startedAt,
      summary,
      metadata: {
        responseChars,
        toolCallCount,
      },
    });

    return assistantTurn;
  } catch (error) {
    AppLogger.instance.record({
      trace: args.trace,
      event: "ai.turn.completed",
      component: "ai-runtime",
      level: EBehaviorLogLevel.Error,
      provider: fields?.provider,
      model: fields?.model,
      purpose: requestArgs.purpose,
      success: false,
      durationMs: performance.now() - startedAt,
      summary: "ai turn failed",
      metadata: {
        responseChars: 0,
        toolCallCount: 0,
      },
      error: sanitizeErrorMessage(String(error)),
    });
    throw error;
  }
}

function logAssistantLoopCompleted(
  trace: TOption<TBehaviorTraceContext>,
  result: TAssistantToolLoopResult,
) {
  if (trace === undefined) {
    return;
  }

  let finalResponseChars = 0;

  if (result.finalResponse !== undefined) {
    finalResponseChars = result.finalResponse.length;
  }

  AppLogger.instance.record({
    trace,
    event: "assistant_loop.completed",
    component: "ai-runtime",
    success: result.finalResponse !== undefined,
    summary: `assistant loop completed stopReason=${result.stopReason}`,
    metadata: {
      iterations: result.iterations,
      stopReason: result.stopReason,
      toolActivityCount: result.toolActivity.length,
      finalResponseChars,
    },
  });
}

function logAssistantLoopFailed(trace: TOption<TBehaviorTraceContext>, error: unknown) {
  if (trace === undefined) {
    return;
  }

  AppLogger.instance.record({
    trace,
    event: "assistant_loop.completed",
    component: "ai-runtime",
    level: EBehaviorLogLevel.Error,
    success: false,
    summary: "assistant loop failed",
    metadata: {
      iterations: 0,
      toolActivityCount: 0,
      finalResponseChars: 0,
    },
    error: sanitizeErrorMessage(String(error)),
  });
}

function countPromptChars(args: TRequestAssistantTurnArgs): number {
  let total = 0;

  for (const historyItem of args.history) {
    total += historyItem.content.length;
  }

  for (const tool of args.tools) {
    if (tool.instructions !== undefined) {
      total += tool.instructions.length;
    }
  }

  for (const item of args.conversation) {
    switch (item.kind) {
      case EAssistantLoopConversationItemKind.UserPrompt: {
        total += promptToText(item.prompt).length;
        break;
      }
      case EAssistantLoopConversationItemKind.AssistantToolCalls: {
        total += item.content.length;
        total += serializeForModel(item.toolCalls).length;
        break;
      }
      case EAssistantLoopConversationItemKind.ToolResult: {
        total += serializeForModel(item.result).length;
        break;
      }
      case EAssistantLoopConversationItemKind.AssistantReply: {
        total += item.content.length;
        break;
      }
    }
  }

  return total;
}
