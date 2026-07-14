import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { TOption } from "../../../types";
import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "../../app-logger";
import { resolveAiBehaviorFields } from "../../app-logger/ai";
import { sanitizeErrorMessage } from "../../app-logger/sanitizers";
import { ERole, type THistoryItem, type TToolCall } from "../types";
import {
  buildToolCallBatchSignature,
  countConversationChars,
  createToolResultMessage,
  extractAssistantText,
  extractAssistantToolCalls,
  promptToUserMessage,
} from "./serialization";
import { executeToolCall } from "./tool-execution";
import { createFailedToolResult } from "./tools/results";
import {
  EAssistantLoopStopReason,
  type TAssistantToolLoopResult,
  type TNormalizedToolResult,
  type TRequestAssistantTurnArgs,
  type TRunAssistantToolLoopArgs,
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
  const conversation: Message[] = [promptToUserMessage(args.prompt)];
  const toolActivity: TAssistantToolLoopResult["toolActivity"] = [];
  const maxIterations = args.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const allowedToolNames = new Set(args.tools.map((tool) => tool.definition.name));
  let lastToolCallBatchSignature: TOption<string>;

  const completeLoop = (result: TAssistantToolLoopResult): TAssistantToolLoopResult => {
    logAssistantLoopCompleted(args.trace, result);
    return result;
  };

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const assistantMessage = await requestAssistantTurnWithLogging(args, {
        conversation,
        history: args.history,
        user: args.user,
        currentTimeContext: args.currentTimeContext,
        tools: args.tools,
        purpose: args.purpose,
        settings: args.settings,
        platform: args.platform,
        trace: args.trace,
      });

      conversation.push(assistantMessage);

      if (assistantMessage.stopReason === "error") {
        throwAssistantError(assistantMessage);
      }

      if (assistantMessage.stopReason === "aborted") {
        return completeLoop({
          conversation,
          toolActivity,
          finalResponse: undefined,
          stopReason: EAssistantLoopStopReason.Aborted,
          iterations: iteration,
        });
      }

      const assistantResponse = extractAssistantText(assistantMessage);
      const toolCalls = extractAssistantToolCalls(assistantMessage);

      if (assistantMessage.stopReason === "length") {
        let finalResponse: TOption<string>;

        if (assistantResponse.trim().length > 0) {
          finalResponse = assistantResponse;
        }

        return completeLoop({
          conversation,
          toolActivity,
          finalResponse,
          stopReason: EAssistantLoopStopReason.OutputLimit,
          iterations: iteration,
        });
      }

      if (assistantMessage.stopReason === "stop") {
        if (assistantResponse.trim().length === 0) {
          return completeLoop({
            conversation,
            toolActivity,
            finalResponse: undefined,
            stopReason: EAssistantLoopStopReason.EmptyAssistantResponse,
            iterations: iteration,
          });
        }

        return completeLoop({
          conversation,
          toolActivity,
          finalResponse: assistantResponse,
          stopReason: EAssistantLoopStopReason.FinalResponse,
          iterations: iteration,
        });
      }

      if (toolCalls.length === 0) {
        return completeLoop({
          conversation,
          toolActivity,
          finalResponse: undefined,
          stopReason: EAssistantLoopStopReason.MalformedProviderResponse,
          iterations: iteration,
        });
      }

      const toolCallBatchSignature = buildToolCallBatchSignature(toolCalls);

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

      for (const toolCall of toolCalls) {
        const toolResult = await executeToolCall({
          toolCall,
          chatId: args.chatId,
          allowedToolNames,
          settings: args.settings,
          trace: args.trace,
        });

        toolResults.push(toolResult);
        conversation.push(createToolResultMessage(toolResult));
      }

      toolActivity.push({
        iteration,
        assistantResponse,
        toolCalls,
        toolResults,
      });
    }

    const finalHistory: THistoryItem[] = [
      ...args.history,
      { role: ERole.System, content: FINAL_RESPONSE_AFTER_TOOL_LIMIT_INSTRUCTION },
    ];

    const finalAssistantMessage = await requestAssistantTurnWithLogging(args, {
      conversation,
      history: finalHistory,
      user: args.user,
      currentTimeContext: args.currentTimeContext,
      tools: [],
      purpose: args.purpose,
      settings: args.settings,
      trace: args.trace,
    });

    conversation.push(finalAssistantMessage);

    const finalResult = completeForcedFinalMessage({
      assistantMessage: finalAssistantMessage,
      conversation,
      toolActivity,
      iterations: maxIterations,
      completeLoop,
    });

    if (finalResult !== undefined) {
      return finalResult;
    }

    const finalToolCalls = extractAssistantToolCalls(finalAssistantMessage);
    appendRejectedToolResults(conversation, finalToolCalls);

    const retryFinalAssistantMessage = await requestAssistantTurnWithLogging(args, {
      conversation,
      history: finalHistory,
      user: args.user,
      currentTimeContext: args.currentTimeContext,
      tools: [],
      purpose: args.purpose,
      settings: args.settings,
      trace: args.trace,
    });

    conversation.push(retryFinalAssistantMessage);

    const retryResult = completeForcedFinalMessage({
      assistantMessage: retryFinalAssistantMessage,
      conversation,
      toolActivity,
      iterations: maxIterations,
      completeLoop,
    });

    if (retryResult !== undefined) {
      return retryResult;
    }

    appendRejectedToolResults(conversation, extractAssistantToolCalls(retryFinalAssistantMessage));

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

function completeForcedFinalMessage(args: {
  assistantMessage: AssistantMessage;
  conversation: Message[];
  toolActivity: TAssistantToolLoopResult["toolActivity"];
  iterations: number;
  completeLoop: (result: TAssistantToolLoopResult) => TAssistantToolLoopResult;
}): TOption<TAssistantToolLoopResult> {
  if (args.assistantMessage.stopReason === "error") {
    throwAssistantError(args.assistantMessage);
  }

  if (args.assistantMessage.stopReason === "aborted") {
    return args.completeLoop({
      conversation: args.conversation,
      toolActivity: args.toolActivity,
      finalResponse: undefined,
      stopReason: EAssistantLoopStopReason.Aborted,
      iterations: args.iterations,
    });
  }

  const assistantResponse = extractAssistantText(args.assistantMessage);

  if (args.assistantMessage.stopReason === "length") {
    let finalResponse: TOption<string>;

    if (assistantResponse.trim().length > 0) {
      finalResponse = assistantResponse;
    }

    return args.completeLoop({
      conversation: args.conversation,
      toolActivity: args.toolActivity,
      finalResponse,
      stopReason: EAssistantLoopStopReason.OutputLimit,
      iterations: args.iterations,
    });
  }

  if (args.assistantMessage.stopReason === "stop") {
    const toolCalls = extractAssistantToolCalls(args.assistantMessage);

    if (toolCalls.length > 0) {
      return undefined;
    }

    if (assistantResponse.trim().length > 0) {
      return args.completeLoop({
        conversation: args.conversation,
        toolActivity: args.toolActivity,
        finalResponse: assistantResponse,
        stopReason: EAssistantLoopStopReason.MaxIterations,
        iterations: args.iterations,
      });
    }

    return args.completeLoop({
      conversation: args.conversation,
      toolActivity: args.toolActivity,
      finalResponse: undefined,
      stopReason: EAssistantLoopStopReason.MaxIterations,
      iterations: args.iterations,
    });
  }

  const toolCalls = extractAssistantToolCalls(args.assistantMessage);

  if (toolCalls.length === 0) {
    return args.completeLoop({
      conversation: args.conversation,
      toolActivity: args.toolActivity,
      finalResponse: undefined,
      stopReason: EAssistantLoopStopReason.MalformedProviderResponse,
      iterations: args.iterations,
    });
  }

  return undefined;
}

function appendRejectedToolResults(conversation: Message[], toolCalls: TToolCall[]) {
  for (const toolCall of toolCalls) {
    const result = createFailedToolResult(toolCall, TOOL_LIMIT_REACHED_ERROR);
    conversation.push(createToolResultMessage(result));
  }
}

async function requestAssistantTurnWithLogging(
  args: TRunAssistantToolLoopArgs,
  requestArgs: TRequestAssistantTurnArgs,
): Promise<AssistantMessage> {
  if (args.trace === undefined) {
    return args.requestAssistantTurn(requestArgs);
  }

  const startedAt = performance.now();
  const fields = resolveAiBehaviorFields(requestArgs.settings, requestArgs.purpose);
  const metadata = {
    historyCount: requestArgs.history.length,
    toolCount: requestArgs.tools.length,
    toolNames: requestArgs.tools.map((tool) => tool.definition.name),
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
    const assistantMessage = await args.requestAssistantTurn(requestArgs);
    const assistantResponse = extractAssistantText(assistantMessage);
    const toolCalls = extractAssistantToolCalls(assistantMessage);
    let success = true;
    let level = EBehaviorLogLevel.Info;

    if (assistantMessage.stopReason === "aborted") {
      success = false;
      level = EBehaviorLogLevel.Warning;
    }

    if (assistantMessage.stopReason === "error") {
      success = false;
      level = EBehaviorLogLevel.Error;
    }

    if (assistantMessage.stopReason === "length") {
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
      summary: `ai turn completed stopReason=${assistantMessage.stopReason}`,
      metadata: createAssistantCompletionMetadata(
        assistantMessage,
        assistantResponse.length,
        toolCalls.length,
      ),
      error: sanitizeErrorMessage(assistantMessage.errorMessage),
    });

    return assistantMessage;
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

function createAssistantCompletionMetadata(
  assistantMessage: AssistantMessage,
  responseChars: number,
  toolCallCount: number,
) {
  return {
    responseChars,
    toolCallCount,
    inputTokens: assistantMessage.usage.input,
    outputTokens: assistantMessage.usage.output,
    cacheReadTokens: assistantMessage.usage.cacheRead,
    cacheWriteTokens: assistantMessage.usage.cacheWrite,
    totalTokens: assistantMessage.usage.totalTokens,
    totalCost: assistantMessage.usage.cost.total,
    actualModel: assistantMessage.responseModel ?? assistantMessage.model,
    piStopReason: assistantMessage.stopReason,
  };
}

function throwAssistantError(assistantMessage: AssistantMessage): never {
  const sanitizedError = sanitizeErrorMessage(assistantMessage.errorMessage);

  if (sanitizedError !== undefined && sanitizedError.length > 0) {
    throw new Error(sanitizedError);
  }

  throw new Error("AI provider request failed");
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
  let total = countConversationChars(args.conversation);

  for (const historyItem of args.history) {
    total += historyItem.content.length;
  }

  if (args.currentTimeContext !== undefined) {
    total += args.currentTimeContext.length;
  }

  for (const tool of args.tools) {
    if (tool.instructions !== undefined) {
      total += tool.instructions.length;
    }
  }

  return total;
}
