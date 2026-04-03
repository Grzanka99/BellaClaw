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
