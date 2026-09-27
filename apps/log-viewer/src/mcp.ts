import type { LogReader, TLogReaderResult } from "@bellaclaw/behavior-logs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const SExcludeTurnId = z
  .string()
  .min(1)
  .optional()
  .describe("Turn ID of the diagnostic request to exclude from results");

export function createMcpRequestHandler(reader: LogReader) {
  return async (request: Request): Promise<Response> => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = createLogsMcpServer(reader);
    await server.connect(transport);

    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };
}

function createLogsMcpServer(reader: LogReader): McpServer {
  const server = new McpServer(
    { name: "bellaclaw-behavior-logs", version: "1.0.0" },
    {
      instructions:
        "Read-only diagnostics for BellaClaw behavior logs. Chat IDs accepted by tools are canonical, unmasked IDs. Use excludeTurnId for the turn performing the diagnosis.",
    },
  );

  server.registerTool(
    "recent_failures",
    {
      title: "Recent failures",
      description: "List failed behavior events from a recent time window.",
      inputSchema: {
        sinceMinutes: z.number().positive().default(60).describe("Minutes to look back"),
        limit: z.number().int().min(1).max(100).default(50),
        excludeTurnId: SExcludeTurnId,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMinutes, limit, excludeTurnId }) => {
      const result = await reader.readRecentFailures({
        sinceMs: Date.now() - sinceMinutes * 60 * 1000,
        limit,
        excludeTurnId,
      });
      return jsonToolResult(unwrap(result));
    },
  );

  server.registerTool(
    "latest_turn_latency",
    {
      title: "Latest turn latency",
      description:
        "Show wall-clock latency and the overlapping event timeline for the latest completed conversational turn in a chat.",
      inputSchema: {
        chatId: z.string().min(1).describe("Canonical chat ID, before behavior-log masking"),
        excludeTurnId: SExcludeTurnId,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chatId, excludeTurnId }) => {
      const result = await reader.readLatestTurnLatency({ chatId, excludeTurnId });
      return jsonToolResult(unwrap(result));
    },
  );

  server.registerTool(
    "cache_hit_rate",
    {
      title: "Cache hit rate",
      description:
        "Aggregate prompt-cache usage across all model calls in the last ten completed conversational turns for a chat.",
      inputSchema: {
        chatId: z.string().min(1).describe("Canonical chat ID, before behavior-log masking"),
        excludeTurnId: SExcludeTurnId,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chatId, excludeTurnId }) => {
      const result = await reader.readCacheHitRate({ chatId, excludeTurnId });
      return jsonToolResult(unwrap(result));
    },
  );

  server.registerResource(
    "behavior-log-schema",
    "logs://schema",
    {
      title: "Behavior log schema",
      description: "Fields and turn-boundary semantics used by the diagnostic tools.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              eventFields: [
                "id",
                "createdAt",
                "createdAtMs",
                "level",
                "event",
                "turnId",
                "chatId",
                "platform",
                "component",
                "provider",
                "model",
                "purpose",
                "toolName",
                "success",
                "durationMs",
                "summary",
                "metadata",
                "error",
              ],
              conversationalTurn: {
                startsWith: { event: "message.received", component: "messaging" },
                completesWith: { event: "handler.completed", component: "messaging" },
              },
              cacheUsage:
                "model.request.completed metadata contains cacheRead and inputTokens; the aggregate rate is 100 * sum(cacheRead) / sum(inputTokens)",
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "behavior-log-turn",
    new ResourceTemplate("logs://turn/{turnId}", { list: undefined }),
    {
      title: "Behavior log turn",
      description: "All events for one turn in chronological order.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const turnId = variables.turnId;

      if (typeof turnId !== "string") {
        throw new Error("A single turnId is required");
      }

      const result = await reader.readTurn(turnId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(unwrap(result), null, 2),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "diagnose-turn",
    {
      title: "Diagnose a behavior-log turn",
      description: "Investigate one turn using its timeline, failures, and chat-level metrics.",
      argsSchema: {
        turnId: z.string().min(1),
        chatId: z.string().min(1).describe("Canonical chat ID"),
        excludeTurnId: SExcludeTurnId,
      },
    },
    ({ turnId, chatId, excludeTurnId }) => {
      let exclusionInstruction =
        "If this diagnosis is itself logged, pass its turn ID as excludeTurnId to every tool.";

      if (excludeTurnId !== undefined) {
        exclusionInstruction = `Pass excludeTurnId=${excludeTurnId} to every tool.`;
      }

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Diagnose BellaClaw turn ${turnId} for canonical chat ${chatId}. Read logs://turn/${encodeURIComponent(turnId)} and logs://schema. Call recent_failures, latest_turn_latency, and cache_hit_rate. ${exclusionInstruction} Explain the likely cause using event timestamps and durations; treat overlapping work as wall-clock overlap rather than summing durations.`,
            },
          },
        ],
      };
    },
  );

  return server;
}

function unwrap<T>(result: TLogReaderResult<T>): T {
  if (!result.success) {
    throw new Error(`${result.error.message}: ${result.error.detail}`);
  }

  return result.data;
}

function jsonToolResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
