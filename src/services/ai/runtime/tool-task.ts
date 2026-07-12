import type { TOption } from "../../../types";
import { AppLogger, EBehaviorLogLevel } from "../../app-logger";
import { resolveAiBehaviorFields } from "../../app-logger/ai";
import { sanitizeErrorMessage } from "../../app-logger/sanitizers";
import { promptToText } from "./serialization";
import { executeToolCall } from "./tool-execution";
import type {
  TRequestAssistantTurnArgs,
  TRunToolTaskArgs,
  TRuntimeAssistantTurn,
  TRuntimeConversationItem,
  TToolTaskResult,
} from "./types";
import { EAssistantLoopConversationItemKind, type TNormalizedToolResult } from "./types";

export async function runToolTask(args: TRunToolTaskArgs): Promise<TToolTaskResult> {
  const conversation: TRuntimeConversationItem[] = [
    { kind: EAssistantLoopConversationItemKind.UserPrompt, prompt: args.prompt },
  ];
  const allowedToolNames = new Set(args.tools.map((tool) => tool.definition.function.name));
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
    return {
      assistantResponse: "",
      toolCalls: [],
      toolResults: [],
    };
  }

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
  }

  return {
    assistantResponse: assistantTurn.response,
    toolCalls: assistantTurn.toolCalls,
    toolResults,
  };
}

async function requestAssistantTurnWithLogging(
  args: TRunToolTaskArgs,
  requestArgs: TRequestAssistantTurnArgs,
): Promise<TOption<TRuntimeAssistantTurn>> {
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
      toolNames: requestArgs.tools.map((tool) => tool.definition.function.name),
      promptChars: countPromptChars(requestArgs),
    },
  });

  try {
    const assistantTurn = await args.requestAssistantTurn(requestArgs);
    let success = true;
    let responseChars = 0;
    let toolCallCount = 0;
    let level = EBehaviorLogLevel.Info;
    let summary = "ai tool task completed";

    if (assistantTurn === undefined) {
      success = false;
      level = EBehaviorLogLevel.Warning;
      summary = "ai tool task returned no response";
    } else {
      responseChars = assistantTurn.response.length;
      toolCallCount = assistantTurn.toolCalls.length;
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
    if (item.kind === EAssistantLoopConversationItemKind.UserPrompt) {
      total += promptToText(item.prompt).length;
    }
  }

  return total;
}
