import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TPrompt } from "../types";

export function promptToText(prompt: TPrompt): string {
  return prompt.content.map((item) => item.text).join("\n");
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

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const texts: string[] = [];

  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }

    if (item.type !== "text") {
      continue;
    }

    if (typeof item.text !== "string") {
      continue;
    }

    texts.push(item.text);
  }

  return texts.join("\n");
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

export function parseArgumentsForOllama(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText);

    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    return { rawArguments: argumentsText };
  }

  return { rawArguments: argumentsText };
}

export function buildToolCallBatchSignature(toolCalls: ChatMessageToolCall[]): string {
  return toolCalls
    .map((toolCall) => `${toolCall.function.name}:${toolCall.function.arguments}`)
    .join("\n");
}
