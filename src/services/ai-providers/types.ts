import type { ChatMessageToolCall, ToolDefinitionJson } from "@openrouter/sdk/models";

export enum ERole {
  System = "system",
  User = "user",
  Assistant = "assistant",
}

export type THistoryItem = {
  content: string;
  role: ERole;
};

export type TPrompt = {
  role: ERole;
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export type TToolCallResult<T = unknown> = {
  tool: string;
  data: T;
};

export type TToolCallResponse<T = unknown> = {
  response: string;
  toolCalls: Array<{
    id: string;
    type: "function";
    function: unknown;
  }>;
  toolCallsResults: TToolCallResult<T>[];
};

export type TChatWithTools = {
  response: string;
  toolCalls: ChatMessageToolCall[];
};

export type TToolEntry = {
  definition: ToolDefinitionJson;
  instructions?: string;
};

export enum EModelPurpose {
  ToolCheap = "ToolCheap",
  ToolAccurate = "ToolAccurate",
  General = "General",
  Chat = "Chat",
  ChatAccurate = "ChatAccurate",
}
