import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { TPrompt, TToolCall } from "../types";
import type { TNormalizedToolResult } from "./types";

export function promptToText(prompt: TPrompt): string {
  return prompt.content.map((item) => item.text).join("\n");
}

export function promptToUserMessage(prompt: TPrompt): UserMessage {
  return {
    role: "user",
    content: prompt.content,
    timestamp: Date.now(),
  };
}

export function serializeForModel(value: unknown): string {
  const serialized = JSON.stringify(
    value,
    (_key, currentValue) => {
      if (currentValue instanceof Date) {
        return currentValue.toISOString();
      }

      return currentValue;
    },
    2,
  );

  return serialized ?? "undefined";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractAssistantText(message: AssistantMessage): string {
  const texts: string[] = [];

  for (const item of message.content) {
    if (item.type === "text") {
      texts.push(item.text);
    }
  }

  return texts.join("\n");
}

export function extractAssistantToolCalls(message: AssistantMessage): TToolCall[] {
  const toolCalls: TToolCall[] = [];

  for (const item of message.content) {
    if (item.type !== "toolCall") {
      continue;
    }

    toolCalls.push({
      id: item.id,
      name: item.name,
      arguments: item.arguments,
    });
  }

  return toolCalls;
}

export function createToolResultMessage(
  result: TNormalizedToolResult,
): ToolResultMessage<TNormalizedToolResult> {
  return {
    role: "toolResult",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    content: [{ type: "text", text: serializeForModel(result) }],
    details: result,
    isError: !result.success,
    timestamp: Date.now(),
  };
}

export function normalizeError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  const serialized = serializeForModel(error);

  if (serialized !== "undefined") {
    return serialized;
  }

  return String(error);
}

export function buildToolCallBatchSignature(toolCalls: TToolCall[]): string {
  return toolCalls
    .map((toolCall) => `${toolCall.name}:${serializeDeterministically(toolCall.arguments)}`)
    .join("\n");
}

export function countConversationChars(conversation: Message[]): number {
  let total = 0;

  for (const message of conversation) {
    if (message.role === "user") {
      total += countUserMessageChars(message);
      continue;
    }

    if (message.role === "assistant") {
      for (const item of message.content) {
        if (item.type === "text") {
          total += item.text.length;
        }

        if (item.type === "toolCall") {
          total += item.name.length;
          total += serializeForModel(item.arguments).length;
        }
      }
      continue;
    }

    for (const item of message.content) {
      if (item.type === "text") {
        total += item.text.length;
      }
    }
  }

  return total;
}

function countUserMessageChars(message: UserMessage): number {
  if (typeof message.content === "string") {
    return message.content.length;
  }

  let total = 0;

  for (const item of message.content) {
    if (item.type === "text") {
      total += item.text.length;
    }
  }

  return total;
}

function serializeDeterministically(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeDeterministically(item)).join(",")}]`;
  }

  if (isRecord(value)) {
    const entries: string[] = [];

    for (const key of Object.keys(value).sort()) {
      entries.push(`${JSON.stringify(key)}:${serializeDeterministically(value[key])}`);
    }

    return `{${entries.join(",")}}`;
  }

  const serialized = JSON.stringify(value);

  if (serialized !== undefined) {
    return serialized;
  }

  return String(value);
}
