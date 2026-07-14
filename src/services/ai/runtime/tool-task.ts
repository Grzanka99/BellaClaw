import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AppLogger, EBehaviorLogLevel } from "../../app-logger";
import { resolveAiBehaviorFields } from "../../app-logger/ai";
import { sanitizeErrorMessage } from "../../app-logger/sanitizers";
import {
  countConversationChars,
  extractAssistantText,
  extractAssistantToolCalls,
  promptToUserMessage,
} from "./serialization";
import { executeToolCall } from "./tool-execution";
import type {
  TNormalizedToolResult,
  TRequestAssistantTurnArgs,
  TRunToolTaskArgs,
  TToolTaskResult,
} from "./types";

export async function runToolTask(args: TRunToolTaskArgs): Promise<TToolTaskResult> {
  const conversation = [promptToUserMessage(args.prompt)];
  const allowedToolNames = new Set(args.tools.map((tool) => tool.definition.name));
  const assistantMessage = await requestAssistantTurnWithLogging(args, {
    conversation,
    history: args.history,
    user: args.user,
    currentTimeContext: undefined,
    tools: args.tools,
    purpose: args.purpose,
    settings: args.settings,
    platform: args.platform,
    trace: args.trace,
  });

  if (assistantMessage.stopReason === "error") {
    throwAssistantError(assistantMessage);
  }

  let assistantResponse = extractAssistantText(assistantMessage);
  const toolCalls = extractAssistantToolCalls(assistantMessage);
  const toolResults: TNormalizedToolResult[] = [];

  if (assistantMessage.stopReason === "aborted") {
    assistantResponse = "";
  }

  if (assistantMessage.stopReason === "toolUse") {
    for (const toolCall of toolCalls) {
      const toolResult = await executeToolCall({
        toolCall,
        chatId: args.chatId,
        allowedToolNames,
        settings: args.settings,
        trace: args.trace,
      });

      toolResults.push(toolResult);
    }
  }

  return {
    assistantResponse,
    toolCalls,
    toolResults,
  };
}

async function requestAssistantTurnWithLogging(
  args: TRunToolTaskArgs,
  requestArgs: TRequestAssistantTurnArgs,
): Promise<AssistantMessage> {
  if (args.trace === undefined) {
    return args.requestAssistantTurn(requestArgs);
  }

  const startedAt = performance.now();
  const fields = resolveAiBehaviorFields(requestArgs.settings, requestArgs.purpose);

  AppLogger.instance.record({
    trace: args.trace,
    event: "ai.turn.started",
    component: "ai-runtime",
    provider: fields?.provider,
    model: fields?.model,
    purpose: requestArgs.purpose,
    summary: `ai tool task started purpose=${requestArgs.purpose} tools=${requestArgs.tools.length}`,
    metadata: {
      historyCount: requestArgs.history.length,
      toolCount: requestArgs.tools.length,
      toolNames: requestArgs.tools.map((tool) => tool.definition.name),
      promptChars: countPromptChars(requestArgs),
    },
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
      summary: `ai tool task completed stopReason=${assistantMessage.stopReason}`,
      metadata: {
        responseChars: assistantResponse.length,
        toolCallCount: toolCalls.length,
        inputTokens: assistantMessage.usage.input,
        outputTokens: assistantMessage.usage.output,
        cacheReadTokens: assistantMessage.usage.cacheRead,
        cacheWriteTokens: assistantMessage.usage.cacheWrite,
        totalTokens: assistantMessage.usage.totalTokens,
        totalCost: assistantMessage.usage.cost.total,
        actualModel: assistantMessage.responseModel ?? assistantMessage.model,
        piStopReason: assistantMessage.stopReason,
      },
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
      summary: "ai tool task failed",
      metadata: {
        responseChars: 0,
        toolCallCount: 0,
      },
      error: sanitizeErrorMessage(String(error)),
    });
    throw error;
  }
}

function throwAssistantError(assistantMessage: AssistantMessage): never {
  const sanitizedError = sanitizeErrorMessage(assistantMessage.errorMessage);

  if (sanitizedError !== undefined && sanitizedError.length > 0) {
    throw new Error(sanitizedError);
  }

  throw new Error("AI provider request failed");
}

function countPromptChars(args: TRequestAssistantTurnArgs): number {
  let total = countConversationChars(args.conversation);

  for (const historyItem of args.history) {
    total += historyItem.content.length;
  }

  for (const tool of args.tools) {
    if (tool.instructions !== undefined) {
      total += tool.instructions.length;
    }
  }

  return total;
}
