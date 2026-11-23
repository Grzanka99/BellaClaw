import { afterEach, describe, expect, test } from "bun:test";
import { EConnectorKind } from "@bellaclaw/database";
import { storedConnector } from "../config";
import type { TConnectorSession } from "../types";
import { utcpAdapter } from ".";
import { httpTool, startUtcpFixture } from "./fixtures/server";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function fixture(options: Parameters<typeof startUtcpFixture>[0]) {
  const server = startUtcpFixture(options);
  cleanups.push(server.stop);
  return server;
}

async function open(url: string): Promise<TConnectorSession> {
  const connector = storedConnector({
    id: "weather",
    kind: EConnectorKind.Utcp,
    url,
    description: "Weather tools",
    plainChats: false,
  });
  const session = await utcpAdapter.open(connector, {
    ownerKey: "account:owner",
    connectorId: "weather",
  });
  cleanups.push(() => session.close());
  return session;
}

function tool(session: TConnectorSession, label: string) {
  const found = session.tools.find((candidate) => candidate.label === label);
  if (found === undefined) {
    throw new Error(`No tool ${label}`);
  }
  return found;
}

describe("UTCP connector", () => {
  test("lists the manual's tools, and a call returns the endpoint's answer", async () => {
    const server = fixture({
      manual: (origin) => ({
        utcp_version: "1.0.0",
        tools: [httpTool("weather", `${origin}/weather`)],
      }),
    });
    const session = await open(server.url);

    expect(session.tools.map((candidate) => candidate.label)).toEqual(["weather"]);
    const result = await tool(session, "weather").execute("call", { city: "Paris" });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ city: "Paris", temperature: 21 }) },
    ]);
  });

  test("a streamable HTTP tool answering plain text returns that text", async () => {
    const server = fixture({
      manual: (origin) => ({
        utcp_version: "1.0.0",
        tools: [httpTool("summary", `${origin}/text`, { call_template_type: "streamable_http" })],
      }),
    });
    const session = await open(server.url);

    const result = await tool(session, "summary").execute("call", {});
    expect(result.content).toEqual([{ type: "text", text: "Sunny in Oslo" }]);
  });

  test("caps a tool's result at 1 MiB", async () => {
    const server = fixture({
      manual: (origin) => ({ utcp_version: "1.0.0", tools: [httpTool("big", `${origin}/big`)] }),
    });
    const session = await open(server.url);

    await expect(tool(session, "big").execute("call", {})).rejects.toThrow(
      "UTCP result exceeds 1 MiB",
    );
  });
});
