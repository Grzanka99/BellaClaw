import type { TOption } from "@bellaclaw/shared";
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

// instructions: what the server itself reports when the session opens
export type TConnectorSession = {
  connector: TConnector;
  tools: AgentTool[];
  instructions: TOption<string>;
  signal: AbortSignal;
  close(): Promise<void>;
};

export type TConnectorAdapter = {
  open(connector: TConnector, args: TConnectorOpenArgs): Promise<TConnectorSession>;
};

// a check of a server before it is stored: how many tools it offers, or that it wants credentials
export type TConnectorProbe = { status: "ready"; toolCount: number } | { status: "auth_required" };

// the server answered that the session needs credentials
export class ConnectorAuthRequiredError extends Error {}
