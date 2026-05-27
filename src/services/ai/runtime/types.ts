import type { ChatMessageToolCall } from "@openrouter/sdk/models";
import type { TOption } from "../../../types";
import type { EModelPurpose, THistoryItem, TPrompt, TToolEntry } from "../types";

export enum EAssistantLoopConversationItemKind {
  UserPrompt = "user-prompt",
  AssistantToolCalls = "assistant-tool-calls",
  ToolResult = "tool-result",
  AssistantReply = "assistant-reply",
}

export enum EAssistantLoopStopReason {
  FinalResponse = "final-response",
  EmptyAssistantResponse = "empty-assistant-response",
  MaxIterations = "max-iterations",
  RepeatedToolCall = "repeated-tool-call",
  MalformedProviderResponse = "malformed-provider-response",
}

export type TRuntimeUser = {
  username: string;
  id: string;
  displayName: string;
};

export type TLoopUserPromptItem = {
  kind: EAssistantLoopConversationItemKind.UserPrompt;
  prompt: TPrompt;
};

export type TLoopAssistantToolCallsItem = {
  kind: EAssistantLoopConversationItemKind.AssistantToolCalls;
  content: string;
  toolCalls: ChatMessageToolCall[];
  reasoningContent?: string;
};

export type TNormalizedToolResult = {
  toolCallId: string;
  toolName: string;
  success: boolean;
  data: TOption<unknown>;
  error: TOption<string>;
};

export type TLoopToolResultItem = {
  kind: EAssistantLoopConversationItemKind.ToolResult;
  result: TNormalizedToolResult;
};

export type TLoopAssistantReplyItem = {
  kind: EAssistantLoopConversationItemKind.AssistantReply;
  content: string;
};

export type TRuntimeConversationItem =
  | TLoopUserPromptItem
  | TLoopAssistantToolCallsItem
  | TLoopToolResultItem
  | TLoopAssistantReplyItem;

export type TRuntimeAssistantTurn = {
  response: string;
  toolCalls: ChatMessageToolCall[];
  reasoningContent?: string;
};

export type TAssistantToolActivity = {
  iteration: number;
  assistantResponse: string;
  toolCalls: ChatMessageToolCall[];
  toolResults: TNormalizedToolResult[];
};

export type TRequestAssistantTurnArgs = {
  conversation: TRuntimeConversationItem[];
  history: THistoryItem[];
  user: TOption<TRuntimeUser>;
  tools: TToolEntry[];
  purpose: EModelPurpose;
};

export type TRequestAssistantTurn = (
  args: TRequestAssistantTurnArgs,
) => Promise<TOption<TRuntimeAssistantTurn>>;

export type TAssistantToolLoopArgs = {
  prompt: TPrompt;
  history: THistoryItem[];
  user: TRuntimeUser;
  tools: TToolEntry[];
  purpose: EModelPurpose;
  chatId: TOption<string>;
  maxIterations?: number;
  requestAssistantTurn?: TRequestAssistantTurn;
};

export type TRunAssistantToolLoopArgs = TAssistantToolLoopArgs & {
  requestAssistantTurn: TRequestAssistantTurn;
};

export type TToolTaskArgs = {
  prompt: TPrompt;
  history: THistoryItem[];
  tools: TToolEntry[];
  purpose: EModelPurpose;
  chatId: TOption<string>;
  user: TOption<TRuntimeUser>;
};

export type TRunToolTaskArgs = TToolTaskArgs & {
  requestAssistantTurn: TRequestAssistantTurn;
};

export type TAssistantToolLoopResult = {
  conversation: TRuntimeConversationItem[];
  toolActivity: TAssistantToolActivity[];
  finalResponse: TOption<string>;
  stopReason: EAssistantLoopStopReason;
  iterations: number;
};

export type TToolTaskResult = {
  assistantResponse: string;
  toolCalls: ChatMessageToolCall[];
  toolResults: TNormalizedToolResult[];
};
