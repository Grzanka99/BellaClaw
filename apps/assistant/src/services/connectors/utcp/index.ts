import { createLogger } from "@bellaclaw/shared";
import { HttpCommunicationProtocol } from "@utcp/http";
import {
  type CallTemplate,
  CommunicationProtocol,
  DefaultVariableSubstitutor,
  type Tool,
  ToolSchema,
  UtcpClient,
  type UtcpClientConfig,
  UtcpClientConfigSchema,
  type VariableSubstitutor,
} from "@utcp/sdk";
import { z } from "zod";
import type { TConnector } from "../config";
import {
  ConnectorAuthRequiredError,
  ConnectorUrlError,
  type TConnectorAdapter,
  type TConnectorSession,
} from "../types";
import { MAX_RESULT_BYTES, RESULT_TOO_LARGE, remoteTool } from "./tools";

const logger = createLogger("UTCP");

// the session's one manual
const MANUAL_NAME = "connector";
const MAX_MANUAL_BYTES = 1024 * 1024;
const HTTP_TEMPLATE_TYPES = ["http", "streamable_http", "sse"];
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const SManual = z.object({
  utcp_version: z.string().optional(),
  manual_version: z.string().optional(),
  tools: z.array(z.unknown()),
});
const STemplateTargets = z.object({
  call_template_type: z.string(),
  url: z.string(),
  auth: z.object({ token_url: z.string().optional() }).optional(),
});
const SHttpResponse = z.object({
  status: z.number(),
  headers: z.object({ location: z.string().optional() }),
  config: z.object({ url: z.string() }),
});
const SContentLengthError = z.object({ message: z.string().startsWith("maxContentLength") });

// resolves no variable from any source: a call template that names one fails, so nothing from the
// environment, a file or a setting reaches a request
class NoVariables implements VariableSubstitutor {
  private finder = new DefaultVariableSubstitutor();

  public async substitute<T>(obj: T, _config: UtcpClientConfig, namespace?: string): Promise<T> {
    const names = this.findRequiredVariables(obj, namespace);

    if (names.length > 0) {
      throw new Error(
        `This tool needs the variables ${names.join(", ")}, and UTCP connectors take no credentials or variables`,
      );
    }

    return obj;
  }

  public findRequiredVariables(obj: unknown, namespace?: string): string[] {
    return this.finder.findRequiredVariables(obj, namespace);
  }
}

// UtcpClient.create always resolves variables with DefaultVariableSubstitutor, which falls back to
// process.env; the protected constructor is the one way to give a client another substitutor. The
// HTTP plugin registers shared protocol instances, which the constructor takes, and no factories
class SealedUtcpClient extends UtcpClient {
  public constructor(config: UtcpClientConfig) {
    super(config, new NoVariables(), null);
  }
}

let httpGuarded = false;

// the SDK sends every http call template's request through one axios instance it keeps privately
// and shares process-wide; it follows a redirect to another origin after scrubbing credentials. The
// guard refuses such a redirect and bounds each response body
function guardHttpProtocol(): void {
  if (httpGuarded) {
    return;
  }

  const protocol = CommunicationProtocol.communicationProtocols.http;

  if (!(protocol instanceof HttpCommunicationProtocol)) {
    throw new Error("The UTCP HTTP protocol is not registered");
  }

  // biome-ignore lint/complexity/useLiteralKeys: a private field of the pinned SDK, the only hook
  const instance = protocol["_axiosInstance"];

  if (typeof instance?.interceptors?.response?.use !== "function") {
    throw new Error("The UTCP HTTP protocol has no request client to guard");
  }

  instance.defaults.maxContentLength = MAX_RESULT_BYTES;
  instance.interceptors.response.use(
    (response: unknown) => {
      const parsed = SHttpResponse.safeParse(response);

      if (!parsed.success) {
        throw new Error("Unexpected UTCP HTTP response");
      }

      const { status, headers, config } = parsed.data;

      if (status >= 300 && status < 400 && headers.location !== undefined) {
        const origin = new URL(config.url).origin;

        if (new URL(headers.location, config.url).origin !== origin) {
          throw new Error("The UTCP server redirected to another origin, which is not followed");
        }
      }

      return response;
    },
    (error: unknown) => {
      if (SContentLengthError.safeParse(error).success) {
        throw new Error(RESULT_TOO_LARGE);
      }

      throw error;
    },
  );
  httpGuarded = true;
}

async function fetchManual(connector: TConnector, url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal,
  });

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new ConnectorAuthRequiredError(
      `Connector ${connector.id} asks for credentials, and UTCP connectors take no credentials`,
    );
  }

  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error(`The UTCP manual request failed with HTTP ${response.status}`);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of response.body) {
    size += chunk.byteLength;

    // leaving the loop cancels the body
    if (size > MAX_MANUAL_BYTES) {
      throw new Error("The UTCP manual exceeds 1 MiB");
    }

    chunks.push(chunk);
  }

  const parsed = SManual.safeParse(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))));

  if (!parsed.success) {
    throw new Error("The server did not answer with a UTCP manual");
  }

  return parsed.data;
}

// the tools a session may run: an http-family call template whose requests stay on the manual's
// origin. Any other tool is left out with a warning, so the rest still work
function sessionTools(connector: TConnector, origin: string, rawTools: unknown[]): Tool[] {
  const tools: Tool[] = [];
  const names = new Set<string>();

  for (const raw of rawTools) {
    // a call template type no plugin registered (cli, text, file, mcp, ...) fails here
    const tool = ToolSchema.safeParse(raw);

    if (!tool.success) {
      logger.warning(`UTCP connector ${connector.id}: left out a tool the SDK cannot use`);
      continue;
    }

    const targets = STemplateTargets.safeParse(tool.data.tool_call_template);

    // every request a UTCP tool makes must go to the manual's origin (scheme, host, port): a tool
    // whose URL or OAuth token URL is elsewhere is left out, and the HTTP guard refuses a redirect
    // off it

    if (
      !targets.success ||
      !HTTP_TEMPLATE_TYPES.includes(targets.data.call_template_type) ||
      !URL.canParse(targets.data.url) ||
      new URL(targets.data.url).origin !== origin
    ) {
      logger.warning(`UTCP connector ${connector.id}: left out a tool`);
      continue;
    }

    const tokenUrl = targets.data.auth?.token_url;

    if (
      tokenUrl !== undefined &&
      (!URL.canParse(tokenUrl) || new URL(tokenUrl).origin !== origin)
    ) {
      logger.warning(`UTCP connector ${connector.id}: left out a tool`);
      continue;
    }

    if (names.has(tool.data.name)) {
      throw new Error("UTCP manual has a duplicate tool");
    }

    names.add(tool.data.name);
    tools.push({ ...tool.data, name: `${MANUAL_NAME}.${tool.data.name}` });
  }

  return tools;
}

export const utcpAdapter: TConnectorAdapter = {
  open: async (connector, args) => {
    if (connector.transport.type !== "http") {
      throw new Error(`UTCP connector ${connector.id} needs an http URL`);
    }

    const url = new URL(connector.transport.url);

    // the SDK sends a tool's request only over https, or http to a literal loopback host
    if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
      throw new ConnectorUrlError(`UTCP connector ${connector.id} needs an https URL`);
    }

    guardHttpProtocol();
    const controller = new AbortController();
    let signal = controller.signal;

    if (args.signal !== undefined) {
      signal = AbortSignal.any([signal, args.signal]);
    }

    signal.throwIfAborted();
    const manual = await fetchManual(
      connector,
      url.href,
      AbortSignal.any([signal, AbortSignal.timeout(connector.requestTimeoutMs)]),
    );
    const tools = sessionTools(connector, url.origin, manual.tools);
    const config = UtcpClientConfigSchema.safeParse({
      tool_repository: { tool_repository_type: "in_memory" },
    });

    if (!config.success) {
      throw new Error("Invalid UTCP client configuration");
    }

    const manualTemplate: CallTemplate = {
      name: MANUAL_NAME,
      call_template_type: "http",
      url: url.href,
      allowed_communication_protocols: HTTP_TEMPLATE_TYPES,
    };
    const client = new SealedUtcpClient(config.data);
    await client.config.tool_repository.saveManual(manualTemplate, {
      utcp_version: manual.utcp_version ?? "1.0.0",
      manual_version: manual.manual_version ?? "1.0.0",
      tools,
    });

    let closed = false;
    const session: TConnectorSession = {
      connector,
      tools: tools.map((tool) =>
        remoteTool({ client, connector, signal }, tool, tool.name.slice(MANUAL_NAME.length + 1)),
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
