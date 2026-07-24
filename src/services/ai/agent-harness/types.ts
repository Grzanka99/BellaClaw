import type { TOption } from "../../../types";
import type { TBehaviorTraceContext } from "../../app-logger";
import type { EMessagePlatform } from "../../messaging/types";
import type { TConfigRecord } from "../../settings/schema";
import type { EModelPurpose, THistoryItem } from "../types";

export enum EAgentName {
  Main = "main",
  Memory = "memory",
  Settings = "settings",
  Scheduling = "scheduling",
  ScheduledTask = "scheduled-task",
}

export type TAgentRunArgs = {
  name: EAgentName;
  purpose: EModelPurpose;
  prompt: string;
  chatId: TOption<string>;
  settings: TConfigRecord;
  currentTimeContext: TOption<string>;
  platform: TOption<EMessagePlatform>;
  trace: TOption<TBehaviorTraceContext>;
  history: TOption<THistoryItem[]>;
  maxIterations: number;
  parentToolCallId: TOption<string>;
  signal: TOption<AbortSignal>;
};

export type TAgentRunResult = {
  text: TOption<string>;
  iterations: number;
  toolCallCount: number;
  stopReason: string;
};
