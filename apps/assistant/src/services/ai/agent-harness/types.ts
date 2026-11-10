import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { TConversation } from "../../conversation/types";
import type { TMcpProfile } from "../../mcp/config";
import type { EMessagePlatform } from "../../messaging/types";
import type { TConfigRecord } from "../../settings/schema";
import type { EAgentName } from "../agents";

export type TAgentRunArgs = {
  name: EAgentName;
  prompt: string;
  chatId: TOption<string>;
  settings: TConfigRecord;
  currentTimeContext: TOption<string>;
  platform: TOption<EMessagePlatform>;
  trace: TBehaviorTraceContext;
  conversation?: TConversation;
  parentToolCallId: TOption<string>;
  signal: TOption<AbortSignal>;
  mcp?: { profile: TMcpProfile; tools: AgentTool[] };
};

export type TAgentRunResult = {
  text: TOption<string>;
  iterations: number;
  toolCallCount: number;
  stopReason: string;
};

export type TMainAgentRunResult = TAgentRunResult & { messages: Message[] };
