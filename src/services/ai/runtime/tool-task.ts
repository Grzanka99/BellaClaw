import { executeToolCall } from "./tool-execution";
import type { TRunToolTaskArgs, TRuntimeConversationItem, TToolTaskResult } from "./types";
import { EAssistantLoopConversationItemKind, type TNormalizedToolResult } from "./types";

export async function runToolTask(args: TRunToolTaskArgs): Promise<TToolTaskResult> {
  const conversation: TRuntimeConversationItem[] = [
    { kind: EAssistantLoopConversationItemKind.UserPrompt, prompt: args.prompt },
  ];
  const allowedToolNames = new Set(args.tools.map((tool) => tool.definition.function.name));
  const assistantTurn = await args.requestAssistantTurn({
    conversation,
    history: args.history,
    user: args.user,
    tools: args.tools,
    purpose: args.purpose,
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
    });

    toolResults.push(toolResult);
  }

  return {
    assistantResponse: assistantTurn.response,
    toolCalls: assistantTurn.toolCalls,
    toolResults,
  };
}
