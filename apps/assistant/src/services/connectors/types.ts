import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TConnector } from "./config";
import type { TMcpElicit, TMcpSample } from "./mcp/types";

// ownerKey: the owner of the credentials; conversationKey: the conversation the session serves
export type TConnectorOpenArgs = {
  ownerKey: string;
  conversationKey?: string;
  connectorId: string;
  turnId?: string;
  signal?: AbortSignal;
  sample?: TMcpSample;
  elicit?: TMcpElicit;
};

export type TConnectorSession = {
  connector: TConnector;
  tools: AgentTool[];
  signal: AbortSignal;
  close(): Promise<void>;
};

export type TConnectorAdapter = {
  open(connector: TConnector, args: TConnectorOpenArgs): Promise<TConnectorSession>;
};
