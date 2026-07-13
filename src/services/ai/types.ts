export enum EAiProvider {
  Openrouter = "openrouter",
  Ollama = "ollama",
  OpencodeGo = "opencode-go",
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
  definition: TToolDefinition;
  instructions?: string;
};

export type TToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type TToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export enum EModelPurpose {
  ToolCheap = "ToolCheap",
  ToolAccurate = "ToolAccurate",
  General = "General",
  Chat = "Chat",
  ChatAccurate = "ChatAccurate",
}
