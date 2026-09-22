import { createLogger } from "@bellaclaw/shared";
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
import { createMcpAuthFetch, getMcpAuthProvider, registerMcpAuthDisconnectListener } from "./auth";
import { getMcpProfile } from "./config";
import { discoverTools, requestOptions, type TMcpToolContext } from "./tools";
import type { TMcpOpenArgs, TMcpSession } from "./types";

export type { TMcpOpenArgs, TMcpSession } from "./types";

export class McpService {
  private static _instance: McpService;
  private logger = createLogger("MCP");
  private sessions = new Map<TMcpSession, { chatId: string; profileId: string }>();

  public static get instance() {
    if (McpService._instance === undefined) {
      McpService._instance = new McpService();
    }
    return McpService._instance;
  }

  public constructor() {
    registerMcpAuthDisconnectListener((chatId, profileId) => this.disconnect(chatId, profileId));
  }

  public async open(args: TMcpOpenArgs): Promise<TMcpSession> {
    const profile = await getMcpProfile(args.profileId);
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
    if (profile.sampling && args.sample !== undefined) {
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
    const context: TMcpToolContext = { client, profile, args, signal, updates: [] };
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      // A bounded session-local queue; callers can reread the listed resource URIs.
      if (context.updates.length === 100) {
        context.updates.shift();
      }
      context.updates.push(notification.params);
    });
    let transport: Transport;
    if (profile.transport.type === "stdio") {
      transport = new StdioClientTransport({
        command: profile.transport.command,
        args: profile.transport.args,
        env: profile.transport.env,
        stderr: "ignore",
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(profile.transport.url), {
        authProvider: await getMcpAuthProvider(args.chatId, profile),
        fetch: createMcpAuthFetch(args.chatId, profile.id),
        requestInit: { headers: profile.transport.headers },
      });
    }
    let closed = false;
    const session: TMcpSession = {
      profile,
      tools: [],
      signal,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        controller.abort(new Error("MCP session closed"));
        signal.removeEventListener("abort", abort);
        this.sessions.delete(session);
        await client.close();
      },
    };
    const abort = () => {
      void session.close().catch(() => this.logger.warning("Failed to close MCP session"));
    };
    client.onclose = () => {
      controller.abort(new Error("MCP server disconnected"));
      this.sessions.delete(session);
    };
    client.onerror = () => {
      if (!closed && !signal.aborted) {
        this.logger.warning(`MCP transport error for profile ${profile.id}`);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await client.connect(transport, {
        ...requestOptions(context),
        timeout: profile.requestTimeoutMs,
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
          .catch(() => this.logger.warning(`MCP tool refresh failed for profile ${profile.id}`));
      });
      signal.throwIfAborted();
      this.sessions.set(session, { chatId: args.chatId, profileId: profile.id });
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  public async disconnect(chatId: string, profileId: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [session, owner] of this.sessions) {
      if (owner.chatId === chatId && owner.profileId === profileId) {
        closing.push(session.close());
      }
    }
    await Promise.all(closing);
  }

  public async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((session) => session.close()));
  }
}
