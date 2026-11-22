import type {
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  ElicitRequest,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

// Sampling and elicitation hooks the harness passes when it opens a connector session

export type TMcpSampleParams = CreateMessageRequest["params"];

export type TMcpSampleResult = CreateMessageResult | CreateMessageResultWithTools;

export type TMcpSample = (
  params: TMcpSampleParams,
  signal: AbortSignal,
) => Promise<TMcpSampleResult>;

export type TMcpElicitParams = ElicitRequest["params"];

export type TMcpElicitResult = ElicitResult;

export type TMcpElicit = (
  params: TMcpElicitParams,
  signal: AbortSignal,
) => Promise<TMcpElicitResult>;
