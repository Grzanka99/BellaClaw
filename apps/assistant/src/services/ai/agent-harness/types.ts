import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { TConversation } from "../../conversation/types";
import type { TEventRequester } from "../../events";
import type { TMcpProfile } from "../../mcp/config";
import type { EMessagePlatform, TAttachmentRef } from "../../messaging/types";
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
  // the requests of the event handler this run belongs to; tools send commands with it
  events: TEventRequester;
  conversation?: TConversation;
  // the current message's images and how to fetch any image of this chat at turn time
  images?: TTurnImages;
  parentToolCallId: TOption<string>;
  signal: TOption<AbortSignal>;
  mcp?: { profile: TMcpProfile; tools: AgentTool[] };
  /** Dry runs must not reach MCP servers, whose tools can have side effects. */
  withoutMcp?: boolean;
};

export type TTurnImages = {
  refs: TAttachmentRef[];
  // undefined when the image is larger than maxBytes
  fetch: (ref: TAttachmentRef, maxBytes: number) => Promise<TOption<Uint8Array>>;
};

export type TAgentRunResult = {
  text: TOption<string>;
  iterations: number;
  toolCallCount: number;
  stopReason: string;
};

export type TMainAgentRunResult = TAgentRunResult & { messages: Message[] };
