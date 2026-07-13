import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { TOption } from "../../../types";
import type { TBehaviorTraceContext } from "../../app-logger";
import type { TConfigRecord } from "../../settings/schema";
import type { EModelPurpose, THistoryItem, TPrompt, TToolCall, TToolEntry } from "../types";

export enum EAssistantLoopStopReason {
  FinalResponse = "final-response",
  EmptyAssistantResponse = "empty-assistant-response",
  MaxIterations = "max-iterations",
  RepeatedToolCall = "repeated-tool-call",
  MalformedProviderResponse = "malformed-provider-response",
  Aborted = "aborted",
  OutputLimit = "output-limit",
}

export type TRuntimeUser = {
  username: string;
  id: string;
  displayName: string;
};

export type TNormalizedToolResult = {
  toolCallId: string;
  toolName: string;
  success: boolean;
  data: TOption<unknown>;
  error: TOption<string>;
};

export type TAssistantToolActivity = {
  iteration: number;
  assistantResponse: string;
  toolCalls: TToolCall[];
  toolResults: TNormalizedToolResult[];
};

export type TRequestAssistantTurnArgs = {
  conversation: Message[];
  history: THistoryItem[];
  user: TOption<TRuntimeUser>;
  currentTimeContext: TOption<string>;
  tools: TToolEntry[];
  purpose: EModelPurpose;
  settings: TConfigRecord;
  trace?: TBehaviorTraceContext;
};

export type TRequestAssistantTurn = (args: TRequestAssistantTurnArgs) => Promise<AssistantMessage>;

export type TAssistantToolLoopArgs = {
  prompt: TPrompt;
  history: THistoryItem[];
  user: TRuntimeUser;
  currentTimeContext?: string;
  tools: TToolEntry[];
  purpose: EModelPurpose;
  chatId: TOption<string>;
  settings: TConfigRecord;
  trace?: TBehaviorTraceContext;
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
  settings: TConfigRecord;
  trace?: TBehaviorTraceContext;
};

export type TRunToolTaskArgs = TToolTaskArgs & {
  requestAssistantTurn: TRequestAssistantTurn;
};

export type TAssistantToolLoopResult = {
  conversation: Message[];
  toolActivity: TAssistantToolActivity[];
  finalResponse: TOption<string>;
  stopReason: EAssistantLoopStopReason;
  iterations: number;
};

export type TToolTaskResult = {
  assistantResponse: string;
  toolCalls: TToolCall[];
  toolResults: TNormalizedToolResult[];
};
