export type THistoryItem = {
  content: string;
  role: "system" | "user" | "assistant";
};

export type TPrompt = {
  role: "system" | "user" | "assistant";
  content: Array<{
    type: "text";
    text: string;
  }>;
};

export type TToolCallResponse<T> = {
  response: string;
  toolCalls: Array<{
    id: string;
    type: "function";
    function: unknown;
  }>;
  toolCallsResults: T;
};
