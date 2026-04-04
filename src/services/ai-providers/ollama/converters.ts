import type { ToolDefinitionJson } from "@openrouter/sdk/models";
import type { THistoryItem, TPrompt } from "../types";
import type { TUserData } from "./index";

export type TOllamaMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
};

export function buildUserContextMessage(user: TUserData): string {
  return `Current user context - always use this user_id for tool calls:\n- user_id: ${user.id}\n- username: ${user.username}\n- displayName: ${user.displayName}`;
}

export function buildMessages(
  history: THistoryItem[],
  prompt: TPrompt,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];

  for (const item of history) {
    messages.push({ role: item.role, content: item.content });
  }

  const promptText = prompt.content.map((c) => c.text).join("\n");
  messages.push({ role: prompt.role, content: promptText });

  return messages;
}

export function flattenMessages(
  baseSystemText: string,
  user: TUserData,
  history: THistoryItem[],
  prompt: TPrompt,
  toolInstructions: string[] = [],
): { messages: Array<{ role: string; content: string }>; systemContent: string } {
  const userContext = buildUserContextMessage(user);
  const systemContent = [baseSystemText, userContext, ...toolInstructions].join("\n\n");

  return { messages: buildMessages(history, prompt), systemContent };
}

export function convertToolsForOllama(
  tools: ToolDefinitionJson[],
): Array<{ type: string; function: { name: string; description: string; parameters: unknown } }> {
  return tools.map((t) => ({
    type: t.type ?? "function",
    function: {
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: t.function.parameters ?? { type: "object", properties: {} },
    },
  }));
}

export function convertOllamaToolCalls(
  toolCalls: NonNullable<TOllamaMessage["tool_calls"]>,
): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> {
  return toolCalls.map((tc, index) => ({
    id: `ollama-${index}-${tc.function.name}`,
    type: "function" as const,
    function: {
      name: tc.function.name,
      arguments: JSON.stringify(tc.function.arguments),
    },
  }));
}
