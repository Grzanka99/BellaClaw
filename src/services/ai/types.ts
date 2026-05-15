import type { ToolDefinitionJson } from "@openrouter/sdk/models";

export enum EAiProvider {
  Openrouter = "openrouter",
  Ollama = "ollama",
}

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
