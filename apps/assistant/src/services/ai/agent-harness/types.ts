import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { TConnector } from "../../connectors/config";
import type { TConversation } from "../../conversation/types";
import type { TEventRequester } from "../../events";
import type { EMessagePlatform, TAttachmentRef } from "../../messaging/types";
import type { TConfigRecord } from "../../settings/schema";
import type { EAgentName } from "../agents";
import type { TLlmModelConfig } from "../llm";

export type TAgentRunArgs = {
  name: EAgentName;
  prompt: string;
  // the transcript, its lane and the model session
  conversationKey: TOption<string>;
  // whose settings, calendars, jobs and credentials the tools use
  ownerKey: TOption<string>;
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
  // instructions: what the server itself reported when the session opened
  connector?: { connector: TConnector; tools: AgentTool[]; instructions: TOption<string> };
  /** Dry runs must not reach connectors, whose tools can have side effects. */
  withoutConnectors?: boolean;
  /** The model the root agent runs on instead of the one its settings resolve to. */
  model?: TLlmModelConfig;
  /** The reply turn's tool calls as they start and end; delegated runs report none. */
  onStep?: (step: TAgentStep) => void;
};

// a tool call of the reply turn. stepId: the tool call id; tool: the tool's name; label: the
// tool's; detail: the argument a person recognises, such as a search's query, empty when none;
// startedAt: epoch ms; durationMs: once it ended
export type TAgentStep = {
  stepId: string;
  tool: string;
  label: string;
  detail: string;
  state: "started" | "completed" | "failed";
  startedAt: number;
  durationMs: TOption<number>;
};

export type TTurnImages = {
  refs: TAttachmentRef[];
  fetch: (ref: TAttachmentRef, maxBytes: number) => Promise<TOption<Uint8Array>>;
};

export type TAgentRunResult = {
  text: TOption<string>;
  iterations: number;
  toolCallCount: number;
  stopReason: string;
};

export type TMainAgentRunResult = TAgentRunResult & { messages: Message[] };
