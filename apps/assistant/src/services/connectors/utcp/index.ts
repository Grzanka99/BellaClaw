import { createLogger } from "@bellaclaw/shared";
import "@utcp/http";
import { type CallTemplate, UtcpClient, UtcpClientConfigSchema } from "@utcp/sdk";
import { ConnectorUrlError, type TConnectorAdapter, type TConnectorSession } from "../types";
import { remoteTool } from "./tools";

const logger = createLogger("UTCP");

// the call template types @utcp/http registers
const HTTP_TEMPLATE_TYPES = ["http", "streamable_http", "sse"];
// LOOPBACK_HOSTNAMES of @utcp/http, which sends plain http only to these hosts
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export const utcpAdapter: TConnectorAdapter = {
  open: async (connector, args) => {
    if (connector.transport.type !== "http") {
      throw new Error(`UTCP connector ${connector.id} needs an http URL`);
    }

    const url = new URL(connector.transport.url);

    if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
      throw new ConnectorUrlError(
        `UTCP connector ${connector.id} cannot use this URL: the UTCP SDK allows only https, or http to localhost, 127.0.0.1 or ::1`,
      );
    }

    const controller = new AbortController();
    let signal = controller.signal;

    if (args.signal !== undefined) {
      signal = AbortSignal.any([signal, args.signal]);
    }

    signal.throwIfAborted();
    // the default repository is shared by every client in the process: each session gets its own
    const config = UtcpClientConfigSchema.safeParse({
      tool_repository: { tool_repository_type: "in_memory" },
    });

    if (!config.success) {
      throw new Error("Invalid UTCP client configuration");
    }

    const manualTemplate: CallTemplate = {
      name: connector.id,
      call_template_type: "http",
      url: url.href,
      allowed_communication_protocols: HTTP_TEMPLATE_TYPES,
    };
    const client = await UtcpClient.create(undefined, config.data);
    const registered = await client.registerManual(manualTemplate).catch(async (error) => {
      await client.close();
      throw error;
    });

    if (!registered.success) {
      await client.close();
      throw new Error(`UTCP manual registration failed: ${registered.errors.join(", ")}`);
    }

    // registerManual replaced the name's non-word characters; tool names are "<manual>.<tool>"
    const prefix = `${manualTemplate.name}.`;
    const tools = await client.getTools();

    // registerManual and getTools take no signal: an abort during them ends the open here
    signal.throwIfAborted();

    let closed = false;
    const session: TConnectorSession = {
      connector,
      tools: tools.map((tool) =>
        remoteTool({ client, connector, signal }, tool, tool.name.slice(prefix.length)),
      ),
      instructions: undefined,
      signal,
      close: async () => {
        if (closed) {
          return;
        }

        closed = true;
        controller.abort(new Error("UTCP session closed"));
        await client.close();
      },
    };
    signal.addEventListener(
      "abort",
      () => {
        void session.close().catch(() => logger.warning("Failed to close UTCP session"));
      },
      { once: true },
    );
    return session;
  },
};
