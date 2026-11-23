import { createLogger, type TOption } from "@bellaclaw/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { TConnectorAdapter, TConnectorSession } from "../types";
import { createMcpAuthFetch, getMcpAuthProvider, getMcpAuthToken } from "./auth";
import { discoverTools, requestOptions, type TMcpToolContext } from "./tools";

const logger = createLogger("MCP");

export const mcpAdapter: TConnectorAdapter = {
  open: async (connector, args) => {
    const controller = new AbortController();
    let signal = controller.signal;
    if (args.signal !== undefined) {
      signal = AbortSignal.any([signal, args.signal]);
    }
    signal.throwIfAborted();
    const client = new Client(
      { name: "bellaclaw", version: "1.0.0" },
      { capabilities: { elicitation: { form: {}, url: {} } } },
    );
    if (connector.sampling && args.sample !== undefined) {
      client.registerCapabilities({ sampling: { tools: {} } });
      client.setRequestHandler(CreateMessageRequestSchema, (request, extra) => {
        if (args.sample === undefined) {
          throw new Error("Sampling is unavailable in this session");
        }
        return args.sample(request.params, AbortSignal.any([signal, extra.signal]));
      });
    }
    client.setRequestHandler(ElicitRequestSchema, (request, extra) => {
      if (args.elicit === undefined) {
        return { action: "decline" };
      }
      return args.elicit(request.params, AbortSignal.any([signal, extra.signal]));
    });
    const context: TMcpToolContext = { client, connector, args, signal, updates: [] };
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      // A bounded session-local queue; callers can reread the listed resource URIs.
      if (context.updates.length === 100) {
        context.updates.shift();
      }
      context.updates.push(notification.params);
    });
    let transport: Transport;
    if (connector.transport.type === "stdio") {
      transport = new StdioClientTransport({
        command: connector.transport.command,
        args: connector.transport.args,
        env: connector.transport.env,
        stderr: "ignore",
      });
    } else {
      const headers = new Headers(connector.transport.headers);
      const token = await getMcpAuthToken(args.ownerKey, connector);
      if (token !== undefined) {
        headers.set("Authorization", `Bearer ${token}`);
      }
      transport = new StreamableHTTPClientTransport(new URL(connector.transport.url), {
        authProvider: await getMcpAuthProvider(args.ownerKey, connector),
        fetch: createMcpAuthFetch(args.ownerKey, connector.id),
        requestInit: { headers },
      });
    }
    let closed = false;
    const session: TConnectorSession = {
      connector,
      tools: [],
      signal,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        controller.abort(new Error("MCP session closed"));
        signal.removeEventListener("abort", abort);
        try {
          if (transport instanceof StreamableHTTPClientTransport) {
            let timeout: TOption<ReturnType<typeof setTimeout>>;
            try {
              await Promise.race([
                transport.terminateSession(),
                new Promise<void>((_, reject) => {
                  timeout = setTimeout(
                    () => reject(new Error("MCP session termination timed out")),
                    Math.min(connector.requestTimeoutMs, 5_000),
                  );
                }),
              ]);
            } finally {
              if (timeout !== undefined) {
                clearTimeout(timeout);
              }
            }
          }
        } catch {
          logger.warning(`Failed to terminate MCP session for connector ${connector.id}`);
        } finally {
          await client.close();
        }
      },
    };
    const abort = () => {
      void session.close().catch(() => logger.warning("Failed to close MCP session"));
    };
    client.onclose = () => {
      controller.abort(new Error("MCP server disconnected"));
    };
    client.onerror = () => {
      if (!closed && !signal.aborted) {
        logger.warning(`MCP transport error for connector ${connector.id}`);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await client.connect(transport, {
        ...requestOptions(context),
        timeout: connector.requestTimeoutMs,
      });
      session.tools.push(...(await discoverTools(context)));
      let refreshing = Promise.resolve();
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        refreshing = refreshing
          .then(async () => {
            const tools = await discoverTools(context);
            if (!closed) {
              session.tools.splice(0, session.tools.length, ...tools);
            }
          })
          .catch(() => logger.warning(`MCP tool refresh failed for connector ${connector.id}`));
      });
      signal.throwIfAborted();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  },
};
