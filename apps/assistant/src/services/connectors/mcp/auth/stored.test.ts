import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorsTable, EConnectorKind, EEventType } from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DatabaseConnector } from "../../../database";
import { resetEventTables } from "../../../database/test-utils";
import { EventBus } from "../../../events";
import { testEventRequester } from "../../../events/test-utils";
import { ConnectorService } from "../..";
import { createFixtureServer } from "../fixtures/server";
import { beginMcpAuth, getMcpAuthStatus, saveMcpAuthToken, setupMcpAuth } from ".";

const OWNER = "account:owner";
const ENV = [
  "BELLACLAW_CONNECTORS_CONFIG",
  "BELLACLAW_MCP_CREDENTIALS_PATH",
  "BELLACLAW_MCP_PUBLIC_URL",
] as const;

let directory: string;
let server: ReturnType<typeof Bun.serve>;
let authorizations: string[];
const previous: Record<string, TOption<string>> = {};

function reset() {
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(ConnectorService, { _instance: undefined });
}

// a connector command on the owner's lane, answered by connectors.changed
async function send<T extends EEventType>(
  type: T,
  payload: Parameters<typeof testEventRequester.request<T, EEventType.ConnectorsChanged>>[1],
) {
  await testEventRequester.request(type, payload, {
    outcome: EEventType.ConnectorsChanged,
    step: undefined,
    key: OWNER,
    timeoutMs: undefined,
  });
  await EventBus.instance.idle();
}

async function addApproved(id: string) {
  await send(EEventType.ConnectorAddRequested, {
    ownerKey: OWNER,
    id,
    kind: EConnectorKind.Mcp,
    url: `http://127.0.0.1:${server.port}/mcp`,
    description: "Private tools",
    plainChats: false,
  });
  await send(EEventType.ConnectorResolveRequested, { ownerKey: OWNER, id, decision: "approve" });
}

beforeEach(async () => {
  reset();
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-stored-credentials-"));
  for (const name of ENV) {
    previous[name] = Bun.env[name];
  }
  Bun.env.BELLACLAW_CONNECTORS_CONFIG = join(directory, "connectors.json");
  Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH = join(directory, "credentials.json");
  Bun.env.BELLACLAW_MCP_PUBLIC_URL = "https://bella.example.com";
  authorizations = [];
  // an MCP server that takes one bearer token, with OAuth metadata and client registration
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/register") {
        return Response.json({
          ...((await request.json()) as object),
          client_id: "registered-client",
        });
      }

      const authorization = request.headers.get("authorization") ?? "";
      authorizations.push(authorization);
      if (authorization !== "Bearer token-a") {
        return new Response("Unauthorized", { status: 401 });
      }
      const fixture = createFixtureServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await fixture.connect(transport);
      return transport.handleRequest(request);
    },
  });
  await resetEventTables();
  await DatabaseConnector.instance.database.delete(connectorsTable);
  ConnectorService.instance.setup();
  setupMcpAuth();
  await EventBus.instance.start();
});

afterEach(async () => {
  await EventBus.instance.idle();
  await EventBus.instance.stop();
  await ConnectorService.instance.close();
  await server.stop(true);
  await DatabaseConnector.instance.database.delete(connectorsTable);
  for (const name of ENV) {
    const value = previous[name];
    if (value === undefined) {
      delete Bun.env[name];
    } else {
      Bun.env[name] = value;
    }
  }
  await rm(directory, { recursive: true, force: true });
  reset();
});

test("an added connector without credentials names both commands; a saved token is sent", async () => {
  await addApproved("private");

  await expect(
    ConnectorService.instance.open({ ownerKey: OWNER, connectorId: "private" }),
  ).rejects.toThrow("Run !connector-auth token private TOKEN or !connector-auth connect private");

  await saveMcpAuthToken(OWNER, "private", "token-a");
  const session = await ConnectorService.instance.open({ ownerKey: OWNER, connectorId: "private" });

  expect(session.tools.length).toBeGreaterThan(0);
  expect(authorizations.at(-1)).toBe("Bearer token-a");
  expect(await getMcpAuthStatus(OWNER, "private")).toBe(true);
  await session.close();
});

test("connect on an added connector registers a client and gives a sign-in link", async () => {
  await addApproved("private");

  const link = new URL(await beginMcpAuth(OWNER, "private"));

  expect(link.origin + link.pathname).toBe(`http://127.0.0.1:${server.port}/authorize`);
  expect(link.searchParams.get("client_id")).toBe("registered-client");
  expect(link.searchParams.get("redirect_uri")).toBe(
    "https://bella.example.com/mcp/oauth/callback",
  );
});

test("approving the removal deletes the owner's credentials for the connector", async () => {
  await addApproved("private");
  await saveMcpAuthToken(OWNER, "private", "token-a");
  await send(EEventType.ConnectorRemoveRequested, { ownerKey: OWNER, id: "private" });
  await send(EEventType.ConnectorResolveRequested, {
    ownerKey: OWNER,
    id: "private",
    decision: "approve",
  });

  expect(JSON.parse(await readFile(join(directory, "credentials.json"), "utf8"))).toEqual({});
});
