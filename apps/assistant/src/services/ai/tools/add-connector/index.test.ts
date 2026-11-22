import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorsTable, EConnectorKind, EConnectorStatus } from "@bellaclaw/database";
import type { TOption } from "@bellaclaw/shared";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ConnectorService } from "../../../connectors";
import { createFixtureServer } from "../../../connectors/mcp/fixtures/server";
import { httpTool, startUtcpFixture } from "../../../connectors/utcp/fixtures/server";
import { DatabaseConnector } from "../../../database";
import { resetEventTables } from "../../../database/test-utils";
import { EventBus } from "../../../events";
import { testEventRequester } from "../../../events/test-utils";
import { DefaultConfigRecord } from "../../../settings/schema";
import { addConnector } from ".";

const OWNER = "account:owner";

let directory: string;
let previousConfig: TOption<string>;

function reset() {
  Object.assign(EventBus, { _instance: undefined });
  Object.assign(ConnectorService, { _instance: undefined });
}

function execute(args: unknown) {
  return addConnector
    .createAgentTool({
      conversationKey: "discord:1",
      ownerKey: OWNER,
      settings: DefaultConfigRecord,
      trace: { turnId: "test", chatId: undefined, platform: undefined },
      events: testEventRequester,
      verifySettings: mock(async () => undefined),
      runScheduledTask: mock(async () => {
        throw new Error("not used");
      }),
    })
    .execute("call", args);
}

function storedRows() {
  return DatabaseConnector.instance.database
    .select({ id: connectorsTable.id, status: connectorsTable.status })
    .from(connectorsTable);
}

beforeEach(async () => {
  reset();
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-add-connector-"));
  previousConfig = Bun.env.BELLACLAW_CONNECTORS_CONFIG;
  Bun.env.BELLACLAW_CONNECTORS_CONFIG = join(directory, "connectors.json");
  await resetEventTables();
  await DatabaseConnector.instance.database.delete(connectorsTable);
  ConnectorService.instance.setup();
  await EventBus.instance.start();
});

afterEach(async () => {
  await EventBus.instance.idle();
  await EventBus.instance.stop();
  await DatabaseConnector.instance.database.delete(connectorsTable);
  if (previousConfig === undefined) {
    delete Bun.env.BELLACLAW_CONNECTORS_CONFIG;
  } else {
    Bun.env.BELLACLAW_CONNECTORS_CONFIG = previousConfig;
  }
  await rm(directory, { recursive: true, force: true });
  reset();
});

describe("add-connector", () => {
  test("stores a pending connector after checking the server, and reports its tool count", async () => {
    const fixture = createFixtureServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await fixture.connect(transport);
    const http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => transport.handleRequest(request),
    });

    try {
      const result = await execute({
        id: "fixture",
        kind: "mcp",
        url: `http://127.0.0.1:${http.port}/mcp`,
        description: "Fixture tools",
      });

      expect(result?.details).toEqual({
        id: "fixture",
        status: EConnectorStatus.PendingAdd,
        toolCount: 8,
        approvalCommand: "!connector approve fixture",
        rejectCommand: "!connector reject fixture",
      });
      expect(await storedRows()).toEqual([{ id: "fixture", status: EConnectorStatus.PendingAdd }]);
    } finally {
      await http.stop(true);
      await fixture.close();
    }
  });

  test("stores a pending connector when the server asks for authentication", async () => {
    const http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("Sign in at https://evil.example", { status: 401 }),
    });

    try {
      const result = await execute({
        id: "private",
        kind: "mcp",
        url: `http://127.0.0.1:${http.port}/mcp`,
        description: "Private tools",
      });

      expect(result?.details).toEqual({
        id: "private",
        status: EConnectorStatus.PendingAdd,
        authenticationRequired: true,
        approvalCommand: "!connector approve private",
        rejectCommand: "!connector reject private",
        tokenCommand: "!connector-auth token private TOKEN",
        connectCommand: "!connector-auth connect private",
      });
      expect(await storedRows()).toEqual([{ id: "private", status: EConnectorStatus.PendingAdd }]);
    } finally {
      await http.stop(true);
    }
  });

  test("stores nothing when the server cannot be reached", async () => {
    const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const url = `http://127.0.0.1:${http.port}/mcp`;
    await http.stop(true);

    const result = await execute({ id: "gone", kind: "mcp", url, description: "Gone tools" });

    expect(result).toMatchObject({
      isError: true,
      details: { errorCode: "connector-unreachable" },
      content: [
        { type: "text", text: `Could not connect to ${url} as an MCP server. Nothing was added` },
      ],
    });
    expect(await storedRows()).toEqual([]);
  });

  test("stores a pending UTCP connector after reading its manual, and reports its tool count", async () => {
    const server = startUtcpFixture({
      manual: (origin) => ({
        utcp_version: "1.0.0",
        tools: [
          httpTool("weather", `${origin}/weather`),
          httpTool("forecast", `${origin}/weather`),
        ],
      }),
    });

    try {
      const result = await execute({
        id: "weather",
        kind: "utcp",
        url: server.url,
        description: "Weather tools",
      });

      expect(result?.details).toEqual({
        id: "weather",
        status: EConnectorStatus.PendingAdd,
        toolCount: 2,
        approvalCommand: "!connector approve weather",
        rejectCommand: "!connector reject weather",
      });
      expect(
        await DatabaseConnector.instance.database
          .select({ id: connectorsTable.id, kind: connectorsTable.kind })
          .from(connectorsTable),
      ).toEqual([{ id: "weather", kind: EConnectorKind.Utcp }]);
    } finally {
      await server.stop();
    }
  });

  test("refuses a UTCP connector at a plain http URL to a non-loopback host", async () => {
    const result = await execute({
      id: "weather",
      kind: "utcp",
      url: "http://192.0.2.1/utcp",
      description: "Weather tools",
    });

    expect(result).toMatchObject({
      isError: true,
      details: { errorCode: "connector-url-unsupported" },
      content: [
        {
          type: "text",
          text: "UTCP connector weather cannot use this URL: the UTCP SDK allows only https, or http to localhost, 127.0.0.1 or ::1. Nothing was added",
        },
      ],
    });
    expect(await storedRows()).toEqual([]);
  });
});
