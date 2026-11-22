import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { Tool, UtcpClient } from "@utcp/sdk";
import { z } from "zod";
import type { TConnector } from "../config";

const MAX_RESULT_BYTES = 1024 * 1024;
const RESULT_TOO_LARGE = "UTCP result exceeds 1 MiB. Request a smaller page or a narrower query.";

const SObjectArguments = z.record(z.string(), z.unknown());

export type TUtcpToolContext = {
  client: UtcpClient;
  connector: TConnector;
  signal: AbortSignal;
};

// tool: registered in the session's client under its full name; remoteName: the manual's own name
export function remoteTool(context: TUtcpToolContext, tool: Tool, remoteName: string): AgentTool {
  // Stable provider-safe names; the original name stays in the client.
  const suffix = new Bun.CryptoHasher("sha256").update(remoteName).digest("hex").slice(0, 10);
  const name = `utcp_${remoteName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 45)}_${suffix}`;
  return {
    name,
    label: remoteName,
    description: tool.description || remoteName,
    parameters: { type: "object", properties: {}, ...tool.inputs },
    executionMode: "sequential",
    execute: async (_id, args: unknown, signal) => {
      const parsed = SObjectArguments.safeParse(args);
      if (!parsed.success) {
        throw new Error("UTCP tool arguments must be a structured object");
      }
      if (!compile(tool.inputs, { formats, unresolvedRefs: "reject" }).check(parsed.data)) {
        throw new Error(`Invalid arguments for UTCP tool ${remoteName}`);
      }
      const signals = [context.signal, AbortSignal.timeout(context.connector.requestTimeoutMs)];
      if (signal !== undefined) {
        signals.push(signal);
      }
      let result: unknown;
      try {
        result = await untilAborted(
          context.client.callTool(tool.name, parsed.data),
          AbortSignal.any(signals),
        );
      } catch (error) {
        let message = String(error);
        if (error instanceof Error) {
          message = error.message;
        }
        throw new Error(`UTCP tool ${remoteName} failed: ${message}`);
      }
      return utcpResult(result);
    },
  };
}

// the SDK's call takes no signal: an abort answers at once, and the request ends at the SDK's own
// timeout
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function utcpResult(result: unknown): AgentToolResult<undefined> {
  let text = "";
  // a streamable_http response that is neither JSON nor NDJSON comes back as raw bytes
  if (result instanceof Uint8Array) {
    text = new TextDecoder().decode(result);
  } else if (typeof result === "string") {
    text = result;
  } else if (result !== undefined && result !== null) {
    text = JSON.stringify(result);
  }
  if (new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES) {
    throw new Error(RESULT_TOO_LARGE);
  }
  if (text.length === 0) {
    text = "UTCP operation completed with no content.";
  }
  return { content: [{ type: "text", text }], details: undefined };
}
