import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  ElicitRequest,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { TMcpProfile } from "./config";

export type TMcpOpenArgs = {
  chatId: string;
  profileId: string;
  turnId?: string;
  signal?: AbortSignal;
  sample?: (
    params: CreateMessageRequest["params"],
    signal: AbortSignal,
  ) => Promise<CreateMessageResult | CreateMessageResultWithTools>;
  elicit?: (params: ElicitRequest["params"], signal: AbortSignal) => Promise<ElicitResult>;
};

export type TMcpSession = {
  profile: TMcpProfile;
  tools: AgentTool[];
  signal: AbortSignal;
  close(): Promise<void>;
};
