import type { TOption } from "../../types";

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
